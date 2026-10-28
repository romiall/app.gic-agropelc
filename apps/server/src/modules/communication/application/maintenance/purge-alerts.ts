/**
 * Purge des alertes closes (P9-25, PF-1 ; ADR-068 §8, AV-387, AV-470 ; 03-historisation-suppression.md §4) :
 * les alertes `RESOLVED` ou `DISMISSED` depuis plus de `communication.alert_retention_days` jours (730) partent
 * avec leurs destinataires (cascade) ; `communication_notifications.alert_id` passe à `NULL` (la notification
 * orpheline est ensuite purgée par `purge.ts`).
 *
 * - **Rôle** : `gic_app` n'a pas `DELETE` sur `communication_alerts` (une alerte est une trace immuable). La
 *   purge s'exécute donc sous un **rôle de maintenance** (`SELECT, DELETE` sur `communication_alerts` ; `SELECT`
 *   sur `organization_system_settings`), par le script d'exploitation `pnpm run db:purge-alerts`
 *   (`scripts/purge-alerts.ts`) sur la connexion `MAINTENANCE_DATABASE_URL`, jamais lue par l'API ni par le
 *   worker. La tâche quotidienne du worker se borne à **compter** les alertes en attente (`countPurgeableAlerts`).
 * - **Plancher** : le déclencheur `trg_communication_alerts_purge_guard` (migration 20261201090100) refuse tout
 *   `DELETE` d'une alerte close depuis moins de 730 jours ; le réglage ne peut qu'allonger cette durée. Le
 *   prédicat applique aussi ce plancher **d'avance, sur l'horloge de la base** : MySQL évalue `UTC_TIMESTAMP(6)`
 *   une fois par instruction, déclencheur compris, donc une horloge applicative en avance ne fait jamais lever le
 *   déclencheur (une instruction multi-lignes serait sinon annulée en entier).
 * - **Lots** : 500 alertes par instruction, chaque lot validé séparément quand on passe la base (et non une
 *   transaction) ; plafond de lots par exécution, le reste est repris à l'exécution suivante.
 */
import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import {
  ALERT_RETENTION_FLOOR_DAYS,
  SystemClock,
  alertRetentionDaysOrDefault,
  retentionCutoff,
  type Clock,
} from '@gic/domain';
import { createDatabase, type DB } from '../../../../platform/kysely/database.js';
import { deleteByBatches } from '../../../../platform/purge-batches.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const ALERT_RETENTION_KEY = 'communication.alert_retention_days';
const ALERT_PURGE_BATCH = 500;
const ALERT_PURGE_MAX_BATCHES = 1_000;

export interface AlertPurgeWindow {
  readonly retentionDays: number;
  /** Vrai si le réglage demandait moins que le plancher du déclencheur (730 jours) : le plancher s'applique. */
  readonly floorApplied: boolean;
  /** Une alerte close strictement avant cet instant est purgeable. */
  readonly before: Date;
}

export interface AlertPurgeOutcome extends AlertPurgeWindow {
  readonly deleted: number;
  readonly truncated: boolean;
}

/** Durée en vigueur à `now` (réglage global, plancher de 730 jours) et instant de coupure correspondant. */
export async function alertPurgeWindow(executor: Executor, now: Date): Promise<AlertPurgeWindow> {
  const value = await currentSettingValue(executor, {
    key: ALERT_RETENTION_KEY,
    scopeType: 'GLOBAL',
    scopeId: null,
    at: now,
  });
  const retentionDays = alertRetentionDaysOrDefault(value);
  return {
    retentionDays,
    floorApplied: typeof value === 'number' && value < ALERT_RETENTION_FLOOR_DAYS,
    before: retentionCutoff(now, retentionDays),
  };
}

/** Alertes closes plus anciennes que `before` **et** que le plancher du déclencheur, mesuré sur l'horloge de la base. */
function purgeable(eb: ExpressionBuilder<DB, 'communication_alerts'>, before: Date) {
  return eb.and([
    eb('status', 'in', ['RESOLVED', 'DISMISSED']),
    eb('resolved_at', '<', before),
    eb(
      'resolved_at',
      '<',
      sql<Date>`DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ${sql.lit(ALERT_RETENTION_FLOOR_DAYS)} DAY)`,
    ),
  ]);
}

/**
 * Supprime les alertes closes périmées, par lots de 500. Passer le `Database` (et non une transaction) valide
 * chaque lot séparément ; les destinataires partent en cascade et `notifications.alert_id` passe à `NULL`.
 */
export async function purgeClosedAlerts(
  executor: Executor,
  deps: { readonly clock: Clock },
  options: { readonly batch?: number; readonly maxBatches?: number } = {},
): Promise<AlertPurgeOutcome> {
  const window = await alertPurgeWindow(executor, deps.clock.now());
  const result = await deleteByBatches(
    async (limit) =>
      Number(
        (
          await executor
            .deleteFrom('communication_alerts')
            .where((eb) => purgeable(eb, window.before))
            .limit(limit)
            .executeTakeFirst()
        ).numDeletedRows,
      ),
    {
      batch: options.batch ?? ALERT_PURGE_BATCH,
      maxBatches: options.maxBatches ?? ALERT_PURGE_MAX_BATCHES,
    },
  );
  return { ...window, ...result };
}

/** Nombre d'alertes closes périmées en attente de purge (simple `SELECT` : le rôle applicatif suffit). */
export async function countPurgeableAlerts(
  executor: Executor,
  deps: { readonly clock: Clock },
): Promise<number> {
  const window = await alertPurgeWindow(executor, deps.clock.now());
  const row = await executor
    .selectFrom('communication_alerts')
    .select((eb) => eb.fn.countAll<string | number>().as('count'))
    .where((eb) => purgeable(eb, window.before))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Commande d'exploitation `pnpm run db:purge-alerts [-- --dry-run]` : logique d'arguments, d'environnement, de
// sortie et de code de retour ici (typée et compilée avec le serveur) ; `scripts/purge-alerts.ts` n'est qu'un appel.
// ---------------------------------------------------------------------------------------------------------------

export const MAINTENANCE_URL_VARIABLE = 'MAINTENANCE_DATABASE_URL';

export interface AlertPurgeCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface AlertPurgeCliDeps {
  readonly clock?: Clock;
  /** Ouverture de la connexion de maintenance (essais) ; défaut : `createDatabase` et fermeture du pool. */
  readonly open?: (url: string) => { readonly db: Executor; readonly close: () => Promise<void> };
}

function openMaintenanceDatabase(url: string): {
  readonly db: Executor;
  readonly close: () => Promise<void>;
} {
  const { db, pool } = createDatabase(url);
  return {
    db,
    // L'API à rappel de mysql2 : `end` ne rend pas de promesse, on attend son rappel.
    close: () =>
      new Promise<void>((resolve, reject) => {
        pool.end((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * Exécute la commande et rend le code de sortie : 0 (purge faite ou comptage), 2 (usage ou environnement),
 * 1 (erreur d'exécution). Jamais de repli sur `SERVER_DATABASE_URL` : la purge exige le rôle de maintenance.
 * Ne journalise ni l'URL ni un identifiant.
 */
export async function runAlertPurgeCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: AlertPurgeCliIo,
  deps: AlertPurgeCliDeps = {},
): Promise<number> {
  const rest = args.filter((arg) => arg !== '--');
  if (rest.some((arg) => arg !== '--dry-run')) {
    io.err('Usage : pnpm run db:purge-alerts [-- --dry-run]');
    return 2;
  }
  const dryRun = rest.length > 0;
  const url = env[MAINTENANCE_URL_VARIABLE];
  if (!url) {
    io.err(`${MAINTENANCE_URL_VARIABLE} non défini (rôle de maintenance, db/README.md §1).`);
    return 2;
  }
  const clock = deps.clock ?? new SystemClock();
  const connection = (deps.open ?? openMaintenanceDatabase)(url);
  try {
    if (dryRun) {
      const window = await alertPurgeWindow(connection.db, clock.now());
      const count = await countPurgeableAlerts(connection.db, { clock });
      io.out(
        `${count} alerte(s) close(s) à purger avant ${window.before.toISOString()} ` +
          `(conservation ${window.retentionDays} j) ; essai à blanc, rien n'est supprimé.`,
      );
      return 0;
    }
    const outcome = await purgeClosedAlerts(connection.db, { clock });
    io.out(
      `${outcome.deleted} alerte(s) close(s) supprimée(s) avant ${outcome.before.toISOString()} ` +
        `(conservation ${outcome.retentionDays} j, plancher ${ALERT_RETENTION_FLOOR_DAYS} j` +
        `${outcome.floorApplied ? ', appliqué' : ''})` +
        (outcome.truncated ? ' ; reste à purger : relancer la commande.' : '.'),
    );
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await connection.close();
  }
}

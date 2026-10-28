/**
 * Purges techniques de la communication (P9-25, PF-1 et PF-7 ; ADR-068 §8, 03-historisation-suppression.md §3 ;
 * AV-470, AV-471, AV-472) : tâche quotidienne `communication.maintenance.purge_daily` (voie courte, 03:30).
 *
 * - **Notifications** (`PURGE_TECHNIQUE`) : celles lues depuis plus de `communication.notification_retention_days`
 *   jours (90) ; les lignes d'envoi `WEB_PUSH` créées depuis plus de cette durée, lues ou non (une ligne d'envoi
 *   que l'écran ne liste pas par défaut ne serait sinon jamais « lue ») ; les notifications `ALERT` dont l'alerte
 *   a été purgée (`alert_id` à `NULL`), lues ou non : leur texte stocké garde la valeur au coût d'alors, que
 *   `notificationBodies` ne peut plus re-rendre selon le droit courant faute d'alerte (RC-05, NT-1). **Jamais** la
 *   notification d'une note encore publiée : c'est la seule trace de qui détient la note (`noteHolderIds`, jeu
 *   hors ligne `comms`), sa suppression ferait perdre le retrait hors ligne à l'archivage. Les `IN_APP` jamais
 *   lues d'une alerte encore présente restent (AV-471, choix (a)).
 * - **Abonnements push révoqués** : supprimés (ADR-068 §8 : « à la révocation »).
 * - **Tâches terminées et événements sautés** de la plateforme (PF-7) : deux fonctions de `platform/`, appelées ici
 *   (la communication, premier producteur de tâches et lecteur des sauts, orchestre ; la plateforme possède le SQL).
 * - **Alertes closes** : `gic_app` n'a pas `DELETE` sur `communication_alerts` ; elles sont purgées par le script
 *   d'exploitation `db:purge-alerts` sous un rôle de maintenance (`purge-alerts.ts`, AV-470). La tâche ne fait que
 *   les compter, pour que le journal signale une purge non planifiée.
 *
 * **Une seule transaction** : le `JobRunner` exécute le gestionnaire dans une transaction unique. Les lots sont donc
 * plafonnés (le reste attend le lendemain) et chaque étape est isolée par un point de sauvegarde : une étape en
 * échec n'annule ni ne prive les autres, et ne fait pas lever le gestionnaire (le `JobRunner` annulerait sinon
 * aussi les suppressions réussies). Seul un interblocage (1213) annule toute la transaction et remonte.
 */
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import {
  DEFAULT_CONSUMER_FAILURE_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_RETENTION_DAYS,
  DEFAULT_PLATFORM_JOB_RETENTION_DAYS,
  consumerFailurePurgeCutoff,
  consumerFailureWindowHoursOrDefault,
  retentionCutoff,
  retentionDaysOrDefault,
  type Clock,
} from '@gic/domain';
import { purgeConsumerFailures } from '../../../../platform/events/consumer-failure-purge.js';
import { purgeTerminatedJobs } from '../../../../platform/jobs/job-purge.js';
import {
  deleteBatchByKeys,
  deleteByBatches,
  type BatchPurgeResult,
} from '../../../../platform/purge-batches.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { CONSUMER_WINDOW_SETTING_KEY } from '../jobs/consumer-failure-job.js';
import { countPurgeableAlerts } from './purge-alerts.js';

export const NOTIFICATION_RETENTION_KEY = 'communication.notification_retention_days';
export const JOB_RETENTION_KEY = 'platform.job_retention_days';
export const CONSUMER_FAILURE_RETENTION_KEY = 'platform.consumer_failure_retention_days';

const logger = new Logger('communication.purge');

const NOTIFICATION_BATCH = 2_000;
const SUBSCRIPTION_BATCH = 500;
/** Lots supprimés au plus par étape et par exécution : borne la durée de la transaction unique de la tâche. */
const MAX_BATCHES = 10;
const EMPTY: BatchPurgeResult = { deleted: 0, truncated: false };

export interface CommunicationPurgeOutcome {
  readonly notificationsDeleted: number;
  readonly pushSubscriptionsDeleted: number;
  readonly jobsDeleted: number;
  readonly consumerFailuresDeleted: number;
  /** Alertes closes au-delà de leur conservation, en attente du script d'exploitation `db:purge-alerts`. */
  readonly alertsAwaitingPurge: number;
  /** Étapes dont le plafond de lots est atteint : le reste est repris à l'exécution suivante. */
  readonly truncated: readonly string[];
  /** Étapes en échec (consignées) : les autres ont tout de même abouti. */
  readonly failedSteps: readonly string[];
}

/**
 * Notifications périmées (AV-471) : lues avant `before`, lignes d'envoi `WEB_PUSH` créées avant `before`, ou
 * notifications `ALERT` d'une alerte déjà purgée — hors notification d'une note encore publiée. Comparaisons
 * strictes : lue depuis exactement la durée = conservée.
 *
 * Deux temps (`deleteBatchByKeys`) : aucun index ne sert `read_at`, donc un `DELETE ... WHERE read_at < ? LIMIT n`
 * verrouillerait, sous `REPEATABLE READ`, toutes les lignes parcourues, fin de table comprise, là où le consommateur
 * insère. La lecture des identifiants est sans verrou et la suppression par clé primaire ne verrouille que les
 * lignes supprimées. Un curseur (`id` > dernier identifiant lu) évite de reparcourir, lot après lot, les lignes
 * jamais éligibles en tête de table. `read_at`, `channel`, `created_at`, `note_id` et `alert_id` ne reviennent pas
 * en arrière (déclencheur, une note ne revient pas à `PUBLISHED`) : le second temps ne rejoue pas le prédicat.
 */
export async function purgeReadNotifications(
  uow: UnitOfWork,
  input: { readonly before: Date; readonly batch?: number; readonly maxBatches?: number },
): Promise<BatchPurgeResult> {
  let after: Buffer | null = null;
  return deleteByBatches(
    (limit) =>
      deleteBatchByKeys(
        limit,
        async (size) => {
          const cursor = after;
          const rows = await uow
            .selectFrom('communication_notifications')
            .select('id')
            .where((eb) =>
              eb.and([
                eb.or([
                  eb('read_at', '<', input.before),
                  eb.and([eb('channel', '=', 'WEB_PUSH'), eb('created_at', '<', input.before)]),
                  eb.and([eb('kind', '=', 'ALERT'), eb('alert_id', 'is', null)]),
                ]),
                eb.or([
                  eb('note_id', 'is', null),
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom('communication_internal_notes as note')
                        .select('note.id')
                        .whereRef('note.id', '=', 'communication_notifications.note_id')
                        .where('note.status', '=', 'PUBLISHED'),
                    ),
                  ),
                ]),
              ]),
            )
            .$if(cursor !== null, (qb) => qb.where('id', '>', cursor as Buffer))
            .orderBy('id')
            .limit(size)
            .execute();
          const ids = rows.map((row) => row.id);
          if (ids.length > 0) after = ids[ids.length - 1]!;
          return ids;
        },
        async (ids) =>
          Number(
            (
              await uow
                .deleteFrom('communication_notifications')
                .where('id', 'in', [...ids])
                .executeTakeFirst()
            ).numDeletedRows,
          ),
      ),
    { batch: input.batch ?? NOTIFICATION_BATCH, maxBatches: input.maxBatches ?? MAX_BATCHES },
  );
}

/**
 * Abonnements push révoqués (par `GONE` du service ou par désabonnement) : supprimés, sans réglage. Même motif en
 * deux temps que les notifications : aucun index ne sert `revoked_at` seul (l'index est `(user_id, revoked_at)`), un
 * `DELETE` direct verrouillerait tous les abonnements parcourus, actifs compris, et bloquerait un abonnement
 * concurrent (`communication.push.subscribe`).
 */
export async function purgeRevokedPushSubscriptions(
  uow: UnitOfWork,
  input: { readonly batch?: number; readonly maxBatches?: number } = {},
): Promise<BatchPurgeResult> {
  return deleteByBatches(
    (limit) =>
      deleteBatchByKeys(
        limit,
        async (size) => {
          const rows = await uow
            .selectFrom('communication_push_subscriptions')
            .select('id')
            .where('revoked_at', 'is not', null)
            .limit(size)
            .execute();
          return rows.map((row) => row.id);
        },
        async (ids) =>
          Number(
            (
              await uow
                .deleteFrom('communication_push_subscriptions')
                .where('id', 'in', [...ids])
                .where('revoked_at', 'is not', null)
                .executeTakeFirst()
            ).numDeletedRows,
          ),
      ),
    { batch: input.batch ?? SUBSCRIPTION_BATCH, maxBatches: input.maxBatches ?? MAX_BATCHES },
  );
}

function errnoOf(error: unknown): number | undefined {
  return (error as { errno?: number } | null)?.errno;
}

/**
 * Isole une étape par un point de sauvegarde (idiome de `alert-escalation.ts`). Sur une erreur : un interblocage
 * (1213, victime) annule toute la transaction et remonte ; toute autre — dont un délai d'attente de verrou (1205),
 * qui n'annule par défaut que l'instruction — voit l'étape annulée, consignée et remplacée par `fallback`. Si le
 * retour au point de sauvegarde lève lui-même (transaction perdue : `innodb_rollback_on_timeout`), l'erreur
 * d'origine remonte.
 */
async function guardedStep<T>(
  uow: UnitOfWork,
  name: string,
  failed: string[],
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const savepoint = sql.id(`purge_${name}`);
  await sql`SAVEPOINT ${savepoint}`.execute(uow);
  try {
    const result = await run();
    await sql`RELEASE SAVEPOINT ${savepoint}`.execute(uow);
    return result;
  } catch (error) {
    if (errnoOf(error) === 1213) throw error;
    try {
      await sql`ROLLBACK TO SAVEPOINT ${savepoint}`.execute(uow);
      await sql`RELEASE SAVEPOINT ${savepoint}`.execute(uow);
    } catch {
      throw error;
    }
    logger.error(
      `Étape de purge « ${name} » en échec : ${error instanceof Error ? error.message : String(error)}`,
    );
    failed.push(name);
    return fallback;
  }
}

async function setting(uow: UnitOfWork, key: string, at: Date): Promise<unknown> {
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

export async function runCommunicationPurge(
  uow: UnitOfWork,
  deps: { readonly clock: Clock },
): Promise<CommunicationPurgeOutcome> {
  const now = deps.clock.now();
  const notificationDays = retentionDaysOrDefault(
    await setting(uow, NOTIFICATION_RETENTION_KEY, now),
    DEFAULT_NOTIFICATION_RETENTION_DAYS,
  );
  const jobDays = retentionDaysOrDefault(
    await setting(uow, JOB_RETENTION_KEY, now),
    DEFAULT_PLATFORM_JOB_RETENTION_DAYS,
  );
  const failureDays = retentionDaysOrDefault(
    await setting(uow, CONSUMER_FAILURE_RETENTION_KEY, now),
    DEFAULT_CONSUMER_FAILURE_RETENTION_DAYS,
  );
  const windowHours = consumerFailureWindowHoursOrDefault(
    await setting(uow, CONSUMER_WINDOW_SETTING_KEY, now),
  );

  const failed: string[] = [];
  const notifications = await guardedStep(
    uow,
    'notifications',
    failed,
    () => purgeReadNotifications(uow, { before: retentionCutoff(now, notificationDays) }),
    EMPTY,
  );
  const subscriptions = await guardedStep(
    uow,
    'push_subscriptions',
    failed,
    () => purgeRevokedPushSubscriptions(uow),
    EMPTY,
  );
  const jobs = await guardedStep(
    uow,
    'jobs',
    failed,
    () => purgeTerminatedJobs(uow, { before: retentionCutoff(now, jobDays) }),
    EMPTY,
  );
  const consumerFailures = await guardedStep(
    uow,
    'consumer_failures',
    failed,
    () =>
      purgeConsumerFailures(uow, {
        before: consumerFailurePurgeCutoff(now, failureDays, windowHours),
      }),
    EMPTY,
  );
  const alertsAwaitingPurge = await guardedStep(
    uow,
    'alerts_due',
    failed,
    () => countPurgeableAlerts(uow, deps),
    0,
  );

  const truncated: string[] = [];
  if (notifications.truncated) truncated.push('notifications');
  if (subscriptions.truncated) truncated.push('push_subscriptions');
  if (jobs.truncated) truncated.push('jobs');
  if (consumerFailures.truncated) truncated.push('consumer_failures');

  return {
    notificationsDeleted: notifications.deleted,
    pushSubscriptionsDeleted: subscriptions.deleted,
    jobsDeleted: jobs.deleted,
    consumerFailuresDeleted: consumerFailures.deleted,
    alertsAwaitingPurge,
    truncated,
    failedSteps: failed,
  };
}

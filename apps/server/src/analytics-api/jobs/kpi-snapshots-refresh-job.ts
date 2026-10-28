/**
 * `analytics.kpi_snapshots.refresh` (P9-18 ; ADR-066 §5 à §7, AT-054) : toutes les 15 minutes, recalcule
 * l'instantané personnel d'indicateurs des utilisateurs **actifs** — un compte actif dont une session ouverte sur
 * un appareil en service a servi depuis `analytics.snapshot_active_days` jours (7) — pour chaque tableau dont il
 * détient la permission (les cinq tableaux de rôle et `distribution`, TB-4) et pour chaque période (`TODAY`, `WEEK`,
 * `MONTH`).
 *
 * - **Mêmes chiffres que les tableaux** : le contenu est celui des blocs de `buildDashboard` (même composition, même
 *   étendue exacte de la permission, mêmes fonctions de référence) ; seuls les indicateurs sont conservés, sans les
 *   liens d'exploration (l'appareil ne s'en sert pas). Le droit, l'étendue exacte et les réglages sont préparés une
 *   fois par utilisateur et tableau (`prepareDashboard`), les blocs calculés une fois par période (TB-8).
 * - **Par lots et budget de durée** : au plus `analytics.snapshot_batch_size` utilisateurs (50) par exécution, dans
 *   l'ordre de leur identifiant, et pas plus de `analytics.snapshot_time_budget_seconds` secondes (60, plafonnées à
 *   la moitié de `sync.pull_settle_seconds` ; AV-448) : le budget est contrôlé après chaque utilisateur (au moins un
 *   par exécution) ; si le lot est plein ou le budget épuisé, une tâche de reprise est déposée à la suite du dernier
 *   utilisateur traité. Le dernier lot supprime aussi les instantanés des utilisateurs devenus inactifs.
 * - **Droit perdu** : les instantanés d'un tableau dont l'utilisateur n'a plus la permission sont supprimés (et
 *   publiés en `DELETE`) ; la purge repose sur les permissions réellement détenues, pas sur la réussite des calculs.
 *   Un tableau ou une période qui n'a pas pu être calculé garde son instantané précédent, daté.
 * - **Isolation** (TB-3) : chaque utilisateur, chaque tableau (préparation) et chaque période (calcul et écriture)
 *   s'exécute sous un point de sauvegarde ; un échec en défait les écritures, est journalisé et compté dans `failed`
 *   sans arrêter le lot. Une transaction perdue (interblocage, attente de verrou) n'est pas isolée : l'erreur remonte
 *   et le `JobRunner` rejoue la tâche (ADR-068 §3).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DASHBOARD_CODES, type DashboardCode, type DashboardKpi } from '@gic/contracts';
import { businessDayOf, resolveAnalyticsPeriod, type Clock } from '@gic/domain';
import { CLOCK } from '../../platform/clock.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../platform/jobs/job-handler-registry.provider.js';
import { JobsService } from '../../platform/jobs/jobs.service.js';
import { toBin } from '../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../platform/unit-of-work.js';
import {
  SNAPSHOT_PERIOD_KEYS,
  activeSnapshotUsers,
  deleteSnapshotsExcept,
  deleteSnapshotsOfInactiveUsers,
  saveSnapshot,
  snapshotPair,
} from '../../modules/analytics/application/public/index.js';
import { hasPermissionAt } from '../../modules/identity/application/public/index.js';
import { currentSettingValue } from '../../modules/organization/application/public/index.js';
import {
  buildDashboardBlocks,
  dashboardPermission,
  prepareDashboard,
} from '../dashboards/dashboard-builder.js';

export const KPI_SNAPSHOTS_REFRESH_JOB_TYPE = 'analytics.kpi_snapshots.refresh';
export const SNAPSHOT_ACTIVE_DAYS_KEY = 'analytics.snapshot_active_days';
export const SNAPSHOT_BATCH_SIZE_KEY = 'analytics.snapshot_batch_size';
export const SNAPSHOT_TIME_BUDGET_KEY = 'analytics.snapshot_time_budget_seconds';
/** Fenêtre de règlement du flux (AV-198) : le budget de la tâche reste en deçà (TB-8). */
const PULL_SETTLE_KEY = 'sync.pull_settle_seconds';
const DEFAULT_ACTIVE_DAYS = 7;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TIME_BUDGET_SECONDS = 60;
const DEFAULT_PULL_SETTLE_SECONDS = 120;
const DAY_MS = 86_400_000;

const payloadSchema = z
  .object({ afterUserId: z.string().uuid().nullable().optional() })
  .passthrough();

export interface UserRefreshOutcome {
  readonly saved: number;
  readonly published: number;
  readonly deleted: number;
  /** Unités non calculées ou non purgées (tableau, période, purge), journalisées. */
  readonly failed: number;
}

export interface SnapshotBatchOutcome extends UserRefreshOutcome {
  /** Utilisateurs traités avant la fin de la liste ou du budget de durée. */
  readonly processed: number;
}

export interface KpiSnapshotsRefreshOutcome extends SnapshotBatchOutcome {
  readonly users: number;
  readonly continued: boolean;
}

/** Valeur entière strictement positive d'un paramètre global, sinon son défaut. */
async function positiveIntSetting(
  uow: UnitOfWork,
  key: string,
  at: Date,
  fallback: number,
): Promise<number> {
  const value = await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Indicateurs d'un tableau, sans lien d'exploration, dans l'ordre des blocs. */
export function snapshotKpisOf(
  blocks: readonly { readonly kpis: readonly DashboardKpi[] }[],
): readonly Omit<DashboardKpi, 'explore'>[] {
  return blocks.flatMap((block) => block.kpis.map(({ explore: _explore, ...kpi }) => kpi));
}

/** Message d'une erreur, avec son code et son `errno` MySQL (diagnostic des interblocages). */
function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const technical = error as { code?: unknown; errno?: unknown } | null | undefined;
  const parts: string[] = [];
  if (typeof technical?.code === 'string') parts.push(technical.code);
  if (typeof technical?.errno === 'number') parts.push(`errno ${technical.errno}`);
  return parts.length > 0 ? `${message} (${parts.join(', ')})` : message;
}

/** Interblocage, attente de verrou : la transaction est perdue (même règle que alert-escalation.ts). */
function isTransactionLost(error: unknown): boolean {
  const errno = (error as { errno?: number } | null)?.errno;
  return errno === 1213 || errno === 1205;
}

type Isolated<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

type SavepointName =
  | 'snapshot_user'
  | 'snapshot_prepare'
  | 'snapshot_unit'
  | 'snapshot_purge'
  | 'snapshot_inactive_purge';

/**
 * Exécute `work` sous un point de sauvegarde : une erreur en défait les écritures (instantané à demi écrit) sans
 * toucher au reste du lot. Une transaction perdue ne se poursuit pas (les écritures suivantes ne seraient plus
 * atomiques) : l'erreur remonte et le `JobRunner` rejoue la tâche (ADR-068 §3). Limite : les blocs d'un tableau
 * s'isolent eux-mêmes (`guarded`) et masquent leurs erreurs de lecture, interblocage compris ; seules la préparation,
 * l'écriture et les purges peuvent donc remonter une transaction perdue. Les noms des points de sauvegarde sont des
 * constantes (jamais une donnée) ; ils s'emboîtent (utilisateur, puis tableau ou période) et MySQL remplace un point
 * de même nom.
 */
async function isolated<T>(
  uow: UnitOfWork,
  name: SavepointName,
  work: () => Promise<T>,
): Promise<Isolated<T>> {
  await sql`SAVEPOINT ${sql.raw(name)}`.execute(uow);
  try {
    const value = await work();
    await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(uow);
    return { ok: true, value };
  } catch (error) {
    if (isTransactionLost(error)) throw error;
    try {
      await sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`.execute(uow);
      await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(uow);
    } catch {
      // Le point de sauvegarde n'existe plus : MySQL a annulé la transaction, l'erreur d'origine remonte.
      throw error;
    }
    return { ok: false, error };
  }
}

/**
 * Recalcule les instantanés d'un utilisateur : un par tableau dont il détient la permission et par période
 * (`TODAY`, `WEEK`, `MONTH`) ; supprime (et publie en `DELETE`) ceux d'un tableau dont il n'a plus la permission.
 * `saved` : instantanés écrits ; `published` : lignes publiées au flux (contenu changé ou à rafraîchir) ; `deleted` :
 * instantanés supprimés ; `failed` : tableaux, périodes ou purge en échec (instantané précédent gardé, une seule ligne
 * de journal par utilisateur).
 */
export async function refreshSnapshotsOf(
  uow: UnitOfWork,
  userId: string,
  now: Date,
  deps: { readonly logger?: Logger } = {},
): Promise<UserRefreshOutcome> {
  const today = businessDayOf(now);
  const userBin = toBin(userId);
  // Les tableaux dont l'utilisateur détient la permission : c'est ce qui fonde la purge, pas la réussite des calculs.
  const held: DashboardCode[] = [];
  for (const code of DASHBOARD_CODES) {
    if (await hasPermissionAt(uow, userBin, dashboardPermission(code), now)) held.push(code);
  }

  const keep = new Set<string>();
  let saved = 0;
  let published = 0;
  let failed = 0;
  const failures: string[] = [];
  const fail = (what: string, error: unknown): void => {
    failed += 1;
    failures.push(`${what} : ${errorDetail(error)}`);
  };

  for (const code of held) {
    // Gardés même si le calcul échoue : l'instantané précédent reste servi, daté.
    for (const periodKey of SNAPSHOT_PERIOD_KEYS) keep.add(snapshotPair(code, periodKey));
    const prepared = await isolated(uow, 'snapshot_prepare', () =>
      prepareDashboard(uow, { userId, at: now, code }),
    );
    if (!prepared.ok) {
      fail(`tableau ${code}`, prepared.error);
      continue;
    }
    const dashboard = prepared.value;
    if (dashboard === null) continue; // droit perdu entre-temps : la passe suivante le retirera
    for (const periodKey of SNAPSHOT_PERIOD_KEYS) {
      const period = resolveAnalyticsPeriod({ code: periodKey, today });
      const unit = await isolated(uow, 'snapshot_unit', async () =>
        saveSnapshot(uow, {
          userId,
          scopeKey: code,
          periodKey,
          kpis: snapshotKpisOf(await buildDashboardBlocks(dashboard, period)),
          computedAt: now,
        }),
      );
      if (!unit.ok) {
        fail(`tableau ${code}, période ${periodKey}`, unit.error);
        continue;
      }
      saved += 1;
      if (unit.value) published += 1;
    }
  }

  const purge = await isolated(uow, 'snapshot_purge', () =>
    deleteSnapshotsExcept(uow, userId, keep),
  );
  if (!purge.ok) fail('retrait des droits perdus', purge.error);
  if (failures.length > 0) {
    deps.logger?.error(
      `Instantané d'indicateurs non calculé (utilisateur ${userId}) : ${failures.join(' ; ')}`,
    );
  }
  return { saved, published, deleted: purge.ok ? purge.value : 0, failed };
}

/**
 * Traite les utilisateurs dans l'ordre, chacun sous un point de sauvegarde (un échec imprévu est compté et
 * journalisé), et s'arrête dès que `budgetMs` est écoulé depuis `startedAt` : le test vient **après** le traitement,
 * si bien qu'au moins un utilisateur est traité par exécution (progression garantie). Un utilisateur isolé reste
 * non borné entre ses unités.
 */
export async function refreshSnapshotsBatch(
  uow: UnitOfWork,
  deps: { readonly logger?: Logger; readonly elapsedMs: () => number },
  input: {
    readonly userIds: readonly string[];
    readonly now: Date;
    readonly startedAt: number;
    readonly budgetMs: number;
  },
): Promise<SnapshotBatchOutcome> {
  let processed = 0;
  let saved = 0;
  let published = 0;
  let deleted = 0;
  let failed = 0;
  const userDeps = deps.logger === undefined ? {} : { logger: deps.logger };
  for (const userId of input.userIds) {
    const done = await isolated(uow, 'snapshot_user', () =>
      refreshSnapshotsOf(uow, userId, input.now, userDeps),
    );
    processed += 1;
    if (done.ok) {
      saved += done.value.saved;
      published += done.value.published;
      deleted += done.value.deleted;
      failed += done.value.failed;
    } else {
      failed += 1;
      deps.logger?.error(
        `Instantané d'indicateurs non calculé pour l'utilisateur ${userId} : ${errorDetail(done.error)}`,
      );
    }
    if (deps.elapsedMs() - input.startedAt >= input.budgetMs) break;
  }
  return { processed, saved, published, deleted, failed };
}

export async function runKpiSnapshotsRefresh(
  uow: UnitOfWork,
  deps: {
    readonly clock: Clock;
    readonly jobs: JobsService;
    readonly logger?: Logger;
    /** Horloge monotone en millisecondes (défaut `performance.now()`) : injectable pour les essais. */
    readonly elapsedMs?: () => number;
  },
  rawPayload: unknown,
): Promise<KpiSnapshotsRefreshOutcome> {
  const elapsedMs = deps.elapsedMs ?? ((): number => performance.now());
  const startedAt = elapsedMs();
  const payload = payloadSchema.safeParse(rawPayload);
  const afterUserId = payload.success ? (payload.data.afterUserId ?? null) : null;
  const now = deps.clock.now();
  const activeDays = await positiveIntSetting(
    uow,
    SNAPSHOT_ACTIVE_DAYS_KEY,
    now,
    DEFAULT_ACTIVE_DAYS,
  );
  const batchSize = await positiveIntSetting(uow, SNAPSHOT_BATCH_SIZE_KEY, now, DEFAULT_BATCH_SIZE);
  // Le budget reste sous la fenêtre de règlement du flux (la moitié, pour laisser la place d'un utilisateur lent) :
  // au-delà, les lignes publiées au début de la transaction deviendraient un trou que le pull saute (AV-448).
  const configuredBudget = await positiveIntSetting(
    uow,
    SNAPSHOT_TIME_BUDGET_KEY,
    now,
    DEFAULT_TIME_BUDGET_SECONDS,
  );
  const settleSeconds = await positiveIntSetting(
    uow,
    PULL_SETTLE_KEY,
    now,
    DEFAULT_PULL_SETTLE_SECONDS,
  );
  const ceilingSeconds = Math.max(1, Math.floor(settleSeconds / 2));
  if (configuredBudget > ceilingSeconds) {
    deps.logger?.warn(
      `Budget des instantanés d'indicateurs (${SNAPSHOT_TIME_BUDGET_KEY} = ${configuredBudget} s) ramené à ` +
        `${ceilingSeconds} s : la moitié de ${PULL_SETTLE_KEY} (${settleSeconds} s).`,
    );
  }
  const budgetMs = Math.min(configuredBudget, ceilingSeconds) * 1000;
  const since = new Date(now.getTime() - activeDays * DAY_MS);
  const users = await activeSnapshotUsers(uow, { since, afterUserId, limit: batchSize });

  const batch = await refreshSnapshotsBatch(
    uow,
    { ...(deps.logger === undefined ? {} : { logger: deps.logger }), elapsedMs },
    { userIds: users, now, startedAt, budgetMs },
  );
  let deleted = batch.deleted;
  let failed = batch.failed;

  const last = batch.processed > 0 ? users[batch.processed - 1] : undefined;
  // Reprise : lot plein, ou budget épuisé avant la fin de la liste.
  const continued =
    last !== undefined && (batch.processed < users.length || users.length === batchSize);
  if (continued) {
    await deps.jobs.enqueue(uow, {
      jobType: KPI_SNAPSHOTS_REFRESH_JOB_TYPE,
      payload: { afterUserId: last },
    });
  } else {
    // Jamais au milieu d'une reprise ; un échec est compté sans perdre le reste de la passe.
    const inactive = await isolated(uow, 'snapshot_inactive_purge', () =>
      deleteSnapshotsOfInactiveUsers(uow, since),
    );
    if (inactive.ok) {
      deleted += inactive.value;
    } else {
      failed += 1;
      deps.logger?.error(
        `Instantanés des utilisateurs inactifs non retirés : ${errorDetail(inactive.error)}`,
      );
    }
  }
  return {
    users: users.length,
    processed: batch.processed,
    saved: batch.saved,
    published: batch.published,
    deleted,
    failed,
    continued,
  };
}

@Injectable()
export class KpiSnapshotsRefreshJob implements OnModuleInit {
  private readonly logger = new Logger(KpiSnapshotsRefreshJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(KPI_SNAPSHOTS_REFRESH_JOB_TYPE, async (uow, payload) => {
      const outcome = await runKpiSnapshotsRefresh(
        uow,
        { clock: this.clock, jobs: this.jobs, logger: this.logger },
        payload,
      );
      this.logger.log(
        `Instantanés d'indicateurs : ${outcome.users} utilisateur(s) lu(s), ${outcome.processed} traité(s), ` +
          `${outcome.saved} instantané(s) calculé(s), ${outcome.published} publié(s), ` +
          `${outcome.deleted} supprimé(s), ${outcome.failed} unité(s) en échec (tableau, période ou purge)` +
          `${outcome.continued ? ' ; reprise déposée' : ''}.`,
      );
    });
  }
}

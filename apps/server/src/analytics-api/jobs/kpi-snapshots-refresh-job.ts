/**
 * `analytics.kpi_snapshots.refresh` (P9-18 ; ADR-066 §5 à §7, AT-054) : toutes les 15 minutes, recalcule
 * l'instantané personnel d'indicateurs des utilisateurs **actifs** — un compte actif dont une session ouverte sur
 * un appareil en service a servi depuis `analytics.snapshot_active_days` jours (7) — pour chaque tableau de rôle
 * dont il détient la permission et pour chaque période (`TODAY`, `WEEK`, `MONTH`).
 *
 * - **Mêmes chiffres que les tableaux** : le contenu est celui de `buildDashboard` (même composition, même étendue
 *   exacte de la permission, mêmes fonctions de référence) ; seuls les indicateurs sont conservés, sans les liens
 *   d'exploration (l'appareil ne s'en sert pas).
 * - **Par lots** : au plus `analytics.snapshot_batch_size` utilisateurs (50) par exécution, dans l'ordre de leur
 *   identifiant ; si le lot est plein, une tâche de reprise est déposée à la suite du dernier utilisateur traité.
 *   Le dernier lot supprime aussi les instantanés des utilisateurs devenus inactifs.
 * - **Droit perdu** : les instantanés d'un tableau dont l'utilisateur n'a plus la permission sont supprimés (et
 *   publiés en `DELETE`) ; un tableau qui n'a pas pu être calculé garde son instantané précédent, daté.
 * - **Isolation** : l'échec d'un utilisateur est journalisé et n'arrête pas le lot.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { DashboardKpi } from '@gic/contracts';
import { businessDayOf, resolveAnalyticsPeriod, type Clock } from '@gic/domain';
import { CLOCK } from '../../platform/clock.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../platform/jobs/job-handler-registry.provider.js';
import { JobsService } from '../../platform/jobs/jobs.service.js';
import type { UnitOfWork } from '../../platform/unit-of-work.js';
import {
  SNAPSHOT_PERIOD_KEYS,
  activeSnapshotUsers,
  deleteSnapshotsExcept,
  deleteSnapshotsOfInactiveUsers,
  saveSnapshot,
  snapshotPair,
} from '../../modules/analytics/application/public/index.js';
import { currentSettingValue } from '../../modules/organization/application/public/index.js';
import { buildDashboard, ROLE_DASHBOARD_CODES } from '../dashboards/dashboard-builder.js';

export const KPI_SNAPSHOTS_REFRESH_JOB_TYPE = 'analytics.kpi_snapshots.refresh';
export const SNAPSHOT_ACTIVE_DAYS_KEY = 'analytics.snapshot_active_days';
export const SNAPSHOT_BATCH_SIZE_KEY = 'analytics.snapshot_batch_size';
const DEFAULT_ACTIVE_DAYS = 7;
const DEFAULT_BATCH_SIZE = 50;
const DAY_MS = 86_400_000;

const payloadSchema = z
  .object({ afterUserId: z.string().uuid().nullable().optional() })
  .passthrough();

export interface KpiSnapshotsRefreshOutcome {
  readonly users: number;
  readonly saved: number;
  readonly published: number;
  readonly deleted: number;
  readonly failed: number;
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

/**
 * Recalcule les instantanés d'un utilisateur : un par tableau de rôle dont il détient la permission et par période
 * (`TODAY`, `WEEK`, `MONTH`) ; supprime (et publie en `DELETE`) ceux d'un tableau dont il n'a plus la permission.
 * `saved` : instantanés écrits ; `published` : lignes publiées au flux (contenu changé ou à rafraîchir) ; `deleted` :
 * instantanés supprimés.
 */
export async function refreshSnapshotsOf(
  uow: UnitOfWork,
  userId: string,
  now: Date,
): Promise<{ readonly saved: number; readonly published: number; readonly deleted: number }> {
  const today = businessDayOf(now);
  const keep = new Set<string>();
  let saved = 0;
  let published = 0;
  for (const code of ROLE_DASHBOARD_CODES) {
    for (const periodKey of SNAPSHOT_PERIOD_KEYS) {
      const period = resolveAnalyticsPeriod({ code: periodKey, today });
      const dashboard = await buildDashboard(uow, { userId, at: now, code, period });
      if (dashboard === null) continue; // permission du tableau absente : pas d'instantané
      keep.add(snapshotPair(code, periodKey));
      const written = await saveSnapshot(uow, {
        userId,
        scopeKey: code,
        periodKey,
        kpis: snapshotKpisOf(dashboard.blocks),
        computedAt: now,
      });
      if (written) published += 1;
      saved += 1;
    }
  }
  const deleted = await deleteSnapshotsExcept(uow, userId, keep);
  return { saved, published, deleted };
}

export async function runKpiSnapshotsRefresh(
  uow: UnitOfWork,
  deps: { readonly clock: Clock; readonly jobs: JobsService; readonly logger?: Logger },
  rawPayload: unknown,
): Promise<KpiSnapshotsRefreshOutcome> {
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
  const since = new Date(now.getTime() - activeDays * DAY_MS);
  const users = await activeSnapshotUsers(uow, { since, afterUserId, limit: batchSize });

  let saved = 0;
  let published = 0;
  let deleted = 0;
  let failed = 0;
  for (const userId of users) {
    try {
      const done = await refreshSnapshotsOf(uow, userId, now);
      saved += done.saved;
      published += done.published;
      deleted += done.deleted;
    } catch (error) {
      failed += 1;
      deps.logger?.error(
        `Instantané d'indicateurs non calculé pour l'utilisateur ${userId} : ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const last = users.length > 0 ? users[users.length - 1] : undefined;
  const continued = users.length === batchSize && last !== undefined;
  if (continued) {
    await deps.jobs.enqueue(uow, {
      jobType: KPI_SNAPSHOTS_REFRESH_JOB_TYPE,
      payload: { afterUserId: last },
    });
  } else {
    deleted += await deleteSnapshotsOfInactiveUsers(uow, since);
  }
  return { users: users.length, saved, published, deleted, failed, continued };
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
        `Instantanés d'indicateurs : ${outcome.users} utilisateur(s), ${outcome.saved} instantané(s) calculé(s), ` +
          `${outcome.published} publié(s), ${outcome.deleted} supprimé(s), ${outcome.failed} en échec` +
          `${outcome.continued ? ' ; reprise déposée' : ''}.`,
      );
    });
  }
}

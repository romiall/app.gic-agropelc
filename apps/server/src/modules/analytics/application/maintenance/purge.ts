/**
 * Purges techniques de l'analyse (P9-22 ; ADR-078 §6, dictionnaire `analytics.*`) : tâche quotidienne
 * `analytics.maintenance.purge_daily`.
 *
 * - **Journal des requêtes** (`analytics_query_log`, `PURGE_TECHNIQUE`) : lignes de plus de
 *   `analytics.query_log_retention_days` jours (90) ; par lots bornés, jamais une ligne plus récente que la limite.
 * - **Exports expirés** : un export `DONE` dont l'échéance est passée devient `EXPIRED` (la ligne reste : trace
 *   d'audit, BR-ANA-008) ; son fichier est supprimé du stockage `analytics.export_file_retention_days` jours (30)
 *   après la création de la ligne.
 * - **Exports abandonnés** : un export encore `QUEUED` ou `RUNNING` plus d'un jour après sa demande a perdu sa tâche
 *   (rejeux épuisés) : il passe `FAILED` (`EXPORT_ABANDONED`) et son fichier partiel est supprimé.
 * - **Instantanés** : ceux des utilisateurs inactifs sont retirés par la tâche d'instantanés elle-même
 *   (`analytics.kpi_snapshots.refresh`, dernier lot de la passe).
 */
import type { Clock, IdGenerator } from '@gic/domain';
import { recordAudit } from '../../../../audit/record-audit.js';
import type { ChunkStorage } from '../../../../platform/storage/chunk-storage.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import {
  abandonedExports,
  exportStorageKey,
  expiredDoneExports,
  expiredExportsCreatedBetween,
  markExportExpired,
  markExportFailed,
} from '../exports/export-store.js';

export const QUERY_LOG_RETENTION_KEY = 'analytics.query_log_retention_days';
export const EXPORT_FILE_RETENTION_KEY = 'analytics.export_file_retention_days';
const DEFAULT_QUERY_LOG_RETENTION_DAYS = 90;
const DEFAULT_EXPORT_FILE_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const BATCH = 500;
const QUERY_LOG_BATCH = 5_000;
/** Lots de journal supprimés au plus par exécution (le reste attend le lendemain). */
const QUERY_LOG_MAX_BATCHES = 20;

export interface PurgeOutcome {
  readonly queryLogDeleted: number;
  readonly exportsExpired: number;
  readonly exportFilesDeleted: number;
  readonly exportsAbandoned: number;
}

async function days(uow: UnitOfWork, key: string, at: Date, fallback: number): Promise<number> {
  const value = await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function runAnalyticsPurge(
  uow: UnitOfWork,
  deps: { readonly clock: Clock; readonly idGenerator: IdGenerator; readonly storage: ChunkStorage },
): Promise<PurgeOutcome> {
  const now = deps.clock.now();
  const queryLogDays = await days(uow, QUERY_LOG_RETENTION_KEY, now, DEFAULT_QUERY_LOG_RETENTION_DAYS);
  const fileDays = await days(uow, EXPORT_FILE_RETENTION_KEY, now, DEFAULT_EXPORT_FILE_RETENTION_DAYS);

  let queryLogDeleted = 0;
  const logCutoff = new Date(now.getTime() - queryLogDays * DAY_MS);
  for (let batch = 0; batch < QUERY_LOG_MAX_BATCHES; batch += 1) {
    const result = await uow
      .deleteFrom('analytics_query_log')
      .where('created_at', '<', logCutoff)
      .limit(QUERY_LOG_BATCH)
      .executeTakeFirst();
    const deleted = Number(result.numDeletedRows);
    queryLogDeleted += deleted;
    if (deleted < QUERY_LOG_BATCH) break;
  }

  let exportsExpired = 0;
  for (const job of await expiredDoneExports(uow, now, BATCH)) {
    await markExportExpired(uow, job.id);
    exportsExpired += 1;
  }

  // Fichiers : les exports expirés créés il y a plus de `fileDays` jours, sur une fenêtre de même durée (la
  // suppression d'un fichier absent est sans effet) ; la fenêtre évite de reparcourir tout l'historique chaque jour.
  let exportFilesDeleted = 0;
  const filesTo = new Date(now.getTime() - fileDays * DAY_MS);
  const filesFrom = new Date(filesTo.getTime() - fileDays * DAY_MS);
  for (const job of await expiredExportsCreatedBetween(uow, filesFrom, filesTo, BATCH)) {
    await deps.storage.delete(exportStorageKey(job.id));
    exportFilesDeleted += 1;
  }

  let exportsAbandoned = 0;
  for (const job of await abandonedExports(uow, new Date(now.getTime() - DAY_MS), BATCH)) {
    await deps.storage.delete(exportStorageKey(job.id));
    await markExportFailed(uow, {
      id: job.id,
      errorCode: 'EXPORT_ABANDONED',
      durationMs: 0,
      finishedAt: now,
    });
    // Une fin sans calcul est tout de même auditée (INV-ANA-01) : au nom du demandeur, motif dans le code d'erreur.
    await recordAudit(uow, deps, {
      occurredAt: now,
      actorUserId: job.requestedBy,
      actorRoles: [],
      action: 'analytics.export.abandoned',
      entityType: 'ANALYTICS_EXPORT',
      entityId: job.id,
      after: { dataset: job.dataset, format: job.format, status: 'FAILED', error_code: 'EXPORT_ABANDONED' },
      result: 'FAILED',
      errorCode: 'EXPORT_ABANDONED',
    });
    exportsAbandoned += 1;
  }

  return { queryLogDeleted, exportsExpired, exportFilesDeleted, exportsAbandoned };
}

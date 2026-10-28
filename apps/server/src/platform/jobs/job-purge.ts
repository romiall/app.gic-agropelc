/**
 * Purge des tâches terminées de la file `platform_jobs` (P9-25, PF-7 ; ADR-068 §8 ;
 * 03-historisation-suppression.md §3 « platform.jobs (terminées) », `PURGE_TECHNIQUE` à 30 jours ; AV-472).
 *
 * - **Jamais une tâche `PENDING`** : l'ordonnanceur s'en sert pour ne pas empiler un créneau sur une tâche encore
 *   en attente (`job-scheduler.ts`, `enqueueIfDue`), et la voie longue la tient verrouillée pendant son exécution.
 * - **Âge** : la dernière échéance `run_at` (`completed_at` reste `NULL` pour une tâche `FAILED`). Comparaison
 *   stricte : une tâche d'âge exact conservé est gardée. Le prédicat est servi par `ix_platform_jobs_poll`
 *   (`status`, `run_at`).
 * - **Deux temps** (`deleteBatchByKeys`) : lecture des identifiants sans verrou, puis suppression par clé primaire.
 *   Un `DELETE ... WHERE status IN (...) AND run_at < ? LIMIT n` poserait, sous `REPEATABLE READ`, des verrous de
 *   clé suivante jusqu'à l'enregistrement qui borne la plage — la plus ancienne tâche `PENDING`, tenue par la voie
 *   longue pendant un export : la purge attendrait `innodb_lock_wait_timeout` puis échouerait. La lecture ne trie
 *   pas (un tri par `run_at` après `status IN` forcerait un tri de tout l'arriéré) ; le second temps garde
 *   `status IN ('DONE', 'FAILED')` par prudence.
 *
 * La durée est un réglage (`platform.job_retention_days`, 30) lu par l'appelant, la tâche quotidienne de la
 * communication (`runCommunicationPurge`) : cette fonction ne lit aucun réglage.
 */
import { deleteBatchByKeys, deleteByBatches, type BatchPurgeResult } from '../purge-batches.js';
import type { UnitOfWork } from '../unit-of-work.js';

/** Tâches supprimées par lot. */
export const JOB_PURGE_BATCH = 5_000;
/** Lots au plus par exécution : borne la durée de la transaction unique de la tâche quotidienne. */
export const JOB_PURGE_MAX_BATCHES = 10;

const TERMINATED = ['DONE', 'FAILED'] as const;

export async function purgeTerminatedJobs(
  uow: UnitOfWork,
  input: { readonly before: Date; readonly batch?: number; readonly maxBatches?: number },
): Promise<BatchPurgeResult> {
  return deleteByBatches(
    (limit) =>
      deleteBatchByKeys(
        limit,
        async (size) => {
          const rows = await uow
            .selectFrom('platform_jobs')
            .select('id')
            .where('status', 'in', [...TERMINATED])
            .where('run_at', '<', input.before)
            .limit(size)
            .execute();
          return rows.map((row) => row.id);
        },
        async (ids) =>
          Number(
            (
              await uow
                .deleteFrom('platform_jobs')
                .where('id', 'in', [...ids])
                .where('status', 'in', [...TERMINATED])
                .executeTakeFirst()
            ).numDeletedRows,
          ),
      ),
    {
      batch: input.batch ?? JOB_PURGE_BATCH,
      maxBatches: input.maxBatches ?? JOB_PURGE_MAX_BATCHES,
    },
  );
}

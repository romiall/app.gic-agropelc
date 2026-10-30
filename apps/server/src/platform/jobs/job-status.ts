/**
 * État de l'arriéré des tâches (P9-25, PF-6 ; AV-469) : ancienneté de la plus ancienne tâche due et nombre de tâches
 * passées `FAILED`, lus dans la table que la plateforme possède (`platform_jobs`). Lecture seule, sans verrou, sur le
 * modèle de `platform/events/consumer-status.ts` ; la sonde `GET /health/ready` s'en sert.
 *
 * - **Tâche due** : `PENDING` dont `run_at` est atteint (`ix_platform_jobs_poll`). Un worker arrêté, ou une voie
 *   saturée, laisse vieillir la plus ancienne. Une tâche en attente de reprise après un échec n'est « due » qu'une
 *   fois son attente écoulée.
 * - **Tâche échouée** : `FAILED` dont `run_at` est dans `(failedSince, now]` ; une tâche `FAILED` garde le `run_at` de
 *   son dernier essai (`job-runner.ts`, `recordFailure`). La borne haute est indispensable : une horloge d'essai dans
 *   le passé ne doit rien voir des lignes réelles.
 * - Le message d'erreur (`last_error`) n'est **jamais** lu ici : il peut citer des valeurs (ADR-061 §4).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../kysely/database.js';

export interface JobBacklog {
  /** `run_at` de la plus ancienne tâche `PENDING` due ; `null` si aucune n'est due. */
  readonly oldestDueAt: Date | null;
  /** Tâches `FAILED` dans la fenêtre demandée. */
  readonly failedJobs: number;
}

export async function readJobBacklog(
  executor: Kysely<DB> | Transaction<DB>,
  window: { readonly now: Date; readonly failedSince: Date },
): Promise<JobBacklog> {
  const due = await executor
    .selectFrom('platform_jobs')
    .select(({ fn }) => fn.min('run_at').as('oldest_due_at'))
    .where('status', '=', 'PENDING')
    .where('run_at', '<=', window.now)
    .executeTakeFirst();
  const failed = await executor
    .selectFrom('platform_jobs')
    .select(({ fn }) => fn.countAll<number>().as('failed_jobs'))
    .where('status', '=', 'FAILED')
    .where('run_at', '>', window.failedSince)
    .where('run_at', '<=', window.now)
    .executeTakeFirst();
  const oldest = due?.oldest_due_at ?? null;
  return {
    oldestDueAt: oldest === null ? null : new Date(oldest),
    failedJobs: Number(failed?.failed_jobs ?? 0),
  };
}

/** Tâches `FAILED` d'un même type dans la fenêtre demandée. */
export interface FailedJobsOfType {
  readonly jobType: string;
  readonly failedJobs: number;
  /** `run_at` du dernier essai de la plus récente tâche échouée du type. */
  readonly lastFailedAt: Date;
}

/**
 * Tâches `FAILED` de la fenêtre `(failedSince, now]`, regroupées par type de tâche (P9-27, AV-469 : une alerte
 * `JOB_FAILED` par type), par nom de type croissant. Même fenêtre que {@link readJobBacklog} (borne haute
 * comprise). Le message d'erreur et la charge utile ne sont jamais lus.
 */
export async function readFailedJobsByType(
  executor: Kysely<DB> | Transaction<DB>,
  window: { readonly now: Date; readonly failedSince: Date },
): Promise<readonly FailedJobsOfType[]> {
  const rows = await executor
    .selectFrom('platform_jobs')
    .select(({ fn }) => [
      'job_type',
      fn.countAll<number>().as('failed_jobs'),
      fn.max('run_at').as('last_failed_at'),
    ])
    .where('status', '=', 'FAILED')
    .where('run_at', '>', window.failedSince)
    .where('run_at', '<=', window.now)
    .groupBy('job_type')
    .orderBy('job_type')
    .execute();
  return rows.map((row) => ({
    jobType: row.job_type,
    failedJobs: Number(row.failed_jobs),
    lastFailedAt: new Date(row.last_failed_at ?? window.now),
  }));
}

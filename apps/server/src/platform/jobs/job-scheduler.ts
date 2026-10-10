/**
 * Ordonnanceur des tâches récurrentes (P5-16 ; 05-architecture/05-stack.md K5 « tâches planifiées par
 * verrou de ligne dédié », ADR-011, ADR-023 ; dictionnaire platform.job_schedules). Appelé par la
 * boucle du worker (`WorkerService.runOnce`) avant le traitement des tâches.
 *
 * Pour chaque récurrence inscrite (`RecurringJobRegistry`) :
 * - au premier passage du processus, sa ligne `platform_job_schedules` est créée (`next_run_at` =
 *   maintenant : la première occurrence part au premier tour) ou mise à jour (forme de la récurrence
 *   modifiée dans le code, **sans** réinitialiser `next_run_at`) ;
 * - à chaque passage, une transaction par type : la ligne due est verrouillée
 *   (`FOR UPDATE SKIP LOCKED` : plusieurs workers ne déposent jamais deux fois le même créneau) ; si
 *   la tâche précédente attend encore (`PENDING`), rien n'est déposé (pas d'empilement) ; sinon une
 *   tâche est déposée (`JobsService.enqueue`, charge `{ scheduledFor }`). Dans les deux cas
 *   `next_run_at` passe au créneau **suivant l'instant présent** (`nextRecurringRun`, packages/domain) :
 *   après un arrêt prolongé, une seule occurrence de rattrapage, jamais une rafale.
 * Une ligne dont le type n'est pas inscrit dans ce processus est ignorée (récurrence retirée du code).
 */
import { Inject, Injectable } from '@nestjs/common';
import { nextRecurringRun, type Clock } from '@gic/domain';
import { CLOCK } from '../clock.provider.js';
import { DATABASE, type Database } from '../kysely/database.provider.js';
import { fromBin, toBin } from '../kysely/uuid-columns.js';
import { JobsService } from './jobs.service.js';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJob,
  type RecurringJobRegistry,
} from './recurring-job-registry.provider.js';

function scheduleColumns(job: RecurringJob): {
  readonly schedule_kind: string;
  readonly interval_seconds: number | null;
  readonly local_time: string | null;
} {
  return job.schedule.kind === 'INTERVAL'
    ? {
        schedule_kind: 'INTERVAL',
        interval_seconds: job.schedule.intervalSeconds,
        local_time: null,
      }
    : { schedule_kind: 'DAILY', interval_seconds: null, local_time: job.schedule.localTime };
}

@Injectable()
export class JobScheduler {
  private synchronized = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(RECURRING_JOB_REGISTRY) private readonly registry: RecurringJobRegistry,
  ) {}

  /**
   * Dépose les tâches récurrentes dues ; `jobTypes` restreint le passage à ces types (isolation d'un
   * test dans la base partagée). Renvoie les identifiants des tâches déposées.
   */
  async enqueueDue(options: { readonly jobTypes?: readonly string[] } = {}): Promise<string[]> {
    await this.synchronize();
    const enqueued: string[] = [];
    for (const job of this.registry.list()) {
      if (options.jobTypes && !options.jobTypes.includes(job.jobType)) continue;
      const jobId = await this.enqueueIfDue(job);
      if (jobId !== null) enqueued.push(jobId);
    }
    return enqueued;
  }

  /** Crée ou met à jour la ligne de chaque récurrence inscrite (une fois par processus). */
  private async synchronize(): Promise<void> {
    if (this.synchronized) return;
    const now = this.clock.now();
    for (const job of this.registry.list()) {
      const columns = scheduleColumns(job);
      await this.db
        .insertInto('platform_job_schedules')
        .values({ job_type: job.jobType, ...columns, next_run_at: now })
        .onDuplicateKeyUpdate(columns)
        .execute();
    }
    this.synchronized = true;
  }

  private async enqueueIfDue(job: RecurringJob): Promise<string | null> {
    return this.db.transaction().execute(async (trx) => {
      const now = this.clock.now();
      const row = await trx
        .selectFrom('platform_job_schedules')
        .select(['job_type', 'next_run_at', 'last_job_id'])
        .where('job_type', '=', job.jobType)
        .where('next_run_at', '<=', now)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;

      const previous =
        row.last_job_id === null
          ? undefined
          : await trx
              .selectFrom('platform_jobs')
              .select('status')
              .where('id', '=', row.last_job_id)
              .executeTakeFirst();
      const stacking = previous?.status === 'PENDING';
      const jobId = stacking
        ? null
        : await this.jobs.enqueue(trx, {
            jobType: job.jobType,
            payload: { scheduledFor: row.next_run_at.toISOString() },
          });
      await trx
        .updateTable('platform_job_schedules')
        .set({
          next_run_at: nextRecurringRun(now, job.schedule),
          ...(jobId !== null ? { last_enqueued_at: now, last_job_id: toBin(jobId) } : {}),
        })
        .where('job_type', '=', job.jobType)
        .execute();
      return jobId;
    });
  }

  /** Identifiant de la dernière tâche déposée pour un type (lecture, tests et exploitation). */
  async lastJobId(jobType: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('platform_job_schedules')
      .select('last_job_id')
      .where('job_type', '=', jobType)
      .executeTakeFirst();
    return row?.last_job_id ? fromBin(row.last_job_id) : null;
  }
}

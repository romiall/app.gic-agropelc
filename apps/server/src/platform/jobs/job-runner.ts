/**
 * Traitement d'une tâche (P0-08) : `SELECT … FOR UPDATE SKIP LOCKED` (ADR-011, ADR-023) —
 * plusieurs instances de worker peuvent appeler `claimAndProcessOne` en parallèle sans jamais
 * réclamer la même ligne. Le verrou est tenu pour la durée de la transaction : succès ou
 * échec, la ligne est toujours mise à jour avant COMMIT (pas de statut « en cours » persistant
 * distinct — voir platform.jobs, dictionnaire).
 *
 * Échec : jusqu'à `max_attempts` tentatives avec attente progressive (2^tentatives secondes),
 * puis `FAILED` et `last_error` rempli (08-api-events/02-catalogue-evenements.md §3 « 5
 * essais avec attente progressive »).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../clock.provider.js';
import { DATABASE, type Database } from '../kysely/database.provider.js';
import { fromBin } from '../kysely/uuid-columns.js';
import type { UnitOfWork } from '../unit-of-work.js';
import { JOB_HANDLER_REGISTRY, type JobHandlerRegistry } from './job-handler-registry.provider.js';

export type JobRunOutcome =
  | { readonly claimed: false }
  | {
      readonly claimed: true;
      readonly jobId: string;
      readonly result: 'DONE' | 'RETRY' | 'FAILED';
    };

@Injectable()
export class JobRunner {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async claimAndProcessOne(): Promise<JobRunOutcome> {
    return this.db.transaction().execute(async (trx) => {
      const job = await trx
        .selectFrom('platform_jobs')
        .selectAll()
        .where('status', '=', 'PENDING')
        .where('run_at', '<=', this.clock.now())
        .orderBy('run_at', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!job) return { claimed: false };

      const jobId = fromBin(job.id);
      const handler = this.registry.resolve(job.job_type);
      if (!handler) {
        await this.recordFailure(
          trx,
          job,
          new Error(`Aucun gestionnaire enregistré pour « ${job.job_type} ».`),
        );
        return {
          claimed: true,
          jobId,
          result: job.attempts + 1 >= job.max_attempts ? 'FAILED' : 'RETRY',
        };
      }

      try {
        await handler(trx, job.payload);
        await trx
          .updateTable('platform_jobs')
          .set({ status: 'DONE', completed_at: this.clock.now() })
          .where('id', '=', job.id)
          .execute();
        return { claimed: true, jobId, result: 'DONE' };
      } catch (error) {
        await this.recordFailure(trx, job, error);
        return {
          claimed: true,
          jobId,
          result: job.attempts + 1 >= job.max_attempts ? 'FAILED' : 'RETRY',
        };
      }
    });
  }

  private async recordFailure(
    trx: UnitOfWork,
    job: { id: Buffer; attempts: number; max_attempts: number; run_at: Date },
    error: unknown,
  ): Promise<void> {
    const attempts = job.attempts + 1;
    const failed = attempts >= job.max_attempts;
    const backoffMs = 2 ** attempts * 1000;
    await trx
      .updateTable('platform_jobs')
      .set({
        attempts,
        status: failed ? 'FAILED' : 'PENDING',
        run_at: failed ? job.run_at : new Date(this.clock.now().getTime() + backoffMs),
        last_error: errorMessageOf(error),
      })
      .where('id', '=', job.id)
      .execute();
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

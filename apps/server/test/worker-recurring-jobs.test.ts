/**
 * Câblage réel de l'ordonnanceur dans le processus worker (P5-16) : `WorkerModule` (celui de
 * `worker.ts`) est démarré avec ses fournisseurs d'injection ; les récurrences d'`inventory` sont
 * inscrites au démarrage (balayage horaire, tâches quotidiennes à l'heure de Douala), leurs
 * gestionnaires sont enregistrés, et l'ordonnanceur injecté dépose réellement la tâche horaire au
 * créneau dû. La boucle du worker (`runOnce`) n'est pas lancée ici : elle exécuterait toutes les
 * tâches dues de la base partagée.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { WorkerService } from '../src/worker/worker.service.js';
import { JobScheduler } from '../src/platform/jobs/job-scheduler.js';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../src/platform/jobs/recurring-job-registry.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../src/platform/jobs/job-handler-registry.provider.js';
import { UNMATCHED_TRANSFER_SWEEP_JOB_TYPE } from '../src/modules/inventory/application/jobs/unmatched-transfer-sweep-job.js';
import { ALLOCATION_EXPIRY_JOB_TYPE } from '../src/modules/inventory/application/jobs/allocation-expiry-job.js';
import { LEDGER_RECONCILIATION_JOB_TYPE } from '../src/modules/inventory/application/jobs/ledger-reconciliation-job.js';
import { closeTestDb, db } from './helpers.js';

describe('ordonnanceur dans le worker (P5-16)', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('WorkerModule inscrit les récurrences d’inventory et dépose la tâche horaire au créneau dû', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    try {
      expect(moduleRef.get(WorkerService)).toBeDefined();
      const recurring = moduleRef.get<RecurringJobRegistry>(RECURRING_JOB_REGISTRY);
      expect(recurring.get(UNMATCHED_TRANSFER_SWEEP_JOB_TYPE)?.schedule).toEqual({
        kind: 'INTERVAL',
        intervalSeconds: 3600,
      });
      expect(recurring.get(ALLOCATION_EXPIRY_JOB_TYPE)?.schedule).toEqual({
        kind: 'DAILY',
        localTime: '00:05',
      });
      expect(recurring.get(LEDGER_RECONCILIATION_JOB_TYPE)?.schedule).toEqual({
        kind: 'DAILY',
        localTime: '02:00',
      });
      // Chaque tâche récurrente a son gestionnaire : l'ordonnanceur ne dépose rien d'inexécutable.
      const handlers = moduleRef.get<JobHandlerRegistry>(JOB_HANDLER_REGISTRY);
      for (const job of recurring.list()) {
        expect(handlers.resolve(job.jobType), job.jobType).toBeDefined();
      }

      const scheduler = moduleRef.get(JobScheduler);
      // Le créneau dû du balayage : la ligne existe déjà (autre passage) ou est créée ici.
      await db
        .updateTable('platform_job_schedules')
        .set({ next_run_at: new Date('2026-10-01T00:00:00.000Z'), last_job_id: null })
        .where('job_type', '=', UNMATCHED_TRANSFER_SWEEP_JOB_TYPE)
        .execute();
      const deposited = await scheduler.enqueueDue({
        jobTypes: [UNMATCHED_TRANSFER_SWEEP_JOB_TYPE],
      });
      expect(deposited).toHaveLength(1);
      const job = await db
        .selectFrom('platform_jobs')
        .select(['job_type', 'status'])
        .where('id', '=', toBin(deposited[0]!))
        .executeTakeFirstOrThrow();
      expect(job).toEqual({ job_type: UNMATCHED_TRANSFER_SWEEP_JOB_TYPE, status: 'PENDING' });
      // Aucune seconde occurrence dans le même créneau.
      expect(await scheduler.enqueueDue({ jobTypes: [UNMATCHED_TRANSFER_SWEEP_JOB_TYPE] })).toEqual(
        [],
      );
      // Tâche purgée : elle ne doit pas être réclamée par un autre fichier de la base partagée.
      await db.deleteFrom('platform_jobs').where('id', '=', toBin(deposited[0]!)).execute();
    } finally {
      await moduleRef.close();
    }
  });
});

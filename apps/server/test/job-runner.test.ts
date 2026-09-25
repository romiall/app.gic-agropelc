/**
 * Démonstration du critère de sortie P0-08 (`SELECT … FOR UPDATE SKIP LOCKED`, ADR-011,
 * ADR-023) : deux réclamations concurrentes ne portent jamais sur la même ligne, et deux
 * tâches distinctes se traitent réellement en parallèle (pas sérialisées par le verrou).
 * Échecs : jusqu'à `max_attempts` tentatives avec attente progressive puis `FAILED`
 * (08-api-events/02-catalogue-evenements.md §3). Écritures réelles, non annulées
 * (`platform_jobs` a `DELETE` accordé — PURGE_TECHNIQUE — mais pas de contrainte d'unicité
 * métier : chaque test utilise un `job_type` distinctif, comme partout ailleurs ici).
 */
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { describe, expect, it } from 'vitest';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { JobRunner } from '../src/platform/jobs/job-runner.js';
import { JobsService } from '../src/platform/jobs/jobs.service.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { db, freshUuid } from './helpers.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');

function buildJobsService(): JobsService {
  const clock = new FixedClock(NOW);
  return new JobsService(clock, new Uuidv7Generator(clock));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('JobRunner.claimAndProcessOne (P0-08)', () => {
  it('traite une tâche enregistrée : DONE, gestionnaire appelé une fois avec sa charge', async () => {
    const registry = new JobHandlerRegistry();
    let calls = 0;
    let receivedPayload: unknown;
    registry.register('test.job.succeed', async (_trx, payload) => {
      calls++;
      receivedPayload = payload;
    });
    const clock = new FixedClock(NOW);
    const runner = new JobRunner(db, registry, clock);

    const jobId = await db
      .transaction()
      .execute((trx) =>
        buildJobsService().enqueue(trx, { jobType: 'test.job.succeed', payload: { note: 'x' } }),
      );

    const outcome = await runner.claimAndProcessOne();
    expect(outcome).toEqual({ claimed: true, jobId, result: 'DONE' });
    expect(calls).toBe(1);
    expect(receivedPayload).toEqual({ note: 'x' });

    const row = await db
      .selectFrom('platform_jobs')
      .select(['status', 'completed_at'])
      .where('id', '=', toBin(jobId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('DONE');
    expect(row.completed_at).not.toBeNull();
  });

  it('gestionnaire absent : échec enregistré, attente progressive, reste PENDING avant max_attempts', async () => {
    const registry = new JobHandlerRegistry(); // aucun gestionnaire enregistré
    const clock = new FixedClock(NOW);
    const runner = new JobRunner(db, registry, clock);

    const jobId = await db
      .transaction()
      .execute((trx) =>
        buildJobsService().enqueue(trx, { jobType: 'test.job.unregistered', payload: {} }),
      );

    const outcome = await runner.claimAndProcessOne();
    expect(outcome).toEqual({ claimed: true, jobId, result: 'RETRY' });

    const row = await db
      .selectFrom('platform_jobs')
      .select(['status', 'attempts', 'last_error', 'run_at'])
      .where('id', '=', toBin(jobId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('test.job.unregistered');
    expect(row.run_at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('épuisement des tentatives : FAILED, last_error rempli (§3 « 5 essais »)', async () => {
    const registry = new JobHandlerRegistry();
    registry.register('test.job.always_fail', async () => {
      throw new Error('échec simulé');
    });
    const clock = new FixedClock(NOW);
    const runner = new JobRunner(db, registry, clock);

    const jobId = freshUuid();
    await db
      .insertInto('platform_jobs')
      .values({
        id: toBin(jobId),
        job_type: 'test.job.always_fail',
        payload: jsonValue({}),
        run_at: NOW,
        max_attempts: 1,
      })
      .execute();

    const outcome = await runner.claimAndProcessOne();
    expect(outcome).toEqual({ claimed: true, jobId, result: 'FAILED' });

    const row = await db
      .selectFrom('platform_jobs')
      .select(['status', 'attempts', 'last_error'])
      .where('id', '=', toBin(jobId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('échec simulé');
  });

  it('SKIP LOCKED : deux tâches, deux réclamations concurrentes → chacune la sienne, en parallèle', async () => {
    const registry = new JobHandlerRegistry();
    let concurrent = 0;
    let maxConcurrent = 0;
    registry.register('test.job.slow', async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(150);
      concurrent--;
    });
    const clock = new FixedClock(NOW);
    const runnerA = new JobRunner(db, registry, clock);
    const runnerB = new JobRunner(db, registry, clock);
    const jobsService = buildJobsService();

    await db.transaction().execute(async (trx) => {
      await jobsService.enqueue(trx, { jobType: 'test.job.slow', payload: {} });
      await jobsService.enqueue(trx, { jobType: 'test.job.slow', payload: {} });
    });

    const [a, b] = await Promise.all([runnerA.claimAndProcessOne(), runnerB.claimAndProcessOne()]);
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    if (a.claimed && b.claimed) {
      expect(a.jobId).not.toBe(b.jobId);
    }
    // Vraiment en parallèle (deux lignes distinctes verrouillées simultanément), pas
    // sérialisé par le verrou de la première ligne — c'est ce que SKIP LOCKED apporte par
    // rapport à un simple FOR UPDATE.
    expect(maxConcurrent).toBe(2);
  });
});

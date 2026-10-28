/**
 * Démonstration du critère de sortie P0-08 (`SELECT … FOR UPDATE SKIP LOCKED`, ADR-011,
 * ADR-023) : deux réclamations concurrentes ne portent jamais sur la même ligne, et deux
 * tâches distinctes se traitent réellement en parallèle (pas sérialisées par le verrou).
 * Échecs : jusqu'à `max_attempts` tentatives avec attente progressive puis `FAILED`
 * (08-api-events/02-catalogue-evenements.md §3). Écritures réelles, non annulées
 * (`platform_jobs` a `DELETE` accordé — PURGE_TECHNIQUE — mais pas de contrainte d'unicité
 * métier : chaque test utilise un `job_type` distinctif, comme partout ailleurs ici).
 */
import { FixedClock, Uuidv7Generator, type Clock } from '@gic/domain';
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  JobHandlerRegistry,
  type JobAttemptContext,
} from '../src/platform/jobs/job-handler-registry.js';
import { JobRunner, type JobRunOutcome } from '../src/platform/jobs/job-runner.js';
import { JobsService } from '../src/platform/jobs/jobs.service.js';
import type { Database } from '../src/platform/kysely/database.provider.js';
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

    try {
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
    } finally {
      // Sans cela la ligne resterait PENDING et « due » à jamais en horloge réelle (la sonde de disponibilité,
      // PF-6, la verrait comme une tâche en retard).
      await db.deleteFrom('platform_jobs').where('id', '=', toBin(jobId)).execute();
    }
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

  it('atomicité (P5-16) : un gestionnaire qui écrit puis lève ne laisse aucune écriture validée', async () => {
    const registry = new JobHandlerRegistry();
    const jobType = `test.job.partial.${freshUuid().slice(-12)}`;
    const eventId = freshUuid();
    registry.register(jobType, async (trx) => {
      await trx
        .insertInto('platform_domain_events')
        .values({
          event_id: toBin(eventId),
          event_type: 'TestPartialWrite',
          producer_module: 'test',
          aggregate_type: 'TEST',
          aggregate_id: toBin(eventId),
          occurred_at: NOW,
          payload: jsonValue({}),
          command_id: null,
        })
        .execute();
      throw new Error('échec après écriture');
    });
    const runner = new JobRunner(db, registry, new FixedClock(NOW));
    const jobId = await db
      .transaction()
      .execute((trx) => buildJobsService().enqueue(trx, { jobType, payload: {} }));

    const outcome = await runner.claimAndProcessOne({ jobTypes: [jobType] });
    expect(outcome).toEqual({ claimed: true, jobId, result: 'RETRY' });
    const written = await db
      .selectFrom('platform_domain_events')
      .select('seq')
      .where('event_id', '=', toBin(eventId))
      .executeTakeFirst();
    expect(written).toBeUndefined();
    const row = await db
      .selectFrom('platform_jobs')
      .select(['status', 'attempts', 'last_error'])
      .where('id', '=', toBin(jobId))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      last_error: 'échec après écriture',
    });
    await db.deleteFrom('platform_jobs').where('id', '=', toBin(jobId)).execute();
  });

  it('transaction perdue (interblocage) : l’échec est consigné hors de la transaction, la tâche reste due, rien ne remonte à la boucle du worker (P5-16)', async () => {
    const registry = new JobHandlerRegistry();
    const jobType = `test.job.lost.${freshUuid().slice(-12)}`;
    registry.register(jobType, async (trx) => {
      // MySQL annule toute la transaction d'une victime d'interblocage, point de sauvegarde compris.
      await sql`ROLLBACK`.execute(trx);
      throw new Error('transaction perdue');
    });
    const runner = new JobRunner(db, registry, new FixedClock(NOW));
    const jobId = await db
      .transaction()
      .execute((trx) => buildJobsService().enqueue(trx, { jobType, payload: {} }));

    const outcome = await runner.claimAndProcessOne({ jobTypes: [jobType] });
    expect(outcome).toEqual({ claimed: true, jobId, result: 'RETRY' });
    const row = await db
      .selectFrom('platform_jobs')
      .select(['status', 'attempts', 'last_error', 'run_at'])
      .where('id', '=', toBin(jobId))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      last_error: 'transaction perdue',
    });
    expect(row.run_at.getTime()).toBeGreaterThan(NOW.getTime());
    await db.deleteFrom('platform_jobs').where('id', '=', toBin(jobId)).execute();
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

  // Réclamation en deux temps (P9-25, PF-2). Les deux essais de voies et les deux essais de candidat périmé sont en
  // dernier : une ligne qu'ils laisseraient PENDING (datée avant NOW, donc la plus ancienne) serait réclamée en premier
  // par les essais ci-dessus qui n'ont pas de `jobTypes`. Chaque essai supprime ses lignes dans un `finally`.
  describe('réclamation en deux temps (P9-25, PF-2)', () => {
    /** Montage commun des deux essais de voies : deux types uniques, deux tâches dues, l'une plus ancienne que l'autre. */
    async function enqueueLanes(
      oldest: 'short' | 'long',
    ): Promise<{ shortType: string; longType: string; shortId: string; longId: string }> {
      const suffix = freshUuid().slice(-12);
      const shortType = `test.job.lane_short.${suffix}`;
      const longType = `test.job.lane_long.${suffix}`;
      const jobs = buildJobsService();
      const shortAt = new Date(NOW.getTime() - (oldest === 'short' ? 2000 : 1000));
      const longAt = new Date(NOW.getTime() - (oldest === 'short' ? 1000 : 2000));
      const shortId = await db
        .transaction()
        .execute((trx) => jobs.enqueue(trx, { jobType: shortType, payload: {}, runAt: shortAt }));
      const longId = await db
        .transaction()
        .execute((trx) => jobs.enqueue(trx, { jobType: longType, payload: {}, runAt: longAt }));
      return { shortType, longType, shortId, longId };
    }

    const statusOf = async (jobId: string): Promise<string> =>
      (
        await db
          .selectFrom('platform_jobs')
          .select('status')
          .where('id', '=', toBin(jobId))
          .executeTakeFirstOrThrow()
      ).status;

    it('la voie courte réclame sa tâche pendant qu’un export de la voie longue tient sa transaction ouverte', async () => {
      const { shortType, longType, shortId, longId } = await enqueueLanes('short');
      const started = deferred();
      const gate = deferred();
      const registry = new JobHandlerRegistry();
      registry.register(shortType, async () => undefined);
      registry.register(longType, async () => {
        started.resolve();
        await gate.promise;
      });
      const runnerA = new JobRunner(db, registry, new FixedClock(NOW));
      const runnerB = new JobRunner(db, registry, new FixedClock(NOW));
      let longLane: Promise<JobRunOutcome> | undefined;
      try {
        // La voie longue parcourt la tâche courte (plus ancienne) avant de retenir la sienne : avant le correctif,
        // elle la gardait verrouillée pendant tout le gestionnaire et la voie courte la sautait.
        longLane = runnerA.claimAndProcessOne({ jobTypes: [longType] });
        await Promise.race([started.promise, longLane]);

        const short = await withTimeout(
          runnerB.claimAndProcessOne({ jobTypes: [shortType] }),
          5000,
        );
        expect(short).toEqual({ claimed: true, jobId: shortId, result: 'DONE' });
        // La transaction de l'export est toujours ouverte : la tâche courte est bien terminée sans l'attendre.
        expect(await statusOf(shortId)).toBe('DONE');
        expect(await statusOf(longId)).toBe('PENDING');

        gate.resolve();
        expect(await longLane).toEqual({ claimed: true, jobId: longId, result: 'DONE' });
      } finally {
        // Ordre : libérer la porte, attendre la fin de la transaction de A, puis seulement supprimer (un DELETE de la
        // ligne de l'export attendrait sinon son verrou de ligne).
        gate.resolve();
        if (longLane !== undefined) await longLane.catch(() => undefined);
        await db
          .deleteFrom('platform_jobs')
          .where('id', 'in', [toBin(shortId), toBin(longId)])
          .execute();
      }
    });

    it('miroir : la voie longue réclame l’export pendant qu’une tâche courte, plus récente, tient sa transaction ouverte', async () => {
      const { shortType, longType, shortId, longId } = await enqueueLanes('long');
      const started = deferred();
      const gate = deferred();
      const registry = new JobHandlerRegistry();
      registry.register(shortType, async () => {
        started.resolve();
        await gate.promise;
      });
      registry.register(longType, async () => undefined);
      const runnerA = new JobRunner(db, registry, new FixedClock(NOW));
      const runnerB = new JobRunner(db, registry, new FixedClock(NOW));
      let shortLane: Promise<JobRunOutcome> | undefined;
      try {
        // La voie courte exclut l'export mais le parcourt (plus ancien) avant de retenir sa tâche.
        shortLane = runnerA.claimAndProcessOne({
          jobTypes: [shortType, longType],
          excludeJobTypes: [longType],
        });
        await Promise.race([started.promise, shortLane]);

        const long = await withTimeout(runnerB.claimAndProcessOne({ jobTypes: [longType] }), 5000);
        expect(long).toEqual({ claimed: true, jobId: longId, result: 'DONE' });
        expect(await statusOf(longId)).toBe('DONE');
        expect(await statusOf(shortId)).toBe('PENDING');

        gate.resolve();
        expect(await shortLane).toEqual({ claimed: true, jobId: shortId, result: 'DONE' });
      } finally {
        gate.resolve();
        if (shortLane !== undefined) await shortLane.catch(() => undefined);
        await db
          .deleteFrom('platform_jobs')
          .where('id', 'in', [toBin(shortId), toBin(longId)])
          .execute();
      }
    });

    /** Un lecteur de candidats qui rend des identifiants imposés : le second temps doit tout revérifier sous le verrou. */
    class StaleCandidateRunner extends JobRunner {
      constructor(
        database: Database,
        registry: JobHandlerRegistry,
        clock: Clock,
        private readonly staleIds: Buffer[],
      ) {
        super(database, registry, clock);
      }

      protected override dueCandidates(): Promise<Buffer[]> {
        return Promise.resolve(this.staleIds);
      }
    }

    it('un candidat déjà terminé par un autre worker n’est pas rejoué', async () => {
      const jobType = `test.job.stale_done.${freshUuid().slice(-12)}`;
      let calls = 0;
      const registry = new JobHandlerRegistry();
      registry.register(jobType, async () => {
        calls += 1;
      });
      const jobId = await db.transaction().execute((trx) =>
        buildJobsService().enqueue(trx, {
          jobType,
          payload: {},
          runAt: new Date(NOW.getTime() - 1000),
        }),
      );
      try {
        const done = await new JobRunner(db, registry, new FixedClock(NOW)).claimAndProcessOne({
          jobTypes: [jobType],
        });
        expect(done).toEqual({ claimed: true, jobId, result: 'DONE' });
        expect(calls).toBe(1);

        // Un second worker avait lu l'identifiant avant la fin du premier : la revérification l'écarte.
        const stale = new StaleCandidateRunner(db, registry, new FixedClock(NOW), [toBin(jobId)]);
        expect(await stale.claimAndProcessOne()).toEqual({ claimed: false });
        expect(calls).toBe(1);
        expect(await statusOf(jobId)).toBe('DONE');
      } finally {
        await db.deleteFrom('platform_jobs').where('id', '=', toBin(jobId)).execute();
      }
    });

    it('un candidat différé après la lecture (échéance postérieure à l’horloge) n’est pas réclamé', async () => {
      const jobType = `test.job.stale_later.${freshUuid().slice(-12)}`;
      let calls = 0;
      const registry = new JobHandlerRegistry();
      registry.register(jobType, async () => {
        calls += 1;
      });
      // Échéance une heure après l'horloge FIXE de l'essai (aucune horloge n'est déplacée dans le futur réel).
      const jobId = await db.transaction().execute((trx) =>
        buildJobsService().enqueue(trx, {
          jobType,
          payload: {},
          runAt: new Date(NOW.getTime() + 3_600_000),
        }),
      );
      try {
        const stale = new StaleCandidateRunner(db, registry, new FixedClock(NOW), [toBin(jobId)]);
        expect(await stale.claimAndProcessOne()).toEqual({ claimed: false });
        expect(calls).toBe(0);
        expect(await statusOf(jobId)).toBe('PENDING');
      } finally {
        await db.deleteFrom('platform_jobs').where('id', '=', toBin(jobId)).execute();
      }
    });
  });

  // PF-6 (AV-469) : le gestionnaire connaît l'essai en cours, et chaque échec est journalisé sans donnée.
  describe('essai en cours et journal des échecs (P9-25, PF-6)', () => {
    /** Deux tâches d'un type unique : A au premier essai, B au dernier (la plus récente, donc réclamée après A). */
    async function enqueueFirstAndLast(
      jobType: string,
      payload: unknown,
    ): Promise<[string, string]> {
      const first = freshUuid();
      const last = freshUuid();
      await db
        .insertInto('platform_jobs')
        .values([
          {
            id: toBin(first),
            job_type: jobType,
            payload: jsonValue(payload),
            run_at: new Date(NOW.getTime() - 2000),
            attempts: 0,
            max_attempts: 5,
          },
          {
            id: toBin(last),
            job_type: jobType,
            payload: jsonValue(payload),
            run_at: new Date(NOW.getTime() - 1000),
            attempts: 4,
            max_attempts: 5,
          },
        ])
        .execute();
      return [first, last];
    }
    const deleteJobs = (ids: readonly string[]) =>
      db
        .deleteFrom('platform_jobs')
        .where(
          'id',
          'in',
          ids.map((id) => toBin(id)),
        )
        .execute();

    it('le gestionnaire reçoit l’essai : 1 sur 5 au premier, 5 sur 5 au dernier (RETRY puis FAILED)', async () => {
      const jobType = `test.job.attempt.${freshUuid().slice(-12)}`;
      const contexts: (JobAttemptContext | undefined)[] = [];
      const registry = new JobHandlerRegistry();
      registry.register(jobType, async (_trx, _payload, context) => {
        contexts.push(context);
        throw new Error('échec simulé');
      });
      const runner = new JobRunner(db, registry, new FixedClock(NOW));
      const ids = await enqueueFirstAndLast(jobType, {});
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const first = await runner.claimAndProcessOne({ jobTypes: [jobType] });
        const last = await runner.claimAndProcessOne({ jobTypes: [jobType] });
        expect(first).toEqual({ claimed: true, jobId: ids[0], result: 'RETRY' });
        expect(last).toEqual({ claimed: true, jobId: ids[1], result: 'FAILED' });
        expect(contexts).toEqual([
          { attempt: 1, maxAttempts: 5 },
          { attempt: 5, maxAttempts: 5 },
        ]);
      } finally {
        warn.mockRestore();
        error.mockRestore();
        await deleteJobs(ids);
      }
    });

    it('le journal : avertissement au rejeu, erreur à l’échec définitif, jamais la charge utile ni le message', async () => {
      const jobType = `test.job.logged.${freshUuid().slice(-12)}`;
      const registry = new JobHandlerRegistry();
      registry.register(jobType, async () => {
        throw new Error('détail technique VALEUR-DU-MESSAGE');
      });
      const runner = new JobRunner(db, registry, new FixedClock(NOW));
      const ids = await enqueueFirstAndLast(jobType, { secret: 'VALEUR-DE-LA-CHARGE' });
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        await runner.claimAndProcessOne({ jobTypes: [jobType] });
        await runner.claimAndProcessOne({ jobTypes: [jobType] });
        const warned = warn.mock.calls.map((call) => String(call[0]));
        const errored = error.mock.calls.map((call) => String(call[0]));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain(jobType);
        expect(warned[0]).toContain('essai 1/5');
        expect(errored).toHaveLength(1);
        expect(errored[0]).toContain(jobType);
        expect(errored[0]).toContain('échec définitif');
        for (const message of [...warned, ...errored]) {
          expect(message).not.toContain('VALEUR-DE-LA-CHARGE');
          expect(message).not.toContain('VALEUR-DU-MESSAGE');
        }
      } finally {
        warn.mockRestore();
        error.mockRestore();
        await deleteJobs(ids);
      }
    });
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Échoue vite (au lieu d'attendre le délai du test) si une réclamation reste suspendue sur un verrou. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Délai de ${ms} ms dépassé`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

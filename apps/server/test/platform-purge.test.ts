/**
 * P9-25 (PF-7 ; ADR-068 §8 ; AV-425 « Limites », AV-472) : purges techniques de la plateforme — tâches terminées
 * de `platform_jobs` (`purgeTerminatedJobs`, jamais une tâche `PENDING`) et événements sautés par un consommateur
 * (`purgeConsumerFailures`, jamais dans la fenêtre de l'alerte `CONSUMER_FAILED`), appelées par la tâche
 * quotidienne de la communication (`runCommunicationPurge`).
 *
 * Base partagée et persistante : `BEFORE` et `NOW` sont en 2001, très antérieurs à toute ligne réelle ; les
 * réglages semés (valables depuis 2026) ne sont pas en vigueur à cette date, donc les défauts s'appliquent ; chaque
 * essai tourne dans une transaction annulée (`withTestUow`), avec des identifiants et des noms de consommateur
 * frais, et ne décale jamais l'horloge de la base. Les assertions portent sur des identifiants ou sont relatives
 * (jamais un compte absolu de la base partagée).
 *
 * Prérequis du privilège `DELETE` sur `platform_event_consumer_failures` : migration 20261201090700 (en CI ; en
 * local `gic_app` a tous les droits et masquerait un oubli, d'où l'essai de privilège de `db/tests/platform.test.ts`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FixedClock } from '@gic/domain';
import { runCommunicationPurge } from '../src/modules/communication/application/maintenance/purge.js';
import { readConsumerStatuses } from '../src/platform/events/consumer-status.js';
import { purgeConsumerFailures } from '../src/platform/events/consumer-failure-purge.js';
import { purgeTerminatedJobs } from '../src/platform/jobs/job-purge.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { deleteByBatches } from '../src/platform/purge-batches.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { closeTestDb, freshUuid, insertTestUser, withTestUow } from './helpers.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Coupure des essais de bornes : strictement avant = purgé, exactement à = conservé. */
const BEFORE = new Date('2001-01-02T00:00:00.000Z');
const NOW = new Date('2001-06-01T12:00:00.000Z');
const clock = new FixedClock(NOW);
const ago = (days: number, extraMs = 0): Date => new Date(NOW.getTime() - days * DAY - extraMs);

afterAll(async () => {
  await closeTestDb();
});

// --- Fixtures ---
type JobStatus = 'PENDING' | 'DONE' | 'FAILED';

async function job(
  uow: UnitOfWork,
  input: { readonly status: JobStatus; readonly runAt: Date; readonly attempts?: number },
): Promise<string> {
  const id = freshUuid();
  await uow
    .insertInto('platform_jobs')
    .values({
      id: toBin(id),
      job_type: `test.platform_purge.${id.slice(-12)}`,
      payload: jsonValue({}),
      status: input.status,
      run_at: input.runAt,
      attempts: input.attempts ?? (input.status === 'PENDING' ? 0 : 1),
      completed_at: input.status === 'DONE' ? input.runAt : null,
    })
    .execute();
  return id;
}

const jobExists = async (uow: UnitOfWork, id: string): Promise<boolean> =>
  (await uow
    .selectFrom('platform_jobs')
    .select('id')
    .where('id', '=', toBin(id))
    .executeTakeFirst()) !== undefined;

const freshConsumer = (): string => `test.platform_purge.${freshUuid().slice(-12)}`;

/** Événement sauté par `consumer` à `failedAt` (unicité consommateur × position : `eventSeq` distinct). */
async function skipped(
  uow: UnitOfWork,
  consumer: string,
  failedAt: Date,
  eventSeq: number = Math.floor(Math.random() * 1_000_000_000),
): Promise<void> {
  await uow
    .insertInto('platform_event_consumer_failures')
    .values({
      consumer_name: consumer,
      event_seq: eventSeq,
      event_id: toBin(freshUuid()),
      event_type: 'test.skipped_event',
      error_message: 'Erreur de test avec une donnée personnelle : 699000000',
      attempts: 5,
      failed_at: failedAt,
    })
    .execute();
}

/** Nombre de sauts du consommateur encore présents. */
async function skippedCount(uow: UnitOfWork, consumer: string): Promise<number> {
  return (
    await uow
      .selectFrom('platform_event_consumer_failures')
      .select('id')
      .where('consumer_name', '=', consumer)
      .execute()
  ).length;
}

/** Les sauts du consommateur encore présents, par date. */
async function skippedAt(uow: UnitOfWork, consumer: string): Promise<readonly number[]> {
  return (
    await uow
      .selectFrom('platform_event_consumer_failures')
      .select('failed_at')
      .where('consumer_name', '=', consumer)
      .orderBy('failed_at')
      .execute()
  ).map((row) => new Date(row.failed_at).getTime());
}

async function setSetting(
  uow: UnitOfWork,
  key: string,
  value: unknown,
  validFrom: Date,
): Promise<void> {
  await uow
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: JSON.stringify(value),
      scope_type: 'GLOBAL',
      valid_from: validFrom,
      created_by: toBin(await insertTestUser(uow)),
    })
    .execute();
}

describe('deleteByBatches (sans base)', () => {
  it('un lot vide : une seule exécution, rien de supprimé, pas tronqué', async () => {
    const limits: number[] = [];
    const result = await deleteByBatches(
      async (limit) => {
        limits.push(limit);
        return 0;
      },
      { batch: 3, maxBatches: 5 },
    );
    expect(result).toEqual({ deleted: 0, truncated: false });
    expect(limits).toEqual([3]);
  });

  it('des lots 3, 3 puis 1 : sept supprimés en trois appels, pas tronqué', async () => {
    const counts = [3, 3, 1];
    const limits: number[] = [];
    const result = await deleteByBatches(
      async (limit) => {
        limits.push(limit);
        return counts.shift() ?? 0;
      },
      { batch: 3, maxBatches: 5 },
    );
    expect(result).toEqual({ deleted: 7, truncated: false });
    expect(limits).toEqual([3, 3, 3]);
  });

  it('toujours un lot plein : le plafond de lots est atteint, le reste attend la prochaine exécution', async () => {
    let calls = 0;
    const result = await deleteByBatches(
      async (limit) => {
        calls += 1;
        return limit;
      },
      { batch: 4, maxBatches: 2 },
    );
    expect(result).toEqual({ deleted: 8, truncated: true });
    expect(calls).toBe(2);
  });
});

describe('purgeTerminatedJobs (PF-7)', () => {
  it('bornes : strictement avant la coupure ; jamais une tâche PENDING, même ancienne ou en reprise', () =>
    withTestUow(async (uow) => {
      const doneBefore = await job(uow, { status: 'DONE', runAt: new Date(BEFORE.getTime() - 1) });
      const doneExact = await job(uow, { status: 'DONE', runAt: BEFORE });
      const failedOld = await job(uow, {
        status: 'FAILED',
        runAt: new Date(BEFORE.getTime() - DAY),
      });
      const failedAfter = await job(uow, {
        status: 'FAILED',
        runAt: new Date(BEFORE.getTime() + 1),
      });
      const pendingOld = await job(uow, {
        status: 'PENDING',
        runAt: new Date('2000-01-01T00:00:00Z'),
      });
      const pendingRetry = await job(uow, {
        status: 'PENDING',
        runAt: new Date('2000-06-01T00:00:00Z'),
        attempts: 2,
      });

      const result = await purgeTerminatedJobs(uow, { before: BEFORE });
      expect(result.deleted).toBeGreaterThanOrEqual(2);
      expect(result.truncated).toBe(false);
      expect(await jobExists(uow, doneBefore)).toBe(false);
      expect(await jobExists(uow, failedOld)).toBe(false); // FAILED : completed_at reste NULL, l'âge est run_at
      expect(await jobExists(uow, doneExact)).toBe(true); // âge exact : conservée
      expect(await jobExists(uow, failedAfter)).toBe(true);
      expect(await jobExists(uow, pendingOld)).toBe(true); // jamais une tâche non terminée
      expect(await jobExists(uow, pendingRetry)).toBe(true);

      expect((await purgeTerminatedJobs(uow, { before: BEFORE })).deleted).toBe(0);
    }));

  it('lots plafonnés : cinq éligibles avec { batch: 2, maxBatches: 2 } en suppriment quatre, le reste à la reprise', () =>
    withTestUow(async (uow) => {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        ids.push(
          await job(uow, {
            status: index % 2 === 0 ? 'DONE' : 'FAILED',
            runAt: new Date(BEFORE.getTime() - (index + 1) * DAY),
          }),
        );
      }
      const first = await purgeTerminatedJobs(uow, { before: BEFORE, batch: 2, maxBatches: 2 });
      expect(first).toEqual({ deleted: 4, truncated: true });
      let remaining = 0;
      for (const id of ids) if (await jobExists(uow, id)) remaining += 1;
      expect(remaining).toBe(1);

      const second = await purgeTerminatedJobs(uow, { before: BEFORE, batch: 2, maxBatches: 2 });
      expect(second.deleted).toBeGreaterThanOrEqual(1);
      for (const id of ids) expect(await jobExists(uow, id)).toBe(false);
    }));
});

describe('purgeConsumerFailures (PF-7)', () => {
  it('bornes : strictement avant la coupure ; le message d’erreur n’est jamais lu', () =>
    withTestUow(async (uow) => {
      const consumer = freshConsumer();
      await skipped(uow, consumer, new Date(BEFORE.getTime() - 1), 1);
      await skipped(uow, consumer, BEFORE, 2);
      await skipped(uow, consumer, new Date(BEFORE.getTime() + DAY), 3);

      const result = await purgeConsumerFailures(uow, { before: BEFORE });
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(result.truncated).toBe(false);
      expect(await skippedAt(uow, consumer)).toEqual([
        BEFORE.getTime(), // âge exact : conservé
        BEFORE.getTime() + DAY,
      ]);
      expect((await purgeConsumerFailures(uow, { before: BEFORE })).deleted).toBe(0);
    }));

  it('lots plafonnés : { batch: 2, maxBatches: 1 } en supprime deux sur trois éligibles', () =>
    withTestUow(async (uow) => {
      const consumer = freshConsumer();
      for (let index = 0; index < 3; index += 1) {
        await skipped(uow, consumer, new Date(BEFORE.getTime() - (index + 1) * DAY), index + 1);
      }
      const first = await purgeConsumerFailures(uow, { before: BEFORE, batch: 2, maxBatches: 1 });
      expect(first).toEqual({ deleted: 2, truncated: true });
      expect(await skippedCount(uow, consumer)).toBe(1);
      await purgeConsumerFailures(uow, { before: BEFORE });
      expect(await skippedCount(uow, consumer)).toBe(0);
    }));
});

describe('tâche quotidienne de la communication : étapes jobs et consumer_failures (PF-7)', () => {
  it('sans réglage (fenêtre 24 h, rétention 90 j) : les sauts de 95 j et de 105 j sont supprimés, ceux de la fenêtre restent', () =>
    withTestUow(async (uow) => {
      const consumer = freshConsumer();
      await skipped(uow, consumer, ago(95), 1);
      await skipped(uow, consumer, ago(105), 2);
      await skipped(uow, consumer, ago(89), 3);
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(outcome.consumerFailuresDeleted).toBeGreaterThanOrEqual(2);
      expect(await skippedAt(uow, consumer)).toEqual([ago(89).getTime()]);
    }));

  it('fenêtre de CONSUMER_FAILED portée à 100 j : le saut de 95 j est conservé, celui de 105 j supprimé', () =>
    withTestUow(async (uow) => {
      await setSetting(
        uow,
        'communication.consumer_failure_window_hours',
        2_400,
        new Date(NOW.getTime() - 1000),
      );
      const consumer = freshConsumer();
      await skipped(uow, consumer, ago(95), 1);
      await skipped(uow, consumer, ago(105), 2);
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(await skippedAt(uow, consumer)).toEqual([ago(95).getTime()]);
    }));

  it('rétention des sauts réglée à 30 j : 35 j supprimé, 29 j conservé', () =>
    withTestUow(async (uow) => {
      await setSetting(
        uow,
        'platform.consumer_failure_retention_days',
        30,
        new Date(NOW.getTime() - 1000),
      );
      const consumer = freshConsumer();
      await skipped(uow, consumer, ago(35), 1);
      await skipped(uow, consumer, ago(29), 2);
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(await skippedAt(uow, consumer)).toEqual([ago(29).getTime()]);
    }));

  it('l’alerte CONSUMER_FAILED reste ouverte : la lecture de la fenêtre est inchangée par la purge', () =>
    withTestUow(async (uow) => {
      const consumer = freshConsumer();
      await uow
        .insertInto('platform_event_consumer_offsets')
        .values({ consumer_name: consumer, last_seq: 0 })
        .execute();
      await skipped(uow, consumer, new Date(NOW.getTime() - 2 * HOUR), 1);
      await skipped(uow, consumer, ago(200), 2); // hors fenêtre et au-delà de la rétention : supprimé

      const window = { failedSince: new Date(NOW.getTime() - 24 * HOUR), now: NOW };
      const statusOf = async () =>
        (await readConsumerStatuses(uow, window)).find(
          (status) => status.consumerName === consumer,
        );
      expect((await statusOf())?.failedEvents).toBe(1);

      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(await skippedCount(uow, consumer)).toBe(1);
      expect((await statusOf())?.failedEvents).toBe(1);
    }));

  it('durée des tâches lue au réglage à la date de l’horloge : 7 j réglés (8 j supprimée, 6 j conservée) ; sans réglage, 30 j', async () => {
    await withTestUow(async (uow) => {
      await setSetting(uow, 'platform.job_retention_days', 7, new Date(NOW.getTime() - 1000));
      const old = await job(uow, { status: 'DONE', runAt: ago(8) });
      const recent = await job(uow, { status: 'DONE', runAt: ago(6) });
      const pending = await job(uow, { status: 'PENDING', runAt: ago(8) });
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(outcome.jobsDeleted).toBeGreaterThanOrEqual(1);
      expect(await jobExists(uow, old)).toBe(false);
      expect(await jobExists(uow, recent)).toBe(true);
      expect(await jobExists(uow, pending)).toBe(true);
    });
    await withTestUow(async (uow) => {
      const old = await job(uow, { status: 'FAILED', runAt: ago(31) });
      const recent = await job(uow, { status: 'DONE', runAt: ago(29) });
      const outcome = await runCommunicationPurge(uow, { clock });
      expect(outcome.failedSteps).toEqual([]);
      expect(await jobExists(uow, old)).toBe(false);
      expect(await jobExists(uow, recent)).toBe(true);
    });
  });
});

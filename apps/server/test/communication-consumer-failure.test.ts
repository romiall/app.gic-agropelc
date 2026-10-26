/**
 * P9-10 : alerte `CONSUMER_FAILED` (D13 §7.1, ADR-061 §12, ADR-068 §7, AV-362, AV-425) —
 * `communication.consumers.failure_check` publie un `ConsumerFailureDetected` par consommateur d'événements en
 * échec (événement sauté dans la fenêtre, ou retard au-delà du seuil), puis le marqueur de passe. La passe lit
 * toutes les positions de la base partagée : horloge dans le passé lointain (2019), si bien que ses lignes réelles
 * (reçues après) ne donnent ni retard ni saut ; les consommateurs, événements et sauts de chaque cas sont insérés
 * dans la transaction annulée du test, aux dates voulues.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/index.js', async (importActual) => {
  const actual = (await importActual()) as {
    currentSettingValue: (...args: unknown[]) => Promise<unknown>;
  };
  return { ...actual, currentSettingValue: vi.fn(actual.currentSettingValue) };
});

import { FixedClock } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  CONSUMER_FAILURE_JOB_TYPE,
  ConsumerFailureJob,
  runConsumerFailureCheck,
} from '../src/modules/communication/application/jobs/consumer-failure-job.js';
import {
  COMMUNICATION_RECURRING_JOBS,
  CommunicationRecurringJobs,
} from '../src/modules/communication/application/jobs/communication-recurring-jobs.js';
import { RecurringJobRegistry } from '../src/platform/jobs/recurring-job-registry.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, freshUuid } from './helpers.js';
import {
  NOW,
  SLOT,
  TODAY,
  clock,
  deps,
  eventsOf,
  hoursBefore,
  idGenerator,
  markersOf,
} from './sync-alert-test-kit.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const settingsOverride = new Map<string, unknown>();
beforeEach(() => {
  settingsOverride.clear();
  vi.mocked(currentSettingValue).mockImplementation(async (_executor, input) => {
    const { key, at } = input as { key: string; at: Date };
    const value = settingsOverride.get(key);
    return typeof value === 'function' ? (value as (at: Date) => unknown)(at) : value;
  });
});

const secondsBefore = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const pass = (uow: UnitOfWork, at: string = SLOT) =>
  runConsumerFailureCheck(uow, deps, { scheduledFor: at });
const subject = (name: string) => compositeSubjectId('CONSUMER_FAILED', { consumer_name: name });
const freshName = () => `test.cf.${freshUuid()}`;

/** Événement reçu à `recordedAt` ; renvoie son numéro. */
async function eventAt(uow: UnitOfWork, recordedAt: Date): Promise<number> {
  const result = await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(freshUuid()),
      event_type: 'test.consumer_probe',
      producer_module: 'test',
      aggregate_type: 'TEST',
      aggregate_id: toBin(freshUuid()),
      occurred_at: recordedAt,
      recorded_at: recordedAt,
      payload: jsonValue({}),
    })
    .executeTakeFirstOrThrow();
  return Number(result.insertId);
}

/** Consommateur dont la position est `lastSeq`. */
async function consumer(
  uow: UnitOfWork,
  lastSeq: number,
  name: string = freshName(),
): Promise<string> {
  await uow
    .insertInto('platform_event_consumer_offsets')
    .values({ consumer_name: name, last_seq: lastSeq })
    .execute();
  return name;
}

/** Consommateur en retard : son plus ancien événement en attente a été reçu à `pendingSince`. */
async function lagging(uow: UnitOfWork, pendingSince: Date, name?: string): Promise<string> {
  const seq = await eventAt(uow, pendingSince);
  return consumer(uow, seq - 1, name);
}

/** Événement sauté par le consommateur à `failedAt`. */
async function skipped(
  uow: UnitOfWork,
  name: string,
  failedAt: Date,
  eventSeq: number = Math.floor(Math.random() * 1_000_000_000),
): Promise<void> {
  await uow
    .insertInto('platform_event_consumer_failures')
    .values({
      consumer_name: name,
      event_seq: eventSeq,
      event_id: toBin(freshUuid()),
      event_type: 'test.skipped_event',
      error_message: 'Erreur de test avec une donnée personnelle : 699000000',
      attempts: 5,
      failed_at: failedAt,
    })
    .execute();
}

const ours = <T extends { readonly consumerName: string }>(alarms: readonly T[]): readonly T[] =>
  alarms.filter((alarm) => alarm.consumerName.startsWith('test.cf.'));

describe('CONSUMER_FAILED : consommateur d’événements en échec (P9-10)', () => {
  it('les lignes réelles de la base partagée ne donnent aucune alerte à une horloge antérieure à elles', async () => {
    await rolledBack(async (uow) => {
      const outcome = await pass(uow);
      expect(outcome.alarms).toEqual([]);
      expect(outcome.published).toBe(0);
      // Beaucoup de consommateurs de test sont enregistrés dans la base partagée : ils sont tous examinés.
      expect(outcome.examined).toBeGreaterThan(0);
      expect(outcome).toMatchObject({ lagThresholdSeconds: 300, windowHours: 24 });
    });
  });

  it('retard : strictement au-delà de 300 s, mesuré à l’âge du plus ancien événement en attente', async () => {
    await rolledBack(async (uow) => {
      const over = await lagging(uow, secondsBefore(301));
      const edge = await lagging(uow, secondsBefore(300));
      const justUnder = await lagging(uow, new Date(secondsBefore(300).getTime() + 1));
      const fresh = await lagging(uow, secondsBefore(5));
      const outcome = await pass(uow);
      expect(ours(outcome.alarms)).toEqual([
        { consumerName: over, failedEvents: 0, lagSeconds: 301 },
      ]);
      // La passe examine toutes les positions de la base partagée : un consommateur réel déjà à la tête du flux
      // voit l'événement de ce test en attente depuis 301 s et compte aussi. Seuls les sujets du test se comptent.
      expect(outcome.published).toBeGreaterThanOrEqual(1);
      expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(over))).toHaveLength(1);
      for (const quiet of [edge, justUnder, fresh]) {
        expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(quiet))).toEqual([]);
      }
    });
  });

  it('le retard est celui du premier événement non traité, non d’un événement plus récent', async () => {
    await rolledBack(async (uow) => {
      const oldSeq = await eventAt(uow, secondsBefore(1000));
      const recentSeq = await eventAt(uow, secondsBefore(10));
      // Position avant le plus ancien : en retard de 1000 s. Position après lui : seul le récent attend.
      const behind = await consumer(uow, oldSeq - 1);
      const caughtUp = await consumer(uow, oldSeq);
      // Position au-delà de tout événement : rien n'attend.
      const idle = await consumer(uow, recentSeq + 1_000_000);
      const outcome = await pass(uow);
      expect(ours(outcome.alarms)).toEqual([
        { consumerName: behind, failedEvents: 0, lagSeconds: 1000 },
      ]);
      for (const quiet of [caughtUp, idle]) {
        expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(quiet))).toEqual([]);
      }
    });
  });

  it('événement sauté : un seul dans la fenêtre suffit, même sans retard', async () => {
    await rolledBack(async (uow) => {
      const name = await consumer(uow, 999_999_999_999);
      await skipped(uow, name, hoursBefore(2));
      await skipped(uow, name, hoursBefore(1));
      const outcome = await pass(uow);
      expect(ours(outcome.alarms)).toEqual([
        { consumerName: name, failedEvents: 2, lagSeconds: 0 },
      ]);
      const [event] = await eventsOf(uow, 'ConsumerFailureDetected', subject(name));
      expect(event!.producerModule).toBe('communication');
      expect(event!.aggregateType).toBe('EVENT_CONSUMER');
      expect(event!.occurredAt.toISOString()).toBe(NOW.toISOString());
      expect(event!.payload).toMatchObject({
        consumer_name: name,
        failed_events: 2,
        lag_seconds: 0,
        last_seq: 999_999_999_999,
        last_failed_at: hoursBefore(1).toISOString(),
        threshold_seconds: 300,
        window_hours: 24,
        business_day: TODAY,
        pass_id: expect.stringContaining('CONSUMER_FAILED'),
      });
      // Ni le message d'erreur ni le type de l'événement sauté : données possiblement personnelles (ADR-061 §4).
      const serialized = JSON.stringify(event!.payload);
      expect(serialized).not.toContain('699000000');
      expect(serialized).not.toContain('test.skipped_event');
    });
  });

  it('fenêtre des sauts : deux bornes, réglable', async () => {
    await rolledBack(async (uow) => {
      const edge = await consumer(uow, 999_999_999_999);
      await skipped(uow, edge, hoursBefore(24));
      const inside = await consumer(uow, 999_999_999_999);
      await skipped(uow, inside, new Date(hoursBefore(24).getTime() + 1));
      const atNow = await consumer(uow, 999_999_999_999);
      await skipped(uow, atNow, NOW);
      const future = await consumer(uow, 999_999_999_999);
      await skipped(uow, future, new Date(NOW.getTime() + 1));
      const old = await consumer(uow, 999_999_999_999);
      await skipped(uow, old, hoursBefore(30));

      const first = await pass(uow);
      expect(
        ours(first.alarms)
          .map((alarm) => alarm.consumerName)
          .sort(),
      ).toEqual([atNow, inside].sort());

      settingsOverride.set('communication.consumer_failure_window_hours', 48);
      const wide = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(wide.windowHours).toBe(48);
      expect(
        ours(wide.alarms)
          .map((alarm) => alarm.consumerName)
          .sort(),
      ).toEqual([atNow, edge, inside, old].sort());
      expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(future))).toEqual([]);
    });
  });

  it('le seuil de retard se règle (communication.consumer_lag_alert_seconds)', async () => {
    await rolledBack(async (uow) => {
      const name = await lagging(uow, secondsBefore(120));
      expect(ours((await pass(uow)).alarms)).toEqual([]);
      settingsOverride.set('communication.consumer_lag_alert_seconds', 60);
      const tight = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(tight.lagThresholdSeconds).toBe(60);
      expect(ours(tight.alarms)).toEqual([
        { consumerName: name, failedEvents: 0, lagSeconds: 120 },
      ]);
    });
  });

  it('retard et sauts à la fois : une seule alerte avec les deux mesures', async () => {
    await rolledBack(async (uow) => {
      const name = await lagging(uow, secondsBefore(900));
      await skipped(uow, name, hoursBefore(3));
      const outcome = await pass(uow);
      expect(ours(outcome.alarms)).toEqual([
        { consumerName: name, failedEvents: 1, lagSeconds: 900 },
      ]);
      expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(name))).toHaveLength(1);
    });
  });

  it('le marqueur de fin de passe est publié toujours ; le rejeu du créneau ne duplique rien', async () => {
    await rolledBack(async (uow) => {
      const name = await lagging(uow, secondsBefore(900));
      expect((await pass(uow)).published).toBeGreaterThanOrEqual(1);
      // Le rejeu du créneau est reconnu : rien de plus n'est publié, pour aucun consommateur.
      expect((await pass(uow)).published).toBe(0);
      expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(name))).toHaveLength(1);
      const markers = await markersOf(uow, 'CONSUMER_FAILED');
      expect(markers).toHaveLength(1);
      expect(markers[0]!.producerModule).toBe('communication');
      expect(markers[0]!.payload).toMatchObject({
        alert_type: 'CONSUMER_FAILED',
        business_day: TODAY,
      });
    });
  });

  it('le gestionnaire enregistré exécute la passe sans lever, même consommateur en échec', async () => {
    const registry = new JobHandlerRegistry();
    new ConsumerFailureJob(clock, idGenerator, registry).onModuleInit();
    const handler = registry.resolve(CONSUMER_FAILURE_JOB_TYPE);
    expect(handler).toBeDefined();
    await rolledBack(async (uow) => {
      const name = await lagging(uow, secondsBefore(900));
      await expect(handler!(uow, { scheduledFor: SLOT })).resolves.toBeUndefined();
      expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(name))).toHaveLength(1);
      expect(await markersOf(uow, 'CONSUMER_FAILED')).toHaveLength(1);
    });
  });

  it('la tâche est planifiée toutes les cinq minutes', () => {
    const registry = new RecurringJobRegistry();
    new CommunicationRecurringJobs(registry).onModuleInit();
    expect(registry.list()).toEqual(COMMUNICATION_RECURRING_JOBS);
    expect(registry.get(CONSUMER_FAILURE_JOB_TYPE)?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 300,
    });
  });

  it('bout en bout : alerte d’état levée à l’administrateur, puis fermée par le marqueur quand le retard est résorbé', async () => {
    await rolledBack(async (uow) => {
      const name = await lagging(uow, secondsBefore(900));
      await skipped(uow, name, hoursBefore(3));
      await pass(uow);
      const [event] = await eventsOf(uow, 'ConsumerFailureDetected', subject(name));
      await handleAlertEvent(uow, event!, { idGenerator });
      const dedupKey = `CONSUMER_FAILED:EVENT_CONSUMER:${name.toLowerCase()}`;
      const alertOf = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['severity', 'status', 'nature', 'title', 'message', 'owner_user_id'])
          .where('dedup_key', '=', dedupKey)
          .executeTakeFirstOrThrow();
      const opened = await alertOf();
      expect(opened).toMatchObject({
        severity: 'WARNING',
        status: 'OPEN',
        nature: 'STATE',
        title: "Consommateur d'événements en échec",
        owner_user_id: null,
      });
      expect(opened.message).toContain(`Consommateur : ${name}`);
      expect(opened.message).toContain('Événements sautés : 1');
      expect(opened.message).toContain('Retard (s) : 900');

      // Le consommateur a rattrapé son retard, mais l'événement sauté reste dans la fenêtre : toujours signalé.
      await uow
        .updateTable('platform_event_consumer_offsets')
        .set({ last_seq: 999_999_999_999 })
        .where('consumer_name', '=', name)
        .execute();
      const laterAt = new Date(NOW.getTime() + 60_000);
      const laterSlot = laterAt.toISOString();
      await runConsumerFailureCheck(
        uow,
        { clock: new FixedClock(laterAt), idGenerator },
        { scheduledFor: laterSlot },
      );
      const stillRaised = await eventsOf(uow, 'ConsumerFailureDetected', subject(name));
      expect(stillRaised).toHaveLength(2);
      expect(stillRaised[1]!.payload).toMatchObject({ failed_events: 1, lag_seconds: 0 });
      await handleAlertEvent(uow, stillRaised[1]!, { idGenerator });
      const [marker] = await markersOf(uow, 'CONSUMER_FAILED', laterSlot);
      await handleAlertEvent(uow, marker!, { idGenerator });
      expect((await alertOf()).status).toBe('OPEN');

      // Les sauts sortent de la fenêtre (25 h plus tard) : plus rien à signaler, le marqueur ferme l'alerte.
      const muchLaterAt = new Date(NOW.getTime() + 25 * 3_600_000);
      const muchLaterSlot = muchLaterAt.toISOString();
      await runConsumerFailureCheck(
        uow,
        { clock: new FixedClock(muchLaterAt), idGenerator },
        { scheduledFor: muchLaterSlot },
      );
      expect(await eventsOf(uow, 'ConsumerFailureDetected', subject(name))).toHaveLength(2);
      const [closing] = await markersOf(uow, 'CONSUMER_FAILED', muchLaterSlot);
      await handleAlertEvent(uow, closing!, { idGenerator });
      expect((await alertOf()).status).toBe('RESOLVED');
    });
  });
});

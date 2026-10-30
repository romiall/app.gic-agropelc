/**
 * P9-27 : alerte `JOB_FAILED` (D13 §7.1, ADR-061, ADR-062, AV-469 choix (b)) — `communication.jobs.failure_check`
 * publie un `JobFailureDetected` par type de tâche ayant des tâches `FAILED` dans la fenêtre
 * `platform.failed_jobs_window_hours`, puis le marqueur de passe. La passe lit toute la table des tâches de la base
 * partagée : horloge dans le passé lointain (2019), si bien que ses lignes réelles (postérieures) restent hors de la
 * fenêtre ; les tâches de chaque cas sont insérées dans la transaction annulée du test, aux dates voulues, sous un
 * type propre à l'exécution.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/organization/application/public/index.js', async (importActual) => {
  const actual = (await importActual()) as {
    currentSettingValue: (...args: unknown[]) => Promise<unknown>;
  };
  return { ...actual, currentSettingValue: vi.fn(actual.currentSettingValue) };
});

import { sql } from 'kysely';
import { FixedClock } from '@gic/domain';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { RecurringJobRegistry } from '../src/platform/jobs/recurring-job-registry.js';
import { readFailedJobsByType } from '../src/platform/jobs/job-status.js';
import {
  JOB_FAILURE_JOB_TYPE,
  JobFailureJob,
  runJobFailureCheck,
} from '../src/modules/communication/application/jobs/job-failure-job.js';
import {
  COMMUNICATION_RECURRING_JOBS,
  CommunicationRecurringJobs,
} from '../src/modules/communication/application/jobs/communication-recurring-jobs.js';
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

const ERROR_TEXT = 'Erreur de test avec une donnée personnelle : 699000000';

const pass = (uow: UnitOfWork, at: string = SLOT) =>
  runJobFailureCheck(uow, deps, { scheduledFor: at });
const subject = (jobType: string) => compositeSubjectId('JOB_FAILED', { job_type: jobType });
const freshType = () => `test.jf.${freshUuid().slice(-12)}`;
const ours = <T extends { readonly jobType: string }>(rows: readonly T[]): readonly T[] =>
  rows.filter((row) => row.jobType.startsWith('test.jf.'));

/** Tâche du type, au statut voulu, dont le dernier essai a eu lieu à `runAt`. */
async function job(
  uow: UnitOfWork,
  jobType: string,
  runAt: Date,
  status: 'PENDING' | 'DONE' | 'FAILED' = 'FAILED',
): Promise<void> {
  await uow
    .insertInto('platform_jobs')
    .values({
      id: toBin(freshUuid()),
      job_type: jobType,
      payload: jsonValue({}),
      status,
      run_at: runAt,
      attempts: status === 'PENDING' ? 0 : status === 'FAILED' ? 5 : 1,
      max_attempts: 5,
      last_error: status === 'FAILED' ? ERROR_TEXT : null,
      completed_at: status === 'DONE' ? runAt : null,
    })
    .execute();
}

/** La règle du type est semée par `db:seed` : une base seulement migrée la reçoit ici, dans la transaction. */
async function ensureJobFailedRule(uow: UnitOfWork): Promise<void> {
  await sql`
    INSERT INTO communication_alert_rules (alert_type, severity, recipient_roles, resolution_mode)
    VALUES ('JOB_FAILED', 'WARNING', JSON_ARRAY('ADMIN'), 'AUTO')
    ON DUPLICATE KEY UPDATE alert_type = alert_type
  `.execute(uow);
}

describe('readFailedJobsByType : tâches FAILED de la fenêtre, par type (P9-27)', () => {
  it('regroupe par type, compte les FAILED seules, borne la fenêtre des deux côtés', async () => {
    await rolledBack(async (uow) => {
      const a = freshType();
      const b = freshType();
      await job(uow, a, hoursBefore(2));
      await job(uow, a, hoursBefore(1));
      await job(uow, b, hoursBefore(3));
      // Hors compte : tâches en attente ou terminées, échec antérieur à la fenêtre ou postérieur à l'instant.
      await job(uow, b, hoursBefore(1), 'PENDING');
      await job(uow, b, hoursBefore(1), 'DONE');
      await job(uow, b, hoursBefore(24));
      await job(uow, b, hoursBefore(30));
      await job(uow, b, new Date(NOW.getTime() + 1));
      const rows = await readFailedJobsByType(uow, { now: NOW, failedSince: hoursBefore(24) });
      // Ordre : nom de type croissant (les noms de test sont aléatoires, l'attendu est trié de même).
      const expected = [
        { jobType: a, failedJobs: 2, lastFailedAt: hoursBefore(1) },
        { jobType: b, failedJobs: 1, lastFailedAt: hoursBefore(3) },
      ].sort((x, y) => (x.jobType < y.jobType ? -1 : 1));
      expect(ours(rows)).toEqual(expected);
    });
  });
});

describe('JOB_FAILED : tâche de fond en échec (P9-27, AV-469)', () => {
  it('les lignes réelles de la base partagée ne donnent aucune alerte à une horloge antérieure à elles', async () => {
    await rolledBack(async (uow) => {
      const outcome = await pass(uow);
      expect(ours(outcome.failing)).toEqual([]);
      expect(outcome.windowHours).toBe(24);
    });
  });

  it('un événement par type de tâche en échec, avec le nombre d’échecs, sans message d’erreur', async () => {
    await rolledBack(async (uow) => {
      const a = freshType();
      const b = freshType();
      const healthy = freshType();
      await job(uow, a, hoursBefore(2));
      await job(uow, a, hoursBefore(1));
      await job(uow, b, hoursBefore(5));
      await job(uow, healthy, hoursBefore(1), 'DONE');
      await job(uow, healthy, hoursBefore(1), 'PENDING');

      const outcome = await pass(uow);
      const counts = new Map(
        ours(outcome.failing).map((entry): [string, number] => [entry.jobType, entry.failedJobs]),
      );
      expect(counts).toEqual(
        new Map([
          [a, 2],
          [b, 1],
        ]),
      );
      expect(outcome.published).toBeGreaterThanOrEqual(2);
      expect(await eventsOf(uow, 'JobFailureDetected', subject(healthy))).toEqual([]);

      const [event] = await eventsOf(uow, 'JobFailureDetected', subject(a));
      expect(event!.producerModule).toBe('communication');
      expect(event!.aggregateType).toBe('JOB_TYPE');
      expect(event!.occurredAt.toISOString()).toBe(NOW.toISOString());
      expect(event!.payload).toMatchObject({
        job_type: a,
        failed_jobs: 2,
        last_failed_at: hoursBefore(1).toISOString(),
        window_hours: 24,
        business_day: TODAY,
        pass_id: expect.stringContaining('JOB_FAILED'),
      });
      // Ni le message d'erreur ni la charge utile des tâches : valeurs possiblement personnelles (ADR-061 §4).
      expect(JSON.stringify(event!.payload)).not.toContain('699000000');
      expect(await eventsOf(uow, 'JobFailureDetected', subject(b))).toHaveLength(1);
    });
  });

  it('fenêtre : deux bornes, réglable (platform.failed_jobs_window_hours)', async () => {
    await rolledBack(async (uow) => {
      const edge = freshType();
      const inside = freshType();
      const old = freshType();
      const future = freshType();
      await job(uow, edge, hoursBefore(24));
      await job(uow, inside, new Date(hoursBefore(24).getTime() + 1));
      await job(uow, old, hoursBefore(30));
      await job(uow, future, new Date(NOW.getTime() + 1));

      const first = await pass(uow);
      expect(ours(first.failing).map((entry) => entry.jobType)).toEqual([inside]);

      settingsOverride.set('platform.failed_jobs_window_hours', 48);
      const wide = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(wide.windowHours).toBe(48);
      expect(
        ours(wide.failing)
          .map((entry) => entry.jobType)
          .sort(),
      ).toEqual([edge, inside, old].sort());
      expect(await eventsOf(uow, 'JobFailureDetected', subject(future))).toEqual([]);

      // Réglage invalide : repli sur 24 h.
      settingsOverride.set('platform.failed_jobs_window_hours', -5);
      expect((await pass(uow, '2019-03-12T10:10:00.000Z')).windowHours).toBe(24);
    });
  });

  it('le marqueur de fin de passe est publié toujours ; le rejeu du créneau ne duplique rien', async () => {
    await rolledBack(async (uow) => {
      const type = freshType();
      await job(uow, type, hoursBefore(1));
      expect((await pass(uow)).published).toBeGreaterThanOrEqual(1);
      expect((await pass(uow)).published).toBe(0);
      expect(await eventsOf(uow, 'JobFailureDetected', subject(type))).toHaveLength(1);
      const markers = await markersOf(uow, 'JOB_FAILED');
      expect(markers).toHaveLength(1);
      expect(markers[0]!.producerModule).toBe('communication');
      expect(markers[0]!.payload).toMatchObject({ alert_type: 'JOB_FAILED', business_day: TODAY });
    });
  });

  it('le gestionnaire enregistré exécute la passe sans lever, même avec une tâche en échec', async () => {
    const registry = new JobHandlerRegistry();
    new JobFailureJob(clock, idGenerator, registry).onModuleInit();
    const handler = registry.resolve(JOB_FAILURE_JOB_TYPE);
    expect(handler).toBeDefined();
    await rolledBack(async (uow) => {
      const type = freshType();
      await job(uow, type, hoursBefore(1));
      await expect(handler!(uow, { scheduledFor: SLOT })).resolves.toBeUndefined();
      expect(await eventsOf(uow, 'JobFailureDetected', subject(type))).toHaveLength(1);
      expect(await markersOf(uow, 'JOB_FAILED')).toHaveLength(1);
    });
  });

  it('la tâche est planifiée toutes les cinq minutes', () => {
    const registry = new RecurringJobRegistry();
    new CommunicationRecurringJobs(registry).onModuleInit();
    expect(registry.list()).toEqual(COMMUNICATION_RECURRING_JOBS);
    expect(registry.get(JOB_FAILURE_JOB_TYPE)?.schedule).toEqual({
      kind: 'INTERVAL',
      intervalSeconds: 300,
    });
  });

  it('bout en bout : une alerte par type, levée à l’Admin, dédoublonnée, fermée seule quand le type n’échoue plus', async () => {
    await rolledBack(async (uow) => {
      await ensureJobFailedRule(uow);
      const a = freshType();
      const b = freshType();
      await job(uow, a, hoursBefore(1));
      await job(uow, a, hoursBefore(2));
      await job(uow, b, hoursBefore(2));
      // Nouvel échec de B 22 h après l'instant de la première passe : visible de la seconde seulement.
      await job(uow, b, new Date(NOW.getTime() + 22 * 3_600_000));

      await pass(uow);
      for (const type of [a, b]) {
        const [event] = await eventsOf(uow, 'JobFailureDetected', subject(type));
        await handleAlertEvent(uow, event!, { idGenerator });
      }
      const alertOf = (type: string) =>
        uow
          .selectFrom('communication_alerts')
          .select([
            'severity',
            'status',
            'nature',
            'title',
            'message',
            'action_screen',
            'owner_user_id',
          ])
          .where('dedup_key', '=', `JOB_FAILED:JOB_TYPE:${type.toLowerCase()}`)
          .executeTakeFirstOrThrow();
      const opened = await alertOf(a);
      expect(opened).toMatchObject({
        severity: 'WARNING',
        status: 'OPEN',
        nature: 'STATE',
        title: 'Tâche de fond en échec',
        action_screen: null,
        owner_user_id: null,
      });
      expect(opened.message).toContain(`Tâche : ${a}`);
      expect(opened.message).toContain('Échecs : 2');
      expect(opened.message).not.toContain('699000000');
      expect((await alertOf(b)).status).toBe('OPEN');

      // 23 h plus tard : A (dernier échec à H-1) sort de la fenêtre, B a un échec récent.
      const laterAt = new Date(NOW.getTime() + 23 * 3_600_000);
      const laterSlot = laterAt.toISOString();
      const later = await runJobFailureCheck(
        uow,
        { clock: new FixedClock(laterAt), idGenerator },
        { scheduledFor: laterSlot },
      );
      expect(
        ours(later.failing).map((entry) => ({
          jobType: entry.jobType,
          failedJobs: entry.failedJobs,
        })),
      ).toEqual([{ jobType: b, failedJobs: 1 }]);
      const [again] = (await eventsOf(uow, 'JobFailureDetected', subject(b))).slice(-1);
      await handleAlertEvent(uow, again!, { idGenerator });
      const [marker] = await markersOf(uow, 'JOB_FAILED', laterSlot);
      await handleAlertEvent(uow, marker!, { idGenerator });

      // B reste ouverte (revue par la passe), A est fermée par le marqueur ; une seule alerte par type.
      expect((await alertOf(a)).status).toBe('RESOLVED');
      expect((await alertOf(b)).status).toBe('OPEN');
      const countOfB = await uow
        .selectFrom('communication_alerts')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .where('dedup_key', '=', `JOB_FAILED:JOB_TYPE:${b.toLowerCase()}`)
        .executeTakeFirstOrThrow();
      expect(Number(countOfB.n)).toBe(1);
    });
  });
});

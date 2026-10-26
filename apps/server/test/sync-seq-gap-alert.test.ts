/**
 * P9-10 : alerte `DEVICE_SEQ_GAP` (D13 §7.1, BR-SYN-003, AV-423) — `sync.devices.seq_gap_check` publie un
 * `DeviceSequenceGapDetected` par appareil actif dont un trou de `device_seq` reste ouvert depuis plus de
 * `sync.seq_gap_alert_hours` heures sans être expliqué par les restes déclarés de l'appareil ; les plages déjà
 * signalées sont mémorisées dans `known_gaps`. Horloge dans le passé lointain (2019), transactions annulées.
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
  DEVICE_SEQ_GAP_JOB_TYPE,
  DeviceSeqGapAlertJob,
  runDeviceSeqGapCheck,
} from '../src/sync/jobs/device-seq-gap-alert-job.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, insertTestUser } from './helpers.js';
import {
  NOW,
  SLOT,
  TODAY,
  clock,
  deps,
  device,
  eventsOf,
  hoursBefore,
  idGenerator,
  inboxRow,
  syncState,
  world,
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

const pass = (uow: UnitOfWork, at: string = SLOT) =>
  runDeviceSeqGapCheck(uow, deps, { scheduledFor: at });
const gapsOf = (uow: UnitOfWork, deviceId: string) =>
  eventsOf(uow, 'DeviceSequenceGapDetected', deviceId);

/** Reçoit les numéros donnés, chacun à `hours` heures avant l'horloge. */
async function receive(
  uow: UnitOfWork,
  deviceId: string,
  userId: string,
  seqs: readonly number[],
  hours: number,
): Promise<void> {
  for (const seq of seqs) {
    await inboxRow(uow, { deviceId, userId, seq, receivedAt: hoursBefore(hours) });
  }
}

async function knownGaps(uow: UnitOfWork, deviceId: string): Promise<unknown> {
  const row = await uow
    .selectFrom('sync_device_sync_state')
    .select('known_gaps')
    .where('device_id', '=', toBin(deviceId))
    .where('dataset', '=', '_device')
    .executeTakeFirst();
  return row?.known_gaps ?? null;
}

describe('DEVICE_SEQ_GAP : trou de séquence non comblé (P9-10)', () => {
  it('un trou ouvert depuis plus de 24 h : un événement avec la plage, le total et la date d’ouverture', async () => {
    await rolledBack(async (uow) => {
      const { admin, siteId } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin, { label: 'Tablette Akwa', siteId });
      // 1 à 3 reçus, 4 et 5 manquants, 6 et 7 reçus il y a 30 h ; 8 et 9 manquants, 10 reçu il y a 10 h.
      await receive(uow, tablet.id, user, [1, 2, 3], 40);
      await receive(uow, tablet.id, user, [6, 7], 30);
      await receive(uow, tablet.id, user, [10], 10);
      await syncState(uow, tablet.id, { lastPushAt: hoursBefore(10), pendingReported: 0 });

      const outcome = await pass(uow);
      // Les appareils des autres suites ont aussi des trous, mais récents par rapport à cette horloge de 2019.
      expect(outcome).toMatchObject({ unexplained: 1, published: 1, hours: 24 });
      expect(outcome.incomplete).toBeGreaterThanOrEqual(1);
      const [event] = await gapsOf(uow, tablet.id);
      expect(event!.producerModule).toBe('sync');
      expect(event!.aggregateType).toBe('DEVICE');
      expect(event!.occurredAt.toISOString()).toBe(NOW.toISOString());
      expect(event!.payload).toMatchObject({
        device_id: tablet.id,
        device_label: 'Tablette Akwa',
        missing_from: 4,
        missing_to: 5,
        // Le trou {8, 9} n'est visible que depuis 10 h : pas encore signalé.
        gaps_count: 1,
        missing_count: 2,
        new_ranges: [[4, 5]],
        opened_at: hoursBefore(30).toISOString(),
        pending_reported: 0,
        threshold_hours: 24,
        site_id: siteId,
        business_day: TODAY,
        pass_id: expect.stringContaining('DEVICE_SEQ_GAP'),
      });
      expect(event!.payload).not.toHaveProperty('user_id');
      expect(await knownGaps(uow, tablet.id)).toEqual([[4, 5]]);
    });
  });

  it('le trou est ouvert depuis la première commande de numéro supérieur reçue, même arrivée en désordre', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await receive(uow, tablet.id, user, [1, 2, 3], 50);
      // 8 reçu il y a 26 h, 6 et 7 il y a 5 h : le trou {4, 5} est visible depuis 26 h.
      await receive(uow, tablet.id, user, [8], 26);
      await receive(uow, tablet.id, user, [6, 7], 5);
      await syncState(uow, tablet.id, { pendingReported: 0 });
      await pass(uow);
      const [event] = await gapsOf(uow, tablet.id);
      expect(event!.payload).toMatchObject({
        missing_from: 4,
        missing_to: 5,
        opened_at: hoursBefore(26).toISOString(),
      });
    });
  });

  it('borne : 24 h pile ne suffit pas, 24 h et une milliseconde oui ; le délai se règle', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const edge = await device(uow, admin);
      await receive(uow, edge.id, user, [1], 60);
      await inboxRow(uow, { deviceId: edge.id, userId: user, seq: 3, receivedAt: hoursBefore(24) });
      const over = await device(uow, admin);
      await receive(uow, over.id, user, [1], 60);
      await inboxRow(uow, {
        deviceId: over.id,
        userId: user,
        seq: 3,
        receivedAt: new Date(hoursBefore(24).getTime() - 1),
      });
      await syncState(uow, edge.id, { pendingReported: 0 });
      await syncState(uow, over.id, { pendingReported: 0 });
      await pass(uow);
      expect(await gapsOf(uow, edge.id)).toEqual([]);
      expect(await gapsOf(uow, over.id)).toHaveLength(1);

      settingsOverride.set('sync.seq_gap_alert_hours', 12);
      const outcome = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(outcome.hours).toBe(12);
      expect(await gapsOf(uow, edge.id)).toHaveLength(1);
    });
  });

  it('un trou au début de la suite (numéros 1 et 2 jamais reçus) est un trou', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await receive(uow, tablet.id, user, [3, 4], 40);
      await syncState(uow, tablet.id, { pendingReported: 0 });
      await pass(uow);
      const [event] = await gapsOf(uow, tablet.id);
      expect(event!.payload).toMatchObject({ missing_from: 1, missing_to: 2, missing_count: 2 });
    });
  });

  it('une suite complète ou sans numéro (en ligne) ne signale rien', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const complete = await device(uow, admin);
      await receive(uow, complete.id, user, [1, 2, 3, 4], 90);
      const online = await device(uow, admin);
      await inboxRow(uow, {
        deviceId: online.id,
        userId: user,
        transport: 'ONLINE_API',
        receivedAt: hoursBefore(90),
      });
      await inboxRow(uow, {
        deviceId: online.id,
        userId: user,
        transport: 'ONLINE_API',
        receivedAt: hoursBefore(90),
      });
      await pass(uow);
      expect(await gapsOf(uow, complete.id)).toEqual([]);
      expect(await gapsOf(uow, online.id)).toEqual([]);
    });
  });

  it('les restes déclarés expliquent les numéros manquants : commandes encore dans l’outbox, non perdues', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const make = async (pending: number | null) => {
        const tablet = await device(uow, admin);
        await receive(uow, tablet.id, user, [1, 2], 90);
        await receive(uow, tablet.id, user, [6], 50);
        // 3, 4 et 5 manquants : trois commandes.
        await syncState(uow, tablet.id, { pendingReported: pending });
        return tablet;
      };
      const covered = await make(3);
      const surplus = await make(10);
      const short = await make(2);
      const none = await make(0);
      const undeclared = await make(null);
      await pass(uow);
      expect(await gapsOf(uow, covered.id)).toEqual([]);
      expect(await gapsOf(uow, surplus.id)).toEqual([]);
      expect(await gapsOf(uow, short.id)).toHaveLength(1);
      expect(await gapsOf(uow, none.id)).toHaveLength(1);
      // Sans déclaration, rien n'est supposé.
      expect(await gapsOf(uow, undeclared.id)).toHaveLength(1);
      expect(await knownGaps(uow, covered.id)).toBeNull();
    });
  });

  it('une plage déjà signalée ne l’est plus ; une plage nouvelle l’est, la mémoire garde les deux', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await receive(uow, tablet.id, user, [1, 2, 3], 80);
      await receive(uow, tablet.id, user, [6], 60);
      await syncState(uow, tablet.id, { pendingReported: 0 });

      expect((await pass(uow)).published).toBe(1);
      expect(await knownGaps(uow, tablet.id)).toEqual([[4, 5]]);
      // Aucune nouvelle plage : rien de plus, même à une autre passe.
      expect((await pass(uow, '2019-03-12T10:05:00.000Z')).published).toBe(0);
      expect(await gapsOf(uow, tablet.id)).toHaveLength(1);

      // Un deuxième trou {8} devient ancien : signalé seul, la première plage reste mémorisée.
      await receive(uow, tablet.id, user, [7], 45);
      await receive(uow, tablet.id, user, [9], 40);
      expect((await pass(uow, '2019-03-12T10:10:00.000Z')).published).toBe(1);
      const events = await gapsOf(uow, tablet.id);
      expect(events).toHaveLength(2);
      expect(events[1]!.payload).toMatchObject({
        missing_from: 8,
        missing_to: 8,
        new_ranges: [[8, 8]],
        gaps_count: 2,
        missing_count: 3,
      });
      expect(await knownGaps(uow, tablet.id)).toEqual([
        [4, 5],
        [8, 8],
      ]);
    });
  });

  it('un trou comblé efface la mémoire ; il peut être signalé de nouveau s’il se rouvre', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await receive(uow, tablet.id, user, [1, 2, 3], 80);
      await receive(uow, tablet.id, user, [6], 60);
      await syncState(uow, tablet.id, { pendingReported: 0 });
      await pass(uow);
      expect(await knownGaps(uow, tablet.id)).toEqual([[4, 5]]);

      // Les commandes en retard arrivent : la suite est complète.
      await receive(uow, tablet.id, user, [4, 5], 1);
      const filled = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(filled.published).toBe(0);
      expect(await knownGaps(uow, tablet.id)).toBeNull();
    });
  });

  it('un trou réduit par une commande tardive n’est pas un nouveau trou ; comblé, il sort de la mémoire', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await receive(uow, tablet.id, user, [1, 2, 3], 80);
      await receive(uow, tablet.id, user, [6], 60);
      await syncState(uow, tablet.id, { pendingReported: 0 });
      expect((await pass(uow)).published).toBe(1);
      expect(await knownGaps(uow, tablet.id)).toEqual([[4, 5]]);

      // Le numéro 4 arrive : il ne manque plus que le 5. Le trou {5} est contenu dans la plage déjà signalée.
      await receive(uow, tablet.id, user, [4], 1);
      const shrunk = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(shrunk).toMatchObject({ unexplained: 1, published: 0 });
      expect(await gapsOf(uow, tablet.id)).toHaveLength(1);
      expect(await knownGaps(uow, tablet.id)).toEqual([[4, 5]]);

      // Le numéro 5 arrive : la suite est complète, la mémoire est effacée.
      await receive(uow, tablet.id, user, [5], 1);
      expect((await pass(uow, '2019-03-12T10:10:00.000Z')).published).toBe(0);
      expect(await knownGaps(uow, tablet.id)).toBeNull();
    });
  });

  it('les restes déclarés qui oscillent ne font pas renaître l’alerte d’une plage déjà signalée', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await receive(uow, tablet.id, user, [1, 2, 3], 80);
      await receive(uow, tablet.id, user, [6], 60);
      await syncState(uow, tablet.id, { pendingReported: 0 });
      expect((await pass(uow)).published).toBe(1);

      // L'appareil accumule du travail hors ligne : ses restes déclarés couvrent désormais les 2 manquants.
      const setPending = async (pending: number) => {
        await uow
          .updateTable('sync_device_sync_state')
          .set({ pending_reported: pending })
          .where('device_id', '=', toBin(tablet.id))
          .where('dataset', '=', '_device')
          .execute();
      };
      await setPending(10);
      const explained = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(explained).toMatchObject({ unexplained: 0, published: 0 });
      // La mémoire garde la plage : elle manque toujours, seul l'explication a changé.
      expect(await knownGaps(uow, tablet.id)).toEqual([[4, 5]]);

      // Les restes retombent à zéro (l'outbox est vidée) : la plage est de nouveau sans explication, mais déjà
      // signalée — l'alerte, peut-être déjà traitée par un administrateur, ne renaît pas.
      await setPending(0);
      const back = await pass(uow, '2019-03-12T10:10:00.000Z');
      expect(back).toMatchObject({ unexplained: 1, published: 0 });
      expect(await gapsOf(uow, tablet.id)).toHaveLength(1);
    });
  });

  it('les commandes en ligne (sans device_seq) ne masquent pas un trou de la suite envoyée', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      // 1 et 3 reçus par /sync/push : le 2 manque. Deux commandes en ligne (sans numéro) portent le nombre de
      // lignes de la boîte à 4, au-delà du plus grand numéro (3) : le comptage ne doit pas s'y laisser prendre.
      await receive(uow, tablet.id, user, [1, 3], 60);
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        transport: 'ONLINE_API',
        receivedAt: hoursBefore(60),
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        transport: 'ONLINE_API',
        receivedAt: hoursBefore(59),
      });
      await syncState(uow, tablet.id, { pendingReported: 0 });
      await pass(uow);
      const [event] = await gapsOf(uow, tablet.id);
      expect(event!.payload).toMatchObject({ missing_from: 2, missing_to: 2, missing_count: 1 });
    });
  });

  it('seuls les appareils actifs sont signalés', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const ids: string[] = [];
      for (const status of ['BLOCKED', 'LOST', 'RETIRED'] as const) {
        const hidden = await device(uow, admin, { status });
        await receive(uow, hidden.id, user, [1, 5], 80);
        await syncState(uow, hidden.id, { pendingReported: 0 });
        ids.push(hidden.id);
      }
      const outcome = await pass(uow);
      for (const id of ids) expect(await gapsOf(uow, id)).toEqual([]);
      // Les trois appareils hors service comptent parmi les incomplets mais ne sont pas relus.
      expect(outcome.incomplete - outcome.examined).toBeGreaterThanOrEqual(3);
    });
  });

  it('plusieurs appareils : chacun son événement et sa mémoire', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const a = await device(uow, admin);
      const b = await device(uow, admin);
      await receive(uow, a.id, user, [1, 4], 80);
      await receive(uow, b.id, user, [1, 2, 7], 80);
      await syncState(uow, a.id, { pendingReported: 0 });
      await syncState(uow, b.id, { pendingReported: 0 });
      const outcome = await pass(uow);
      // La passe balaie tous les appareils de la base partagée : seuls les deux de ce test sont tenus (les
      // totaux globaux ne le sont pas), chacun ayant son propre événement ci-dessous.
      expect(outcome.unexplained).toBeGreaterThanOrEqual(2);
      expect(outcome.published).toBeGreaterThanOrEqual(2);
      expect(outcome.examined).toBeGreaterThanOrEqual(2);
      // Les appareils incomplets comptent aussi ceux qui ne sont plus en service, jamais relus.
      expect(outcome.incomplete).toBeGreaterThanOrEqual(outcome.examined);
      const [first] = await gapsOf(uow, a.id);
      const [second] = await gapsOf(uow, b.id);
      expect(first!.payload).toMatchObject({ missing_from: 2, missing_to: 3 });
      expect(second!.payload).toMatchObject({ missing_from: 3, missing_to: 6, missing_count: 4 });
      expect(await knownGaps(uow, a.id)).toEqual([[2, 3]]);
      expect(await knownGaps(uow, b.id)).toEqual([[3, 6]]);
    });
  });

  it('le gestionnaire enregistré exécute la passe sans lever', async () => {
    const registry = new JobHandlerRegistry();
    new DeviceSeqGapAlertJob(clock, idGenerator, registry).onModuleInit();
    const handler = registry.resolve(DEVICE_SEQ_GAP_JOB_TYPE);
    expect(handler).toBeDefined();
    await rolledBack(async (uow) => {
      await expect(handler!(uow, { scheduledFor: SLOT })).resolves.toBeUndefined();
    });
  });

  it('bout en bout : alerte critique levée aux administrateurs, une occurrence de plus à chaque nouvelle plage', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin, { label: 'Tablette Akwa' });
      await receive(uow, tablet.id, user, [1, 2, 3], 80);
      await receive(uow, tablet.id, user, [6], 60);
      await syncState(uow, tablet.id, { pendingReported: 0 });
      await pass(uow);
      const [event] = await gapsOf(uow, tablet.id);
      await handleAlertEvent(uow, event!, { idGenerator });
      const alertOf = () =>
        uow
          .selectFrom('communication_alerts')
          .select([
            'severity',
            'status',
            'nature',
            'title',
            'message',
            'occurrences',
            'critical_since',
          ])
          .where('alert_type', '=', 'DEVICE_SEQ_GAP')
          .where('subject_id', '=', toBin(tablet.id))
          .executeTakeFirstOrThrow();
      const opened = await alertOf();
      expect(opened).toMatchObject({
        severity: 'CRITICAL',
        status: 'OPEN',
        nature: 'EVENT',
        title: 'Trou de séquence non comblé',
        occurrences: 1,
      });
      expect(opened.critical_since).not.toBeNull();
      expect(opened.message).toContain('Appareil : Tablette Akwa');
      expect(opened.message).toContain('Première séquence manquante : 4');
      expect(opened.message).toContain('Dernière séquence manquante : 5');

      // Une nouvelle plage ancienne : le même sujet reçoit une occurrence de plus.
      await receive(uow, tablet.id, user, [7], 50);
      await receive(uow, tablet.id, user, [9], 45);
      const laterAt = new Date(NOW.getTime() + 1_000);
      await runDeviceSeqGapCheck(
        uow,
        { clock: new FixedClock(laterAt), idGenerator },
        { scheduledFor: laterAt.toISOString() },
      );
      const events = await gapsOf(uow, tablet.id);
      expect(events).toHaveLength(2);
      await handleAlertEvent(uow, events[1]!, { idGenerator });
      expect((await alertOf()).occurrences).toBe(2);
    });
  });
});

/**
 * P9-10 : alerte `CLOCK_SKEW` (D13 §7.1, BR-SYN-011, AV-216, AV-474) — `sync.devices.clock_skew_check` publie
 * un `ClockSkewDetected` par appareil actif dont le dernier envoi accusait un écart d'horloge au-delà de
 * `sync.clock_skew_flag_minutes`, puis le marqueur de passe. Horloge dans le passé lointain (2019),
 * transactions annulées.
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
  DEVICE_CLOCK_SKEW_JOB_TYPE,
  DeviceClockSkewAlertJob,
  runDeviceClockSkewCheck,
} from '../src/sync/jobs/device-clock-skew-alert-job.js';
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
  markersOf,
  syncState,
  world,
} from './sync-alert-test-kit.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const MINUTE_MS = 60_000;

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
  runDeviceClockSkewCheck(uow, deps, { scheduledFor: at });
const skewOf = (uow: UnitOfWork, deviceId: string) => eventsOf(uow, 'ClockSkewDetected', deviceId);

describe('CLOCK_SKEW : horloge d’appareil décalée (P9-10)', () => {
  it('écart au-delà du seuil : un événement avec l’écart signé en minutes, le seuil et le dernier auteur', async () => {
    await rolledBack(async (uow) => {
      const { admin, siteId } = await world(uow);
      const early = await insertTestUser(uow);
      const late = await insertTestUser(uow);
      const tablet = await device(uow, admin, { label: 'Tablette Akwa', siteId });
      await syncState(uow, tablet.id, {
        lastPushAt: hoursBefore(2),
        lastClockSkewMs: 7 * MINUTE_MS,
      });
      await syncState(uow, tablet.id, { authorId: early, lastPushAt: hoursBefore(5) });
      await syncState(uow, tablet.id, { authorId: late, lastPushAt: hoursBefore(2) });
      const fast = await device(uow, admin);
      await syncState(uow, fast.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: -9 * MINUTE_MS,
      });

      const outcome = await pass(uow);
      expect(outcome).toMatchObject({ skewed: 2, published: 2, thresholdMinutes: 5 });
      const [event] = await skewOf(uow, tablet.id);
      expect(event!.producerModule).toBe('sync');
      expect(event!.aggregateType).toBe('DEVICE');
      expect(event!.occurredAt.toISOString()).toBe(NOW.toISOString());
      expect(event!.payload).toMatchObject({
        device_id: tablet.id,
        device_label: 'Tablette Akwa',
        // Heure du serveur moins celle de l'appareil : positif, l'appareil est en retard.
        skew_minutes: 7,
        threshold_minutes: 5,
        last_push_at: hoursBefore(2).toISOString(),
        user_id: late,
        site_id: siteId,
        business_day: TODAY,
        pass_id: expect.stringContaining('CLOCK_SKEW'),
      });
      const [ahead] = await skewOf(uow, fast.id);
      expect(ahead!.payload).toMatchObject({ skew_minutes: -9 });
      expect(ahead!.payload).not.toHaveProperty('user_id');
    });
  });

  it('le seuil est strict : exactement 5 minutes n’alerte pas, 5 minutes et une milliseconde oui', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const edge = await device(uow, admin);
      await syncState(uow, edge.id, { lastPushAt: hoursBefore(1), lastClockSkewMs: 5 * MINUTE_MS });
      const over = await device(uow, admin);
      await syncState(uow, over.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: 5 * MINUTE_MS + 1,
      });
      const ahead = await device(uow, admin);
      await syncState(uow, ahead.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: -(5 * MINUTE_MS + 1),
      });
      const zero = await device(uow, admin);
      await syncState(uow, zero.id, { lastPushAt: hoursBefore(1), lastClockSkewMs: 0 });
      await pass(uow);
      expect(await skewOf(uow, edge.id)).toEqual([]);
      expect(await skewOf(uow, zero.id)).toEqual([]);
      expect(await skewOf(uow, over.id)).toHaveLength(1);
      expect(await skewOf(uow, ahead.id)).toHaveLength(1);
    });
  });

  it('le seuil se règle (sync.clock_skew_flag_minutes) ; une valeur absurde retombe sur 5 minutes', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const tablet = await device(uow, admin);
      await syncState(uow, tablet.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: 7 * MINUTE_MS,
      });
      settingsOverride.set('sync.clock_skew_flag_minutes', 10);
      const wide = await pass(uow);
      expect(wide).toMatchObject({ skewed: 0, thresholdMinutes: 10 });
      expect(await skewOf(uow, tablet.id)).toEqual([]);

      settingsOverride.set('sync.clock_skew_flag_minutes', -3);
      const fallback = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(fallback).toMatchObject({ thresholdMinutes: 5 });
      expect(await skewOf(uow, tablet.id)).toHaveLength(1);
    });
  });

  it('écart de 5 min 0,4 s : arrondi à la minute supérieure ; le seuil est publié tel que réglé, fractionnaire compris', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const tablet = await device(uow, admin);
      await syncState(uow, tablet.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: 5 * MINUTE_MS + 400,
      });
      await pass(uow);
      const [event] = await skewOf(uow, tablet.id);
      // 300 400 ms dépasse 300 000 ms : l'écart ne s'affiche pas « 5 » pour un seuil de 5.
      expect(event!.payload).toMatchObject({ skew_minutes: 6, threshold_minutes: 5 });

      settingsOverride.set('sync.clock_skew_flag_minutes', 5.5);
      const fractional = await device(uow, admin);
      await syncState(uow, fractional.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: 336_000,
      });
      await pass(uow, '2019-03-12T10:05:00.000Z');
      const [other] = await skewOf(uow, fractional.id);
      expect(other!.payload).toMatchObject({ skew_minutes: 6, threshold_minutes: 5.5 });
    });
  });

  it('fenêtre : seul un envoi des sync.stale_hours dernières heures est examiné', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const recent = await device(uow, admin);
      await syncState(uow, recent.id, {
        lastPushAt: hoursBefore(23),
        lastClockSkewMs: 9 * MINUTE_MS,
      });
      const edge = await device(uow, admin);
      await syncState(uow, edge.id, {
        lastPushAt: hoursBefore(24),
        lastClockSkewMs: 9 * MINUTE_MS,
      });
      const old = await device(uow, admin);
      await syncState(uow, old.id, { lastPushAt: hoursBefore(30), lastClockSkewMs: 9 * MINUTE_MS });
      const future = await device(uow, admin);
      await syncState(uow, future.id, {
        lastPushAt: new Date(NOW.getTime() + 1),
        lastClockSkewMs: 9 * MINUTE_MS,
      });
      const undeclared = await device(uow, admin);
      await syncState(uow, undeclared.id, { lastPushAt: hoursBefore(1) });
      // Dernier envoi à l'instant même de la passe : dans la fenêtre (borne haute comprise).
      const atNow = await device(uow, admin);
      await syncState(uow, atNow.id, { lastPushAt: NOW, lastClockSkewMs: 9 * MINUTE_MS });
      const first = await pass(uow);
      // Seuls les envois à écart déclaré dans la fenêtre sont examinés : `recent` et `atNow`.
      expect(first).toMatchObject({ examined: 2, skewed: 2, published: 2 });
      expect(await skewOf(uow, recent.id)).toHaveLength(1);
      expect(await skewOf(uow, atNow.id)).toHaveLength(1);
      expect(await skewOf(uow, edge.id)).toEqual([]);
      expect(await skewOf(uow, old.id)).toEqual([]);
      expect(await skewOf(uow, future.id)).toEqual([]);
      expect(await skewOf(uow, undeclared.id)).toEqual([]);

      settingsOverride.set('sync.stale_hours', 48);
      await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(await skewOf(uow, old.id)).toHaveLength(1);
    });
  });

  it('seuls les appareils actifs sont examinés', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const ids: string[] = [];
      for (const status of ['BLOCKED', 'LOST', 'RETIRED'] as const) {
        const hidden = await device(uow, admin, { status });
        await syncState(uow, hidden.id, {
          lastPushAt: hoursBefore(1),
          lastClockSkewMs: 9 * MINUTE_MS,
        });
        ids.push(hidden.id);
      }
      await pass(uow);
      for (const id of ids) expect(await skewOf(uow, id)).toEqual([]);
    });
  });

  it('le marqueur de fin de passe est publié toujours ; le rejeu ne duplique rien', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const tablet = await device(uow, admin);
      await syncState(uow, tablet.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: 9 * MINUTE_MS,
      });
      expect((await pass(uow)).published).toBe(1);
      expect((await pass(uow)).published).toBe(0);
      expect(await skewOf(uow, tablet.id)).toHaveLength(1);
      const markers = await markersOf(uow, 'CLOCK_SKEW');
      expect(markers).toHaveLength(1);
      expect(markers[0]!.payload).toMatchObject({ alert_type: 'CLOCK_SKEW', business_day: TODAY });
    });
  });

  it('le gestionnaire enregistré exécute la passe sans lever', async () => {
    const registry = new JobHandlerRegistry();
    new DeviceClockSkewAlertJob(clock, idGenerator, registry).onModuleInit();
    const handler = registry.resolve(DEVICE_CLOCK_SKEW_JOB_TYPE);
    expect(handler).toBeDefined();
    await rolledBack(async (uow) => {
      await expect(handler!(uow, { scheduledFor: SLOT })).resolves.toBeUndefined();
      expect(await markersOf(uow, 'CLOCK_SKEW')).toHaveLength(1);
    });
  });

  it('bout en bout : alerte levée, puis fermée quand l’appareil est remis à l’heure', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin, { label: 'Tablette Akwa' });
      await syncState(uow, tablet.id, {
        lastPushAt: hoursBefore(1),
        lastClockSkewMs: 9 * MINUTE_MS,
      });
      await syncState(uow, tablet.id, { authorId: user, lastPushAt: hoursBefore(1) });
      await pass(uow);
      const [event] = await skewOf(uow, tablet.id);
      await handleAlertEvent(uow, event!, { idGenerator });
      const alertOf = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['severity', 'status', 'nature', 'title', 'message'])
          .where('alert_type', '=', 'CLOCK_SKEW')
          .where('subject_id', '=', toBin(tablet.id))
          .executeTakeFirstOrThrow();
      const opened = await alertOf();
      expect(opened).toMatchObject({
        severity: 'WARNING',
        status: 'OPEN',
        nature: 'STATE',
        title: "Horloge d'appareil décalée",
      });
      expect(opened.message).toContain('Appareil : Tablette Akwa');
      expect(opened.message).toContain('Écart (minutes) : 9');

      // L'appareil est remis à l'heure : son envoi suivant accuse un écart dans la tolérance.
      await uow
        .updateTable('sync_device_sync_state')
        .set({ last_clock_skew_ms: 2_000, last_push_at: new Date(NOW.getTime() + 30_000) })
        .where('device_id', '=', toBin(tablet.id))
        .where('dataset', '=', '_device')
        .execute();
      const laterAt = new Date(NOW.getTime() + 60_000);
      const slot = laterAt.toISOString();
      await runDeviceClockSkewCheck(
        uow,
        { clock: new FixedClock(laterAt), idGenerator },
        { scheduledFor: slot },
      );
      const [marker] = await markersOf(uow, 'CLOCK_SKEW', slot);
      await handleAlertEvent(uow, marker!, { idGenerator });
      expect((await alertOf()).status).toBe('RESOLVED');
    });
  });
});

/**
 * P9-10 : alerte `SYNC_STALE` (D13 §7.1, AV-472) — `sync.devices.stale_check` publie un `DeviceSyncStale` par
 * appareil actif sans synchronisation depuis plus de `sync.stale_hours` heures, puis le marqueur de passe.
 * Horloge dans le passé lointain (2019), transactions annulées : les appareils des autres suites ont une
 * activation postérieure, donc jamais « en retard ».
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
  DEVICE_STALE_ALERT_JOB_TYPE,
  DeviceStaleAlertJob,
  runDeviceStaleCheck,
} from '../src/sync/jobs/device-stale-alert-job.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb } from './helpers.js';
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
  runDeviceStaleCheck(uow, deps, { scheduledFor: at });
const staleOf = (uow: UnitOfWork, deviceId: string) => eventsOf(uow, 'DeviceSyncStale', deviceId);

describe('SYNC_STALE : appareil actif sans synchronisation (P9-10)', () => {
  it('plus de 24 h sans contact : un événement avec les heures écoulées, le titulaire et le site', async () => {
    await rolledBack(async (uow) => {
      const { admin, siteId } = await world(uow);
      const tablet = await device(uow, admin, { label: 'Tablette Akwa', siteId, shared: true });
      await syncState(uow, tablet.id, { lastPushAt: hoursBefore(26) });

      const outcome = await pass(uow);
      expect(outcome).toMatchObject({ stale: 1, published: 1, staleHours: 24, horizonDays: 30 });
      const [event] = await staleOf(uow, tablet.id);
      expect(event!.producerModule).toBe('sync');
      expect(event!.aggregateType).toBe('DEVICE');
      expect(event!.occurredAt.toISOString()).toBe(NOW.toISOString());
      expect(event!.payload).toMatchObject({
        device_id: tablet.id,
        device_label: 'Tablette Akwa',
        last_sync_at: hoursBefore(26).toISOString(),
        hours_since: 26,
        threshold_hours: 24,
        never_contacted: false,
        is_shared: true,
        // Le titulaire de l'appareil est celui qui l'a enrôlé (MP-06) ; le site est celui qui lui est désigné.
        user_id: admin,
        site_id: siteId,
        business_day: TODAY,
        pass_id: expect.stringContaining('SYNC_STALE'),
      });
      // Le silence part du dernier contact : la dernière synchronisation le dit, pas de second champ.
      expect(event!.payload).not.toHaveProperty('silent_since');
    });
  });

  it('exactement 24 h ou moins : pas encore en retard', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const atEdge = await device(uow, admin);
      await syncState(uow, atEdge.id, { lastPushAt: hoursBefore(24) });
      const justOver = await device(uow, admin);
      await syncState(uow, justOver.id, { lastPushAt: new Date(hoursBefore(24).getTime() - 1) });
      const fresh = await device(uow, admin);
      await syncState(uow, fresh.id, { lastPushAt: hoursBefore(5) });
      await pass(uow);
      expect(await staleOf(uow, atEdge.id)).toEqual([]);
      expect(await staleOf(uow, fresh.id)).toEqual([]);
      expect(await staleOf(uow, justOver.id)).toHaveLength(1);
    });
  });

  it('le dernier contact est le plus récent de la connexion, de l’envoi et du pull', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const bySeen = await device(uow, admin, { lastSeenAt: hoursBefore(3) });
      await syncState(uow, bySeen.id, { lastPushAt: hoursBefore(40), lastPullAt: hoursBefore(50) });
      const byPull = await device(uow, admin, { lastSeenAt: hoursBefore(60) });
      await syncState(uow, byPull.id, { lastPushAt: hoursBefore(40), lastPullAt: hoursBefore(2) });
      const byPush = await device(uow, admin);
      await syncState(uow, byPush.id, { lastPushAt: hoursBefore(1), lastPullAt: hoursBefore(70) });
      const none = await device(uow, admin, { lastSeenAt: hoursBefore(30) });
      await syncState(uow, none.id, { lastPushAt: hoursBefore(35), lastPullAt: hoursBefore(31) });
      await pass(uow);
      expect(await staleOf(uow, bySeen.id)).toEqual([]);
      expect(await staleOf(uow, byPull.id)).toEqual([]);
      expect(await staleOf(uow, byPush.id)).toEqual([]);
      const [event] = await staleOf(uow, none.id);
      expect(event!.payload).toMatchObject({
        last_sync_at: hoursBefore(30).toISOString(),
        hours_since: 30,
      });
    });
  });

  it('appareil jamais contacté : compté depuis son activation, pas dès l’approbation', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const justApproved = await device(uow, admin, { activatedAt: hoursBefore(1) });
      const old = await device(uow, admin, { activatedAt: hoursBefore(25) });
      const reactivated = await device(uow, admin, {
        activatedAt: hoursBefore(2),
        lastSeenAt: hoursBefore(100),
      });
      await pass(uow);
      expect(await staleOf(uow, justApproved.id)).toEqual([]);
      expect(await staleOf(uow, reactivated.id)).toEqual([]);
      const [event] = await staleOf(uow, old.id);
      expect(event!.payload).toMatchObject({
        never_contacted: true,
        silent_since: hoursBefore(25).toISOString(),
        hours_since: 25,
      });
      // Aucune « dernière synchronisation » : la date de l'activation n'en est pas une.
      expect(event!.payload).not.toHaveProperty('last_sync_at');
    });
  });

  it('appareil réactivé après un ancien contact : la dernière synchronisation reste le dernier contact, le silence part de la réactivation', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const reactivated = await device(uow, admin, {
        activatedAt: hoursBefore(30),
        lastSeenAt: hoursBefore(100),
      });
      await pass(uow);
      const [event] = await staleOf(uow, reactivated.id);
      expect(event!.payload).toMatchObject({
        never_contacted: false,
        last_sync_at: hoursBefore(100).toISOString(),
        silent_since: hoursBefore(30).toISOString(),
        hours_since: 30,
      });
    });
  });

  it('seuls les appareils actifs sont suivis', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const ids: string[] = [];
      for (const status of ['BLOCKED', 'LOST', 'RETIRED', 'PENDING'] as const) {
        const silent = await device(uow, admin, { status, activatedAt: hoursBefore(100) });
        ids.push(silent.id);
      }
      await pass(uow);
      for (const id of ids) expect(await staleOf(uow, id)).toEqual([]);
    });
  });

  it('horizon d’oubli : au-delà de 30 jours de silence l’appareil n’est plus signalé ; 0 supprime l’horizon', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const recent = await device(uow, admin, { activatedAt: hoursBefore(29 * 24) });
      const abandoned = await device(uow, admin, { activatedAt: hoursBefore(31 * 24) });
      await pass(uow);
      expect(await staleOf(uow, recent.id)).toHaveLength(1);
      expect(await staleOf(uow, abandoned.id)).toEqual([]);

      settingsOverride.set('sync.stale_horizon_days', 0);
      await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(await staleOf(uow, abandoned.id)).toHaveLength(1);

      settingsOverride.set('sync.stale_horizon_days', 7);
      await pass(uow, '2019-03-12T10:10:00.000Z');
      expect(await staleOf(uow, recent.id)).toHaveLength(2); // 29 jours > 7 jours : plus signalé, donc inchangé
    });
  });

  it('le délai se règle (sync.stale_hours)', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const tablet = await device(uow, admin);
      await syncState(uow, tablet.id, { lastPushAt: hoursBefore(10) });
      await pass(uow);
      expect(await staleOf(uow, tablet.id)).toEqual([]);
      settingsOverride.set('sync.stale_hours', 6);
      const outcome = await pass(uow, '2019-03-12T10:05:00.000Z');
      expect(outcome.staleHours).toBe(6);
      expect(await staleOf(uow, tablet.id)).toHaveLength(1);
    });
  });

  it('le marqueur de fin de passe est publié toujours ; le rejeu ne duplique rien', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const tablet = await device(uow, admin, { activatedAt: hoursBefore(30) });
      expect((await pass(uow)).published).toBe(1);
      expect((await pass(uow)).published).toBe(0);
      expect(await staleOf(uow, tablet.id)).toHaveLength(1);
      const markers = await markersOf(uow, 'SYNC_STALE');
      expect(markers).toHaveLength(1);
      expect(markers[0]!.payload).toMatchObject({ alert_type: 'SYNC_STALE', business_day: TODAY });
    });
  });

  it('le gestionnaire enregistré exécute la passe sans lever', async () => {
    const registry = new JobHandlerRegistry();
    new DeviceStaleAlertJob(clock, idGenerator, registry).onModuleInit();
    const handler = registry.resolve(DEVICE_STALE_ALERT_JOB_TYPE);
    expect(handler).toBeDefined();
    await rolledBack(async (uow) => {
      await expect(handler!(uow, { scheduledFor: SLOT })).resolves.toBeUndefined();
      expect(await markersOf(uow, 'SYNC_STALE')).toHaveLength(1);
    });
  });

  it('bout en bout : alerte levée au propriétaire de l’appareil, fermée quand l’appareil se synchronise', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const tablet = await device(uow, admin, {
        label: 'Tablette Akwa',
        activatedAt: hoursBefore(48),
      });
      await syncState(uow, tablet.id, { lastPushAt: hoursBefore(30) });
      await pass(uow);
      const [event] = await staleOf(uow, tablet.id);
      await handleAlertEvent(uow, event!, { idGenerator });
      const alertOf = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['severity', 'status', 'nature', 'title', 'message', 'owner_user_id'])
          .where('alert_type', '=', 'SYNC_STALE')
          .where('subject_id', '=', toBin(tablet.id))
          .executeTakeFirstOrThrow();
      const opened = await alertOf();
      expect(opened).toMatchObject({
        severity: 'WARNING',
        status: 'OPEN',
        nature: 'STATE',
        title: 'Appareil sans synchronisation',
      });
      expect(opened.message).toContain('Appareil : Tablette Akwa');
      expect(opened.message).toContain('Heures : 30');

      // L'appareil se synchronise : la passe suivante ne le republie pas et son marqueur ferme l'alerte.
      await uow
        .updateTable('sync_device_sync_state')
        .set({ last_push_at: hoursBefore(0.5) })
        .where('device_id', '=', toBin(tablet.id))
        .execute();
      const laterAt = new Date(NOW.getTime() + 60_000);
      const slot = laterAt.toISOString();
      await runDeviceStaleCheck(
        uow,
        { clock: new FixedClock(laterAt), idGenerator },
        { scheduledFor: slot },
      );
      const [marker] = await markersOf(uow, 'SYNC_STALE', slot);
      await handleAlertEvent(uow, marker!, { idGenerator });
      expect((await alertOf()).status).toBe('RESOLVED');
    });
  });
});

/**
 * P9-10 : alerte `SYNC_ERROR` (D13 §7.1, AV-442, AV-471) — `sync.errors.alert_check` publie un
 * `SyncErrorDetected` par couple (appareil, code d'erreur) puis le marqueur de passe. Les passes lisent la
 * base partagée : horloge dans le passé lointain (2019), transactions annulées, lignes insérées directement.
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
  SYNC_ERROR_ALERT_JOB_TYPE,
  SyncErrorAlertJob,
  runSyncErrorCheck,
} from '../src/sync/jobs/sync-error-alert-job.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, insertTestUser } from './helpers.js';
import {
  NOW,
  SLOT,
  TODAY,
  clock,
  conflictOf,
  deps,
  device,
  eventsOf,
  hoursBefore,
  idGenerator,
  inboxRow,
  markersOf,
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

const subject = (deviceId: string, code: string) =>
  compositeSubjectId('SYNC_ERROR', { device_id: deviceId, error_code: code });
const pass = (uow: UnitOfWork) => runSyncErrorCheck(uow, deps, { scheduledFor: SLOT });

describe('SYNC_ERROR : erreurs de synchronisation par appareil et par code (P9-10)', () => {
  it('un événement par couple appareil × code, avec le nombre d’occurrences et le dernier auteur', async () => {
    await rolledBack(async (uow) => {
      const { admin, siteId } = await world(uow);
      const first = await insertTestUser(uow);
      const second = await insertTestUser(uow);
      const tablet = await device(uow, admin, { label: 'Tablette Akwa', siteId });
      const other = await device(uow, admin, { label: 'Téléphone Bonabéri' });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: first,
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        receivedAt: hoursBefore(5),
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: second,
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        receivedAt: hoursBefore(2),
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: first,
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        receivedAt: hoursBefore(8),
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: first,
        status: 'CONFLICT',
        errorCode: 'DEVICE_REVOKED',
        receivedAt: hoursBefore(3),
      });
      await inboxRow(uow, {
        deviceId: other.id,
        userId: first,
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        receivedAt: hoursBefore(1),
      });

      const outcome = await pass(uow);
      expect(outcome).toEqual({ groups: 3, published: 3, windowHours: 24 });

      const [forbidden] = await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'FORBIDDEN'));
      expect(forbidden!.producerModule).toBe('sync');
      expect(forbidden!.aggregateType).toBe('DEVICE_ERROR');
      expect(forbidden!.occurredAt.toISOString()).toBe(NOW.toISOString());
      expect(forbidden!.payload).toMatchObject({
        device_id: tablet.id,
        error_code: 'FORBIDDEN',
        device_label: 'Tablette Akwa',
        occurrences: 3,
        // Le dernier rejet du couple est celui de l'utilisateur `second` (il y a 2 h).
        user_id: second,
        first_at: hoursBefore(8).toISOString(),
        last_at: hoursBefore(2).toISOString(),
        window_hours: 24,
        business_day: TODAY,
        site_id: siteId,
        pass_id: expect.stringContaining('SYNC_ERROR'),
      });
      const [revoked] = await eventsOf(
        uow,
        'SyncErrorDetected',
        subject(tablet.id, 'DEVICE_REVOKED'),
      );
      expect(revoked!.payload).toMatchObject({ occurrences: 1, user_id: first });
      const [elsewhere] = await eventsOf(uow, 'SyncErrorDetected', subject(other.id, 'FORBIDDEN'));
      expect(elsewhere!.payload).toMatchObject({
        device_label: 'Téléphone Bonabéri',
        occurrences: 1,
      });
      expect(elsewhere!.payload).not.toHaveProperty('site_id');
      // Ni message d'erreur ni charge utile de commande dans l'événement (ADR-071 §4).
      expect(JSON.stringify(forbidden!.payload)).not.toMatch(
        /error_message|command_type|"payload"/,
      );
    });
  });

  it('un code détaillé est ramené à sa famille', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      for (const code of [
        'VALIDATION_ERROR:quantity',
        'VALIDATION_ERROR:price',
        'VALIDATION_ERROR',
      ]) {
        await inboxRow(uow, {
          deviceId: tablet.id,
          userId: user,
          status: 'REJECTED',
          errorCode: code,
          receivedAt: hoursBefore(1),
        });
      }
      const outcome = await pass(uow);
      expect(outcome.groups).toBe(1);
      const [event] = await eventsOf(
        uow,
        'SyncErrorDetected',
        subject(tablet.id, 'VALIDATION_ERROR'),
      );
      expect(event!.payload).toMatchObject({ error_code: 'VALIDATION_ERROR', occurrences: 3 });
    });
  });

  it('codes exclus : par défaut la décision de l’Admin et la conséquence d’un autre rejet ; réglable', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      for (const code of ['COMMAND_DISCARDED', 'DEPENDENCY_REJECTED', 'FORBIDDEN']) {
        await inboxRow(uow, {
          deviceId: tablet.id,
          userId: user,
          status: 'REJECTED',
          errorCode: code,
          receivedAt: hoursBefore(1),
        });
      }
      expect((await pass(uow)).groups).toBe(1);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'COMMAND_DISCARDED')),
      ).toEqual([]);

      // Liste vide : plus rien n'est exclu (autre créneau, pour une identité de passe distincte).
      settingsOverride.set('sync.error_alert_excluded_codes', []);
      const all = await runSyncErrorCheck(uow, deps, { scheduledFor: '2019-03-12T10:05:00.000Z' });
      expect(all.groups).toBe(3);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'COMMAND_DISCARDED')),
      ).toHaveLength(1);

      settingsOverride.set('sync.error_alert_excluded_codes', ['FORBIDDEN']);
      const forbiddenOnly = await runSyncErrorCheck(uow, deps, {
        scheduledFor: '2019-03-12T10:10:00.000Z',
      });
      expect(forbiddenOnly.groups).toBe(2);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'FORBIDDEN')),
      ).toHaveLength(2);
    });
  });

  it('fenêtre à deux bornes : exactement 24 h exclu, le futur exclu ; réglable', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'AT_EDGE',
        receivedAt: hoursBefore(24),
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'JUST_INSIDE',
        receivedAt: new Date(hoursBefore(24).getTime() + 1),
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'AT_NOW',
        receivedAt: NOW,
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'FUTURE',
        receivedAt: new Date(NOW.getTime() + 1),
      });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'ABOUT_TWO_DAYS',
        receivedAt: hoursBefore(47),
      });
      const outcome = await pass(uow);
      expect(outcome.groups).toBe(2);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'JUST_INSIDE')),
      ).toHaveLength(1);
      expect(await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'AT_NOW'))).toHaveLength(
        1,
      );
      expect(await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'AT_EDGE'))).toEqual([]);
      expect(await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'FUTURE'))).toEqual([]);

      // Fenêtre élargie à 48 h : l'erreur de 47 h et celle de 24 h pile y entrent.
      settingsOverride.set('sync.error_alert_window_hours', 48);
      const wide = await runSyncErrorCheck(uow, deps, { scheduledFor: '2019-03-12T10:05:00.000Z' });
      expect(wide).toMatchObject({ groups: 4, windowHours: 48 });
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'ABOUT_TWO_DAYS')),
      ).toHaveLength(1);
    });
  });

  it('conflits de gestionnaire : mêmes bornes de fenêtre et même périmètre de transport que les rejets', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      const conflict = async (
        type: string,
        receivedAt: Date,
        transport: 'SYNC_PUSH' | 'ONLINE_API' | 'SYSTEM' = 'SYNC_PUSH',
      ) => {
        const commandId = await inboxRow(uow, {
          deviceId: tablet.id,
          userId: user,
          status: 'CONFLICT',
          receivedAt,
          transport,
        });
        await conflictOf(uow, commandId, type);
      };
      await conflict('AT_EDGE_CONFLICT', hoursBefore(24));
      await conflict('JUST_INSIDE_CONFLICT', new Date(hoursBefore(24).getTime() + 1));
      await conflict('AT_NOW_CONFLICT', NOW);
      await conflict('FUTURE_CONFLICT', new Date(NOW.getTime() + 1));
      await conflict('ONLINE_CONFLICT', hoursBefore(1), 'ONLINE_API');
      await conflict('SYSTEM_CONFLICT', hoursBefore(1), 'SYSTEM');

      expect((await pass(uow)).groups).toBe(2);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'JUST_INSIDE_CONFLICT')),
      ).toHaveLength(1);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'AT_NOW_CONFLICT')),
      ).toHaveLength(1);
      for (const excluded of [
        'AT_EDGE_CONFLICT',
        'FUTURE_CONFLICT',
        'ONLINE_CONFLICT',
        'SYSTEM_CONFLICT',
      ]) {
        expect(await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, excluded))).toEqual([]);
      }
    });
  });

  it('une commande refusée avec un code propre n’est comptée que sous ce code, même avec un conflit rattaché', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      const commandId = await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'CONFLICT',
        errorCode: 'DEVICE_REVOKED',
        receivedAt: hoursBefore(1),
      });
      await conflictOf(uow, commandId, 'STOCK_NEGATIVE');
      expect((await pass(uow)).groups).toBe(1);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'DEVICE_REVOKED')),
      ).toHaveLength(1);
      expect(
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'STOCK_NEGATIVE')),
      ).toEqual([]);
    });
  });

  it('seules les commandes rejetées ou en conflit reçues par /sync/push comptent', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      const common = {
        deviceId: tablet.id,
        userId: user,
        receivedAt: hoursBefore(1),
        errorCode: 'FORBIDDEN',
      };
      await inboxRow(uow, { ...common, status: 'APPLIED' });
      await inboxRow(uow, { ...common, status: 'FAILED_RETRYABLE' });
      await inboxRow(uow, { ...common, status: 'RECEIVED' });
      await inboxRow(uow, { ...common, status: 'REJECTED', transport: 'ONLINE_API' });
      await inboxRow(uow, { ...common, status: 'REJECTED', transport: 'SYSTEM' });
      expect((await pass(uow)).groups).toBe(0);
      await inboxRow(uow, { ...common, status: 'REJECTED' });
      expect(
        (await runSyncErrorCheck(uow, deps, { scheduledFor: '2019-03-12T10:05:00.000Z' })).groups,
      ).toBe(1);
    });
  });

  it('un conflit de gestionnaire prend le type de son conflit ouvert ; refermé, il ne compte plus', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      const open = await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'CONFLICT',
        receivedAt: hoursBefore(2),
      });
      await conflictOf(uow, open, 'STOCK_NEGATIVE');
      const closed = await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'CONFLICT',
        receivedAt: hoursBefore(2),
      });
      await conflictOf(uow, closed, 'LOT_CLOSED', { closed: true, resolvedBy: admin });
      // Deux conflits du même type sur une même commande : une seule occurrence.
      const twice = await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'CONFLICT',
        receivedAt: hoursBefore(1),
      });
      await conflictOf(uow, twice, 'STOCK_NEGATIVE');
      await conflictOf(uow, twice, 'STOCK_NEGATIVE');
      // Un conflit sans conflit rattaché : aucune cause à signaler.
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'CONFLICT',
        receivedAt: hoursBefore(1),
      });

      const outcome = await pass(uow);
      expect(outcome.groups).toBe(1);
      const [event] = await eventsOf(
        uow,
        'SyncErrorDetected',
        subject(tablet.id, 'STOCK_NEGATIVE'),
      );
      expect(event!.payload).toMatchObject({ error_code: 'STOCK_NEGATIVE', occurrences: 2 });
      expect(await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'LOT_CLOSED'))).toEqual(
        [],
      );
    });
  });

  it('le marqueur de fin de passe est publié toujours, même sans erreur ; le rejeu ne duplique rien', async () => {
    await rolledBack(async (uow) => {
      expect(await pass(uow)).toEqual({ groups: 0, published: 0, windowHours: 24 });
      const markers = await markersOf(uow, 'SYNC_ERROR');
      expect(markers).toHaveLength(1);
      expect(markers[0]!.producerModule).toBe('sync');
      expect(markers[0]!.payload).toMatchObject({ alert_type: 'SYNC_ERROR', business_day: TODAY });

      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        receivedAt: hoursBefore(1),
      });
      const replay = await pass(uow);
      expect(replay.published).toBeGreaterThanOrEqual(1);
      const again = await pass(uow);
      expect(again.published).toBe(0);
      expect(await markersOf(uow, 'SYNC_ERROR')).toHaveLength(1);
    });
  });

  it('le gestionnaire enregistré exécute la passe sans lever', async () => {
    const registry = new JobHandlerRegistry();
    new SyncErrorAlertJob(clock, idGenerator, registry).onModuleInit();
    const handler = registry.resolve(SYNC_ERROR_ALERT_JOB_TYPE);
    expect(handler).toBeDefined();
    await rolledBack(async (uow) => {
      await expect(handler!(uow, { scheduledFor: SLOT })).resolves.toBeUndefined();
      expect(await markersOf(uow, 'SYNC_ERROR')).toHaveLength(1);
    });
  });

  it('bout en bout : alerte d’état levée, puis fermée par le marqueur quand l’erreur sort de la fenêtre', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin, { label: 'Tablette Akwa' });
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        receivedAt: hoursBefore(20),
      });
      await pass(uow);
      const [event] = await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'FORBIDDEN'));
      await handleAlertEvent(uow, event!, { idGenerator });
      const alertOf = () =>
        uow
          .selectFrom('communication_alerts')
          .select(['severity', 'status', 'nature', 'title', 'message', 'dedup_key'])
          .where('alert_type', '=', 'SYNC_ERROR')
          .where('owner_user_id', '=', toBin(user))
          .executeTakeFirstOrThrow();
      const opened = await alertOf();
      expect(opened).toMatchObject({
        severity: 'WARNING',
        status: 'OPEN',
        nature: 'STATE',
        title: 'Erreurs de synchronisation',
      });
      expect(opened.message).toContain('Appareil : Tablette Akwa');
      expect(opened.message).toContain('Code : FORBIDDEN');
      expect(opened.message).toContain('Occurrences : 1');

      // Dix heures plus tard, l'erreur (30 h) sort de la fenêtre : la passe ne republie plus le couple et son
      // marqueur ferme l'alerte.
      const laterAt = new Date(NOW.getTime() + 10 * 3_600_000);
      const slot = laterAt.toISOString();
      await runSyncErrorCheck(
        uow,
        { clock: new FixedClock(laterAt), idGenerator },
        { scheduledFor: slot },
      );
      const [marker] = await markersOf(uow, 'SYNC_ERROR', slot);
      await handleAlertEvent(uow, marker!, { idGenerator });
      expect((await alertOf()).status).toBe('RESOLVED');
    });
  });

  it('une erreur encore dans la fenêtre garde l’alerte ouverte au marqueur suivant', async () => {
    await rolledBack(async (uow) => {
      const { admin } = await world(uow);
      const user = await insertTestUser(uow);
      const tablet = await device(uow, admin);
      await inboxRow(uow, {
        deviceId: tablet.id,
        userId: user,
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        receivedAt: hoursBefore(20),
      });
      await pass(uow);
      const [event] = await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'FORBIDDEN'));
      await handleAlertEvent(uow, event!, { idGenerator });

      const laterAt = new Date(NOW.getTime() + 2 * 3_600_000); // l'erreur a 22 h
      const slot = laterAt.toISOString();
      await runSyncErrorCheck(
        uow,
        { clock: new FixedClock(laterAt), idGenerator },
        { scheduledFor: slot },
      );
      const [again] = (
        await eventsOf(uow, 'SyncErrorDetected', subject(tablet.id, 'FORBIDDEN'))
      ).slice(-1);
      await handleAlertEvent(uow, again!, { idGenerator });
      const [marker] = await markersOf(uow, 'SYNC_ERROR', slot);
      await handleAlertEvent(uow, marker!, { idGenerator });
      const alert = await uow
        .selectFrom('communication_alerts')
        .select(['status', 'occurrences'])
        .where('alert_type', '=', 'SYNC_ERROR')
        .where('owner_user_id', '=', toBin(user))
        .executeTakeFirstOrThrow();
      expect(alert).toMatchObject({ status: 'OPEN', occurrences: 2 });
    });
  });
});

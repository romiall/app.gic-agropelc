/**
 * AV-296 (b) — appareil non partagé lié au compte qui l'a connecté en premier (`findOrEnrollDevice`, réglage global
 * `identity.device_bound_to_enroller`, faux par défaut). La couche de transport lit le réglage ; la règle se teste ici
 * sans écrire de réglage global sur la base partagée (un réglage est versionné et ne se retire pas).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { findOrEnrollDevice } from '../src/modules/identity/application/auth/device-enrollment.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { closeTestDb, freshUuid, insertTestUser, withTestUow } from './helpers.js';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';

afterAll(async () => {
  await closeTestDb();
});

const NOW = new Date('2026-11-05T10:00:00.000Z');

const connect = (
  uow: UnitOfWork,
  deviceId: string,
  userId: string,
  options: { readonly bound?: boolean } = {},
) =>
  findOrEnrollDevice(uow, {
    deviceId,
    enrolledByUserId: userId,
    now: NOW,
    ...(options.bound !== undefined ? { boundToEnroller: options.bound } : {}),
  });

describe('Appareil lié au compte qui l’a connecté (AV-296, choix (b))', () => {
  it('réglage faux (défaut) : un autre compte se connecte comme avant, l’appareil garde son premier enrôleur', async () => {
    await withTestUow(async (uow) => {
      const [first, second] = [await insertTestUser(uow), await insertTestUser(uow)];
      const deviceId = freshUuid();
      expect(await connect(uow, deviceId, first)).toMatchObject({ ok: true, status: 'PENDING' });
      expect(await connect(uow, deviceId, second)).toMatchObject({ ok: true });
      expect(await connect(uow, deviceId, second, { bound: false })).toMatchObject({ ok: true });
      const row = await uow
        .selectFrom('identity_devices')
        .select('enrolled_by_user_id')
        .where('id', '=', toBin(deviceId))
        .executeTakeFirstOrThrow();
      expect(row.enrolled_by_user_id!.equals(toBin(first))).toBe(true);
    });
  });

  it('réglage vrai : un autre compte est refusé sur un appareil non partagé ; le premier compte et un appareil partagé non', async () => {
    await withTestUow(async (uow) => {
      const [first, second] = [await insertTestUser(uow), await insertTestUser(uow)];
      const deviceId = freshUuid();
      expect(await connect(uow, deviceId, first, { bound: true })).toMatchObject({ ok: true });
      expect(await connect(uow, deviceId, second, { bound: true })).toEqual({
        ok: false,
        reason: 'DEVICE_BOUND_TO_OTHER_USER',
      });
      // Le premier compte garde l'accès (reconnexion, rafraîchissement du dernier contact).
      expect(await connect(uow, deviceId, first, { bound: true })).toMatchObject({ ok: true });
      // L'Admin désigne l'appareil « partagé » (identity.device.designate) : tout compte s'y connecte.
      await uow
        .updateTable('identity_devices')
        .set({ is_shared: 1 })
        .where('id', '=', toBin(deviceId))
        .execute();
      expect(await connect(uow, deviceId, second, { bound: true })).toMatchObject({ ok: true });
    });
  });

  it('un appareil bloqué, perdu ou retiré garde son motif propre (AV-253), même pour un autre compte', async () => {
    await withTestUow(async (uow) => {
      const [first, second] = [await insertTestUser(uow), await insertTestUser(uow)];
      for (const [status, reason] of [
        ['BLOCKED', 'DEVICE_BLOCKED'],
        ['LOST', 'DEVICE_LOST'],
        ['RETIRED', 'DEVICE_RETIRED'],
      ] as const) {
        const deviceId = freshUuid();
        await connect(uow, deviceId, first, { bound: true });
        await uow
          .updateTable('identity_devices')
          .set({ status, status_reason: 'Test AV-296', status_changed_at: NOW })
          .where('id', '=', toBin(deviceId))
          .execute();
        expect(await connect(uow, deviceId, second, { bound: true }), status).toEqual({
          ok: false,
          reason,
        });
        expect(await connect(uow, deviceId, first, { bound: true }), status).toEqual({
          ok: false,
          reason,
        });
      }
    });
  });
});

describe('Appareil en attente : les approbateurs sont prévenus (AV-432)', () => {
  const eventsOf = (uow: UnitOfWork, deviceId: string) =>
    uow
      .selectFrom('platform_domain_events')
      .select(['event_type', 'producer_module', 'aggregate_type', 'payload'])
      .where('event_type', '=', 'DeviceEnrollmentRequested')
      .where('aggregate_id', '=', toBin(deviceId))
      .execute();

  it('la première connexion publie DeviceEnrollmentRequested, une seule fois par appareil', async () => {
    await withTestUow(async (uow) => {
      const [first, second] = [await insertTestUser(uow), await insertTestUser(uow)];
      const deviceId = freshUuid();
      const check = await connect(uow, deviceId, first);
      expect(check).toMatchObject({ ok: true, status: 'PENDING' });
      const events = await eventsOf(uow, deviceId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ producer_module: 'identity', aggregate_type: 'DEVICE' });
      const payload = (
        typeof events[0]!.payload === 'string' ? JSON.parse(events[0]!.payload) : events[0]!.payload
      ) as Record<string, string>;
      expect(payload).toMatchObject({
        device_id: deviceId,
        short_code: check.ok ? check.shortCode : '',
        enrolled_by_user_id: first,
      });
      // Les connexions suivantes (même compte ou un autre) retrouvent l'appareil : rien de plus n'est publié.
      await connect(uow, deviceId, first);
      await connect(uow, deviceId, second);
      expect(await eventsOf(uow, deviceId)).toHaveLength(1);
      expect(fromBin(toBin(deviceId))).toBe(deviceId);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { checkDeviceActive } from '../src/modules/identity/application/public/device-check.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { freshUuid, insertTestDevice, insertTestUser, withTestUow } from './helpers.js';

/** Période hors service close (AV-212), écrite comme le ferait `unblock` ou `retire`. */
async function insertClosedPeriod(
  trx: UnitOfWork,
  input: { deviceId: string; status: 'BLOCKED' | 'LOST'; from: string; to: string; by: string },
): Promise<void> {
  await trx
    .insertInto('identity_device_status_periods')
    .values({
      command_id: toBin(freshUuid()),
      device_id: toBin(input.deviceId),
      status: input.status,
      valid_from: new Date(input.from),
      valid_to: new Date(input.to),
      reason: 'Test',
      closed_by: toBin(input.by),
    })
    .execute();
}

const OCCURRED_AT = new Date('2026-09-24T10:00:00.000Z');

describe('checkDeviceActive (RC-02, §3.2 point 3)', () => {
  it('accepte un appareil ACTIVE', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      const result = await checkDeviceActive(trx, toBin(deviceId), OCCURRED_AT);
      expect(result).toEqual({ ok: true });
    });
  });

  it('refuse un appareil inconnu (DEVICE_REVOKED)', async () => {
    await withTestUow(async (trx) => {
      const result = await checkDeviceActive(
        trx,
        toBin('0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11'),
        OCCURRED_AT,
      );
      expect(result).toEqual({ ok: false, reason: 'DEVICE_REVOKED' });
    });
  });

  it('refuse un appareil bloqué avant occurred_at', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, admin, {
        status: 'BLOCKED',
        statusChangedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      const result = await checkDeviceActive(trx, toBin(deviceId), OCCURRED_AT);
      expect(result).toEqual({ ok: false, reason: 'DEVICE_REVOKED' });
    });
  });

  it('accepte un appareil bloqué **après** occurred_at (était actif au moment du fait, BR-SYN-007)', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, admin, {
        status: 'BLOCKED',
        statusChangedAt: new Date('2026-09-30T00:00:00.000Z'),
      });
      const result = await checkDeviceActive(trx, toBin(deviceId), OCCURRED_AT);
      expect(result).toEqual({ ok: true });
    });
  });

  // --- AV-212 : périodes hors service closes (INV-ADM-03) ---------------------------------------------

  it('AV-212 : appareil redevenu ACTIVE — un fait daté dans sa période de blocage close est révoqué, bornes [début, fin)', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      await insertClosedPeriod(trx, {
        deviceId,
        status: 'BLOCKED',
        from: '2026-09-24T10:00:00.000Z',
        to: '2026-09-24T12:00:00.000Z',
        by: admin,
      });
      const check = (iso: string) => checkDeviceActive(trx, toBin(deviceId), new Date(iso));
      expect(await check('2026-09-24T09:59:59.999Z')).toEqual({ ok: true });
      expect(await check('2026-09-24T10:00:00.000Z')).toEqual({
        ok: false,
        reason: 'DEVICE_REVOKED',
      });
      expect(await check('2026-09-24T11:00:00.000Z')).toEqual({
        ok: false,
        reason: 'DEVICE_REVOKED',
      });
      expect(await check('2026-09-24T12:00:00.000Z')).toEqual({ ok: true });
    });
  });

  it('AV-212 : appareil retiré après une perte — un fait daté entre la perte et le retrait est révoqué ; avant la perte, accepté', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, admin, {
        status: 'RETIRED',
        statusChangedAt: new Date('2026-09-24T17:30:00.000Z'),
      });
      await insertClosedPeriod(trx, {
        deviceId,
        status: 'LOST',
        from: '2026-09-24T12:00:00.000Z',
        to: '2026-09-24T17:30:00.000Z',
        by: admin,
      });
      const check = (iso: string) => checkDeviceActive(trx, toBin(deviceId), new Date(iso));
      expect(await check('2026-09-24T13:00:00.000Z')).toEqual({
        ok: false,
        reason: 'DEVICE_REVOKED',
      });
      expect(await check('2026-09-24T11:00:00.000Z')).toEqual({ ok: true });
      expect(await check('2026-09-24T18:00:00.000Z')).toEqual({
        ok: false,
        reason: 'DEVICE_REVOKED',
      });
    });
  });

  it('AV-212 : la période close d’un autre appareil est sans effet', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      const other = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      await insertClosedPeriod(trx, {
        deviceId: other,
        status: 'BLOCKED',
        from: '2026-09-24T09:00:00.000Z',
        to: '2026-09-24T11:00:00.000Z',
        by: admin,
      });
      expect(await checkDeviceActive(trx, toBin(deviceId), OCCURRED_AT)).toEqual({ ok: true });
    });
  });

  it('AV-228 : appareil PENDING → en attente (DEVICE_PENDING) ; refusé avant toute approbation → révoqué, même pour un fait antérieur au refus', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const pending = await insertTestDevice(trx, admin, { status: 'PENDING' });
      expect(await checkDeviceActive(trx, toBin(pending), OCCURRED_AT)).toEqual({
        ok: false,
        reason: 'DEVICE_PENDING',
      });
      const refused = await insertTestDevice(trx, admin, {
        status: 'BLOCKED',
        statusChangedAt: new Date('2026-09-30T00:00:00.000Z'),
      });
      await trx
        .updateTable('identity_devices')
        .set({ approved_by: null })
        .where('id', '=', toBin(refused))
        .execute();
      expect(await checkDeviceActive(trx, toBin(refused), OCCURRED_AT)).toEqual({
        ok: false,
        reason: 'DEVICE_REVOKED',
      });
    });
  });
});

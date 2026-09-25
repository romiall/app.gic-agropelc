import { describe, expect, it } from 'vitest';
import { checkDeviceActive } from '../src/modules/identity/application/public/device-check.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { insertTestDevice, insertTestUser, withTestUow } from './helpers.js';

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
});

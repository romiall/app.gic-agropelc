import { describe, expect, it } from 'vitest';
import { checkUserActive } from '../src/modules/identity/application/public/user-check.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { freshUuid, insertTestUser, withTestUow } from './helpers.js';

const OCCURRED_AT = new Date('2026-09-24T10:00:00.000Z');

describe('checkUserActive (§3.2 point 3)', () => {
  it('accepte un utilisateur ACTIVE', async () => {
    await withTestUow(async (trx) => {
      const userId = await insertTestUser(trx, { status: 'ACTIVE' });
      const result = await checkUserActive(trx, toBin(userId), OCCURRED_AT);
      expect(result).toEqual({ ok: true });
    });
  });

  it('refuse un utilisateur inconnu (USER_DEACTIVATED)', async () => {
    await withTestUow(async (trx) => {
      const result = await checkUserActive(
        trx,
        toBin('0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11'),
        OCCURRED_AT,
      );
      expect(result).toEqual({ ok: false, reason: 'USER_DEACTIVATED' });
    });
  });

  it('refuse un utilisateur désactivé avant occurred_at', async () => {
    await withTestUow(async (trx) => {
      const userId = await insertTestUser(trx, {
        status: 'DEACTIVATED',
        statusChangedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      const result = await checkUserActive(trx, toBin(userId), OCCURRED_AT);
      expect(result).toEqual({ ok: false, reason: 'USER_DEACTIVATED' });
    });
  });

  it('accepte un utilisateur désactivé **après** occurred_at (BR-SYN-007)', async () => {
    await withTestUow(async (trx) => {
      const userId = await insertTestUser(trx, {
        status: 'SUSPENDED',
        statusChangedAt: new Date('2026-09-30T00:00:00.000Z'),
      });
      const result = await checkUserActive(trx, toBin(userId), OCCURRED_AT);
      expect(result).toEqual({ ok: true });
    });
  });

  it('refuse un statut non-ACTIVE sans status_changed_at (ne peut prouver l’activité à occurred_at)', async () => {
    await withTestUow(async (trx) => {
      const userId = await insertTestUser(trx, { status: 'SUSPENDED', statusChangedAt: null });
      const result = await checkUserActive(trx, toBin(userId), OCCURRED_AT);
      expect(result).toEqual({ ok: false, reason: 'USER_DEACTIVATED' });
    });
  });

  describe('périodes hors service closes (AV-229)', () => {
    async function closedPeriod(
      trx: Parameters<Parameters<typeof withTestUow>[0]>[0],
      userId: string,
      from: string,
      to: string,
    ): Promise<void> {
      await trx
        .insertInto('identity_user_status_periods')
        .values({
          command_id: toBin(freshUuid()),
          user_id: toBin(userId),
          status: 'SUSPENDED',
          valid_from: new Date(from),
          valid_to: new Date(to),
          reason: 'Essai',
          closed_by: toBin(userId),
        })
        .execute();
    }

    it('refuse un utilisateur redevenu ACTIVE pour un fait daté dans une période close', async () => {
      await withTestUow(async (trx) => {
        const userId = await insertTestUser(trx, { status: 'ACTIVE' });
        await closedPeriod(trx, userId, '2026-09-24T09:00:00.000Z', '2026-09-24T11:00:00.000Z');
        expect(await checkUserActive(trx, toBin(userId), OCCURRED_AT)).toEqual({
          ok: false,
          reason: 'USER_DEACTIVATED',
        });
      });
    });

    it('accepte un fait daté avant l’ouverture ou à la fermeture de la période close', async () => {
      await withTestUow(async (trx) => {
        const userId = await insertTestUser(trx, { status: 'ACTIVE' });
        await closedPeriod(trx, userId, '2026-09-24T10:00:00.000Z', '2026-09-24T11:00:00.000Z');
        expect(
          await checkUserActive(trx, toBin(userId), new Date('2026-09-24T09:59:59.999Z')),
        ).toEqual({
          ok: true,
        });
        expect(
          await checkUserActive(trx, toBin(userId), new Date('2026-09-24T10:00:00.000Z')),
        ).toEqual({
          ok: false,
          reason: 'USER_DEACTIVATED',
        });
        expect(
          await checkUserActive(trx, toBin(userId), new Date('2026-09-24T11:00:00.000Z')),
        ).toEqual({
          ok: true,
        });
      });
    });

    it('la période d’un autre utilisateur ne compte pas', async () => {
      await withTestUow(async (trx) => {
        const userId = await insertTestUser(trx, { status: 'ACTIVE' });
        const otherId = await insertTestUser(trx, { status: 'ACTIVE' });
        await closedPeriod(trx, otherId, '2026-09-24T09:00:00.000Z', '2026-09-24T11:00:00.000Z');
        expect(await checkUserActive(trx, toBin(userId), OCCURRED_AT)).toEqual({ ok: true });
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { hasPermissionAt } from '../src/modules/identity/application/public/rights-check.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  freshUuid,
  grantTestPermission,
  insertTestPermission,
  insertTestRole,
  insertTestUser,
  withTestUow,
} from './helpers.js';

const OCCURRED_AT = new Date('2026-09-24T10:00:00.000Z');

describe('hasPermissionAt (RC-01, §4 « affectation active à occurred_at »)', () => {
  it('refuse un utilisateur sans aucune affectation', async () => {
    await withTestUow(async (trx) => {
      const user = await insertTestUser(trx);
      const permission = `test.rights.${freshUuid()}`;
      await insertTestPermission(trx, permission);
      expect(await hasPermissionAt(trx, toBin(user), permission, OCCURRED_AT)).toBe(false);
    });
  });

  it('accepte un octroi actif à occurred_at (rôle -> permission, affectation en cours)', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const user = await insertTestUser(trx);
      const permission = `test.rights.${freshUuid()}`;
      await insertTestPermission(trx, permission);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, permission, admin);
      await assignTestRole(trx, user, role, admin);
      expect(await hasPermissionAt(trx, toBin(user), permission, OCCURRED_AT)).toBe(true);
    });
  });

  it('refuse une autre permission que celle accordée', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const user = await insertTestUser(trx);
      const granted = `test.rights.${freshUuid()}`;
      const other = `test.rights.${freshUuid()}`;
      await insertTestPermission(trx, granted);
      await insertTestPermission(trx, other);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, granted, admin);
      await assignTestRole(trx, user, role, admin);
      expect(await hasPermissionAt(trx, toBin(user), other, OCCURRED_AT)).toBe(false);
    });
  });

  it('refuse une affectation qui débute après occurred_at', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const user = await insertTestUser(trx);
      const permission = `test.rights.${freshUuid()}`;
      await insertTestPermission(trx, permission);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, permission, admin);
      await assignTestRole(trx, user, role, admin, {
        validFrom: new Date('2026-10-01T00:00:00.000Z'),
      });
      expect(await hasPermissionAt(trx, toBin(user), permission, OCCURRED_AT)).toBe(false);
    });
  });

  it('refuse une affectation déjà fermée (valid_to) avant occurred_at', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const user = await insertTestUser(trx);
      const permission = `test.rights.${freshUuid()}`;
      await insertTestPermission(trx, permission);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, permission, admin);
      await assignTestRole(trx, user, role, admin, {
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2026-09-01T00:00:00.000Z'),
      });
      expect(await hasPermissionAt(trx, toBin(user), permission, OCCURRED_AT)).toBe(false);
    });
  });

  it('accepte une affectation fermée **après** occurred_at (était active au moment du fait)', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const user = await insertTestUser(trx);
      const permission = `test.rights.${freshUuid()}`;
      await insertTestPermission(trx, permission);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, permission, admin);
      await assignTestRole(trx, user, role, admin, {
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2026-10-01T00:00:00.000Z'),
      });
      expect(await hasPermissionAt(trx, toBin(user), permission, OCCURRED_AT)).toBe(true);
    });
  });

  it('refuse une affectation révoquée avant occurred_at', async () => {
    await withTestUow(async (trx) => {
      const admin = await insertTestUser(trx);
      const user = await insertTestUser(trx);
      const permission = `test.rights.${freshUuid()}`;
      await insertTestPermission(trx, permission);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, permission, admin);
      await assignTestRole(trx, user, role, admin, {
        revokedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      expect(await hasPermissionAt(trx, toBin(user), permission, OCCURRED_AT)).toBe(false);
    });
  });
});

/**
 * Rafraîchissement de session (`rotateSession`) : l'appareil est jugé sur son ÉTAT ACTUEL, pas sur le motif de révocation
 * de la session (AV-213 (c)), et la liaison de l'appareil à son premier compte vaut aussi pour les sessions déjà ouvertes
 * (AV-296 (b)). Sans écrire de réglage global sur la base partagée (un réglage est versionné et ne se retire pas) : la
 * couche de transport lit le réglage, la règle se teste ici par l'option `boundToEnroller`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { createSession, rotateSession } from '../src/modules/identity/application/auth/session.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { closeTestDb, insertTestDevice, insertTestUser, withTestUow } from './helpers.js';

afterAll(async () => {
  await closeTestDb();
});

const NOW = new Date('2026-11-05T10:00:00.000Z');
const ids = new Uuidv7Generator(new FixedClock(NOW));

const open = (uow: UnitOfWork, userId: string, deviceId: string) =>
  createSession(uow, ids, { userId, deviceId, now: NOW, ip: '10.1.2.3' });
const refresh = (uow: UnitOfWork, token: string, boundToEnroller?: boolean) =>
  rotateSession(
    uow,
    ids,
    token,
    NOW,
    '10.1.2.3',
    boundToEnroller === undefined ? {} : { boundToEnroller },
  );
const setDevice = (uow: UnitOfWork, deviceId: string, status: string) =>
  uow
    .updateTable('identity_devices')
    .set({ status, status_reason: 'Test', status_changed_at: NOW })
    .where('id', '=', toBin(deviceId))
    .execute();

describe('rotateSession : appareil hors service jugé sur son état actuel (AV-213 (c))', () => {
  it('un appareil bloqué, perdu ou retiré refuse le rafraîchissement avec DEVICE_OUT_OF_SERVICE', async () => {
    await withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      for (const status of ['BLOCKED', 'LOST', 'RETIRED']) {
        const device = await insertTestDevice(uow, user, { status: 'ACTIVE' });
        const { refreshToken } = await open(uow, user, device);
        await setDevice(uow, device, status);
        expect(await refresh(uow, refreshToken), status).toEqual({
          ok: false,
          reason: 'DEVICE_OUT_OF_SERVICE',
        });
      }
    });
  });

  it('jeton déjà tourné présenté après le blocage de l’appareil : DEVICE_OUT_OF_SERVICE, pas une fausse réutilisation de jeton', async () => {
    await withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const device = await insertTestDevice(uow, user, { status: 'ACTIVE' });
      const { refreshToken: first } = await open(uow, user, device);
      // La rotation a eu lieu côté serveur, mais la réponse s'est perdue : l'appareil garde `first`.
      const rotated = await refresh(uow, first);
      expect(rotated.ok).toBe(true);
      await setDevice(uow, device, 'BLOCKED');
      expect(await refresh(uow, first)).toEqual({ ok: false, reason: 'DEVICE_OUT_OF_SERVICE' });
    });
  });

  it('un appareil débloqué depuis : la session close par son blocage ne revit pas, mais rien n’est effacé (pas de DEVICE_OUT_OF_SERVICE)', async () => {
    await withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const device = await insertTestDevice(uow, user, { status: 'ACTIVE' });
      const { refreshToken } = await open(uow, user, device);
      await uow
        .updateTable('identity_auth_sessions')
        .set({ revoked_at: NOW, revoked_reason: 'DEVICE_BLOCKED' })
        .where('device_id', '=', toBin(device))
        .execute();
      expect(await refresh(uow, refreshToken)).toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
    });
  });

  it('un jeton déjà tourné sur un appareil en service reste une réutilisation de jeton (alerte de sécurité inchangée)', async () => {
    await withTestUow(async (uow) => {
      const user = await insertTestUser(uow);
      const device = await insertTestDevice(uow, user, { status: 'ACTIVE' });
      const { refreshToken } = await open(uow, user, device);
      expect((await refresh(uow, refreshToken)).ok).toBe(true);
      expect(await refresh(uow, refreshToken)).toMatchObject({ ok: false, reason: 'TOKEN_REUSE' });
    });
  });
});

describe('rotateSession : appareil lié à son premier compte, sessions déjà ouvertes (AV-296 (b))', () => {
  it('réglage faux (défaut) : un autre compte se rafraîchit comme avant', async () => {
    await withTestUow(async (uow) => {
      const [first, second] = [await insertTestUser(uow), await insertTestUser(uow)];
      const device = await insertTestDevice(uow, first, { status: 'ACTIVE' });
      const ofSecond = await open(uow, second, device);
      const rotated = await refresh(uow, ofSecond.refreshToken);
      expect(rotated.ok).toBe(true);
      // Réglage explicitement faux : même comportement.
      if (rotated.ok) expect((await refresh(uow, rotated.refreshToken, false)).ok).toBe(true);
    });
  });

  it('réglage vrai : la session d’un autre compte est refusée sur un appareil non partagé ; celle du premier compte, ou sur un appareil partagé, non', async () => {
    await withTestUow(async (uow) => {
      const [first, second] = [await insertTestUser(uow), await insertTestUser(uow)];
      const device = await insertTestDevice(uow, first, { status: 'ACTIVE' });
      const ofFirst = await open(uow, first, device);
      const ofSecond = await open(uow, second, device);
      expect(await refresh(uow, ofSecond.refreshToken, true)).toEqual({
        ok: false,
        reason: 'DEVICE_BOUND_TO_OTHER_USER',
      });
      expect((await refresh(uow, ofFirst.refreshToken, true)).ok).toBe(true);

      // L'Admin désigne l'appareil « partagé » : tout compte s'y rafraîchit.
      await uow
        .updateTable('identity_devices')
        .set({ is_shared: 1 })
        .where('id', '=', toBin(device))
        .execute();
      const again = await open(uow, second, device);
      expect((await refresh(uow, again.refreshToken, true)).ok).toBe(true);
    });
  });
});

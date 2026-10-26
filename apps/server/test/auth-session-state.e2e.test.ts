/**
 * MP-11 — blocage immédiat (AV-282, décision du porteur du 14/10/2026) : la garde d'authentification
 * n'accepte un jeton que si sa session est vivante, son utilisateur actif et son appareil en service,
 * sans attendre l'expiration du jeton (15 min). Plus, de la revue adverse de MP-11 : déconnexion par
 * famille de rotation, changement de mot de passe qui ferme les autres sessions (`PASSWORD_CHANGED`),
 * connexion sur un numéro réattribué après une désactivation.
 *
 * Les mots de passe ci-dessous sont des valeurs de test, propres à ce fichier.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  hashPassword,
  verifyDecoyPassword,
} from '../src/modules/identity/application/auth/password.js';
import {
  SESSION_STATE_TTL_MS,
  cachedSessionAccess,
  sessionAccessAt,
} from '../src/modules/identity/application/auth/session-state.js';
import { revokeUserSessions } from '../src/modules/identity/application/commands/revoke-sessions.js';
import { closeTestDb, db, freshPhone, freshUuid } from './helpers.js';

const TEST_PASSWORD = 'mot-de-passe-de-test-mp11';
const NEW_PASSWORD = 'nouveau-mot-de-passe-mp11'; // gitleaks:allow (mot de passe de test, base jetable)

// Adresses propres à l'exécution : les compteurs d'échecs par IP survivent d'une exécution à l'autre
// (une IP reprise d'une exécution précédente peut être verrouillée).
const RUN_OCTET = randomInt(256);
let ipCounter = 0;
const freshIp = () => `10.91.${RUN_OCTET}.${(++ipCounter % 254) + 1}`;

interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
}

describe('MP-11 : blocage immédiat des sessions (AV-282)', { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;

  const createUser = async (
    phone: string,
    status: 'ACTIVE' | 'DEACTIVATED' = 'ACTIVE',
  ): Promise<string> => {
    const id = freshUuid();
    await db
      .insertInto('identity_users')
      .values({
        id: toBin(id),
        full_name: `Compte MP-11 ${id.slice(-4)}`,
        phone,
        password_hash: await hashPassword(TEST_PASSWORD),
        must_change_password: 0,
        status,
        ...(status === 'DEACTIVATED' ? { status_reason: 'Départ (test MP-11)' } : {}),
        created_by: toBin(id),
      })
      .execute();
    return id;
  };
  const login = async (phone: string, deviceId = freshUuid(), password = TEST_PASSWORD) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password, device_id: deviceId },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Tokens;
  };
  const home = (accessToken: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/home',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const refusalOf = async (accessToken: string) => {
    const response = await home(accessToken);
    expect(response.statusCode, response.body).toBe(401);
    const body = response.json() as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    return body.error.details?.reason;
  };
  const refresh = (refreshToken: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: refreshToken },
    });
  const logout = (accessToken: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('déconnexion : le jeton d’accès est refusé dès la requête suivante (SESSION_REVOKED)', async () => {
    const phone = await freshPhone();
    await createUser(phone);
    const tokens = await login(phone);
    expect((await home(tokens.access_token)).statusCode).toBe(200);

    expect((await logout(tokens.access_token)).statusCode).toBe(200);
    expect(await refusalOf(tokens.access_token)).toBe('SESSION_REVOKED');
    // Une seconde déconnexion avec le même jeton est refusée aussi : rien ne se rouvre.
    expect((await logout(tokens.access_token)).statusCode).toBe(401);
  });

  it('rotation : le jeton émis avant reste valable ; la déconnexion par ce jeton ferme toute la famille', async () => {
    const phone = await freshPhone();
    await createUser(phone);
    const first = await login(phone);
    const rotated = await refresh(first.refresh_token);
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json() as Tokens;

    // La ligne du premier jeton est `ROTATED`, mais sa famille a une session vivante.
    expect((await home(first.access_token)).statusCode).toBe(200);
    expect((await home(second.access_token)).statusCode).toBe(200);

    expect((await logout(first.access_token)).statusCode).toBe(200);
    expect(await refusalOf(second.access_token)).toBe('SESSION_REVOKED');
    expect((await refresh(second.refresh_token)).statusCode).toBe(401);
    const live = await db
      .selectFrom('identity_auth_sessions as s')
      .select('s.revoked_reason')
      .innerJoin('identity_users as u', 'u.id', 's.user_id')
      .where('u.phone', '=', phone)
      .execute();
    expect(live.map((s) => s.revoked_reason).sort()).toEqual(['LOGOUT', 'ROTATED']);
  });

  it('révocation (suspension, blocage) : effet immédiat, sans attendre le cache de 5 s', async () => {
    const phone = await freshPhone();
    const userId = await createUser(phone);
    const tokens = await login(phone);
    // L'état « actif » est maintenant en cache pour cette session.
    expect((await home(tokens.access_token)).statusCode).toBe(200);

    await db.transaction().execute((trx) => revokeUserSessions(trx, userId, 'ADMIN', new Date()));
    expect(await refusalOf(tokens.access_token)).toBe('SESSION_REVOKED');
  });

  it('compte suspendu ou appareil hors service sans révocation : refusé au motif propre', async () => {
    const suspendedPhone = await freshPhone();
    const suspended = await createUser(suspendedPhone);
    const suspendedTokens = await login(suspendedPhone);
    await db
      .updateTable('identity_users')
      .set({ status: 'SUSPENDED', status_reason: 'Test MP-11' })
      .where('id', '=', toBin(suspended))
      .execute();
    expect(await refusalOf(suspendedTokens.access_token)).toBe('USER_INACTIVE');

    for (const status of ['BLOCKED', 'LOST', 'RETIRED'] as const) {
      const phone = await freshPhone();
      await createUser(phone);
      const deviceId = freshUuid();
      const tokens = await login(phone, deviceId);
      // Appareil neuf, en attente d'approbation : l'accès reste ouvert (lecture, attente, AV-228).
      expect((await home(tokens.access_token)).statusCode).toBe(200);
      await db
        .updateTable('identity_devices')
        .set({ status, status_changed_at: new Date() })
        .where('id', '=', toBin(deviceId))
        .execute();
      // Sans révocation, l'état en cache vaut au plus SESSION_STATE_TTL_MS.
      const later = Date.now() + SESSION_STATE_TTL_MS + 1;
      const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
      try {
        expect(await refusalOf(tokens.access_token)).toBe('DEVICE_OUT_OF_SERVICE');
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('cache : l’état lu vaut SESSION_STATE_TTL_MS, puis est relu', async () => {
    const phone = await freshPhone();
    const userId = await createUser(phone);
    const deviceId = freshUuid();
    const tokens = await login(phone, deviceId);
    const session = await db
      .selectFrom('identity_auth_sessions')
      .select('id')
      .where('user_id', '=', toBin(userId))
      .executeTakeFirstOrThrow();
    const input = { sessionId: fromBin(session.id), userId, deviceId, at: new Date() };
    const start = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      expect(await cachedSessionAccess(db, input)).toBe('ACTIVE');
      await db
        .updateTable('identity_users')
        .set({ status: 'SUSPENDED', status_reason: 'Test MP-11' })
        .where('id', '=', toBin(userId))
        .execute();
      expect(await sessionAccessAt(db, input)).toBe('USER_INACTIVE');
      spy.mockReturnValue(start + SESSION_STATE_TTL_MS - 1);
      expect(await cachedSessionAccess(db, input)).toBe('ACTIVE');
      spy.mockReturnValue(start + SESSION_STATE_TTL_MS);
      expect(await cachedSessionAccess(db, input)).toBe('USER_INACTIVE');
    } finally {
      spy.mockRestore();
    }
    // Une session d'un autre utilisateur ou d'un autre appareil n'est jamais la sienne.
    expect(await sessionAccessAt(db, { ...input, userId: freshUuid() })).toBe('SESSION_REVOKED');
    expect(await sessionAccessAt(db, { ...input, deviceId: freshUuid() })).toBe('SESSION_REVOKED');
    // Une famille expirée n'a plus de session vivante.
    expect(
      await sessionAccessAt(db, { ...input, at: new Date(Date.now() + 31 * 24 * 3600 * 1000) }),
    ).toBe('SESSION_REVOKED');
    expect(tokens.access_token).toBeTypeOf('string');
  });

  it('changement de mot de passe : les autres sessions sont fermées (PASSWORD_CHANGED), celle-ci reste', async () => {
    const phone = await freshPhone();
    const userId = await createUser(phone);
    const here = await login(phone);
    const elsewhere = await login(phone);
    const rotatedElsewhere = (await refresh(elsewhere.refresh_token)).json() as Tokens;
    // L'état « actif » de l'autre session est en cache : le changement doit le vider.
    expect((await home(rotatedElsewhere.access_token)).statusCode).toBe(200);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${here.access_token}` },
      payload: { current_password: TEST_PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    expect((await home(here.access_token)).statusCode).toBe(200);
    expect((await refresh(here.refresh_token)).statusCode).toBe(200);
    expect(await refusalOf(rotatedElsewhere.access_token)).toBe('SESSION_REVOKED');
    expect((await refresh(rotatedElsewhere.refresh_token)).statusCode).toBe(401);

    const reasons = await db
      .selectFrom('identity_auth_sessions')
      .select('revoked_reason')
      .where('user_id', '=', toBin(userId))
      .where('revoked_reason', '=', 'PASSWORD_CHANGED')
      .execute();
    expect(reasons).toHaveLength(1);
    const audit = await db
      .selectFrom('audit_audit_log')
      .select('after')
      .where('entity_id', '=', toBin(userId))
      .where('action', '=', 'identity.user.change_password')
      .where('result', '=', 'SUCCESS')
      .executeTakeFirstOrThrow();
    expect(audit.after).toEqual({ revoked_sessions: 1 });
  });

  it('connexion : un numéro réattribué après une désactivation ouvre le compte en vigueur', async () => {
    const phone = await freshPhone();
    // Un compte désactivé plus ancien et un plus récent (compte réactivé après le départ d'un
    // homonyme) : le compte en vigueur passe toujours devant.
    const former = await createUser(phone, 'DEACTIVATED');
    const current = await createUser(phone);
    const later = await createUser(phone, 'DEACTIVATED');
    expect(former < current && current < later).toBe(true);

    const tokens = await login(phone);
    expect((await home(tokens.access_token)).statusCode).toBe(200);
    const session = await db
      .selectFrom('identity_auth_sessions')
      .select('user_id')
      .where('user_id', 'in', [toBin(former), toBin(current), toBin(later)])
      .execute();
    expect(session.map((s) => fromBin(s.user_id))).toEqual([current]);

    // Sans compte en vigueur, l'échec est audité au nom du dernier compte désactivé.
    const lonePhone = await freshPhone();
    const older = await createUser(lonePhone, 'DEACTIVATED');
    const lone = await createUser(lonePhone, 'DEACTIVATED');
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone: lonePhone, password: TEST_PASSWORD, device_id: freshUuid() },
    });
    expect(refused.statusCode).toBe(401);
    const audit = await db
      .selectFrom('audit_audit_log')
      .select('error_code')
      .where('entity_id', '=', toBin(lone))
      .where('action', '=', 'auth.login.failed')
      .execute();
    expect(audit).toEqual([{ error_code: 'ACCOUNT_DEACTIVATED' }]);
    const olderAudit = await db
      .selectFrom('audit_audit_log')
      .select('id')
      .where('entity_id', '=', toBin(older))
      .execute();
    expect(olderAudit).toEqual([]);
  });

  it('vérification leurre : jamais vraie, au coût d’un vrai mot de passe', async () => {
    await expect(verifyDecoyPassword(TEST_PASSWORD)).resolves.toBe(false);
    await expect(verifyDecoyPassword('')).resolves.toBe(false);
  });
});

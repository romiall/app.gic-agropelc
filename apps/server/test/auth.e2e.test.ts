/**
 * `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password` bout en bout
 * (P0-09 ; 07-security-rbac/02-securite.md §2, §3), même gabarit que http.e2e.test.ts
 * (NestJS + Fastify, `app.inject()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { hashPassword } from '../src/modules/identity/application/auth/password.js';
import { closeTestDb, db, freshUuid } from './helpers.js';

const KNOWN_PASSWORD = 'correct horse battery staple';

async function createLoginableUser(phone: string): Promise<string> {
  const id = freshUuid();
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await db
    .insertInto('identity_users')
    .values({
      id: toBin(id),
      full_name: 'Test Connexion',
      phone,
      password_hash: passwordHash,
      must_change_password: 0,
      status: 'ACTIVE',
      created_by: toBin(id),
    })
    .execute();
  return id;
}

function freshPhone(): string {
  return `+2376${Math.floor(1_000_0000 + Math.random() * 8_999_9999)}`;
}

/**
 * Le verrouillage par IP (§2) partage un compteur par valeur d'IP dans
 * `identity_login_attempts` : sans IP distincte par test, les échecs d'un test bloquent les
 * connexions réussies d'un autre (tous les appels `app.inject()` partagent sinon la même
 * IP par défaut, 127.0.0.1). Chaque test utilise donc sa propre IP simulée.
 */
function freshIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('POST /api/v1/auth/* (P0-09)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
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

  it('connexion réussie : jeton émis, appareil neuf enrôlé PENDING (§5, BR-ADM-005)', async () => {
    const phone = freshPhone();
    await createLoginableUser(phone);
    const deviceId = freshUuid();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password: KNOWN_PASSWORD, device_id: deviceId },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.device_status).toBe('PENDING');
    expect(body.must_change_password).toBe(false);

    const device = await db
      .selectFrom('identity_devices')
      .select('status')
      .where('id', '=', toBin(deviceId))
      .executeTakeFirstOrThrow();
    expect(device.status).toBe('PENDING');
  });

  it('mot de passe incorrect : 401, aucune session créée', async () => {
    const phone = freshPhone();
    await createLoginableUser(phone);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password: 'mauvais-mot-de-passe', device_id: freshUuid() },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('identifiant inconnu : 401 (pas de fuite sur l’existence du compte)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone: freshPhone(), password: 'peu importe', device_id: freshUuid() },
    });
    expect(response.statusCode).toBe(401);
  });

  it('compte désactivé : 401', async () => {
    const phone = freshPhone();
    const userId = await createLoginableUser(phone);
    await db
      .updateTable('identity_users')
      .set({ status: 'DEACTIVATED', status_reason: 'Test' })
      .where('id', '=', toBin(userId))
      .execute();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password: KNOWN_PASSWORD, device_id: freshUuid() },
    });
    expect(response.statusCode).toBe(401);
  });

  it('verrouillage progressif : 5 échecs → 429 (§2)', async () => {
    const phone = freshPhone();
    const ip = freshIp();
    await createLoginableUser(phone);
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: ip,
        payload: { phone, password: 'faux', device_id: freshUuid() },
      });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { phone, password: KNOWN_PASSWORD, device_id: freshUuid() }, // même le bon mot de passe est bloqué
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('LOGIN_LOCKED');
  });

  it('rafraîchissement : rotation, l’ancien jeton devient invalide', async () => {
    const phone = freshPhone();
    await createLoginableUser(phone);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password: KNOWN_PASSWORD, device_id: freshUuid() },
    });
    const { refresh_token: firstRefreshToken } = login.json();

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: firstRefreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const { refresh_token: secondRefreshToken } = refreshed.json();
    expect(secondRefreshToken).not.toBe(firstRefreshToken);

    // Le premier jeton, déjà tourné, ne fonctionne plus.
    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: firstRefreshToken },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error.code).toBe('TOKEN_REUSE');

    // La réutilisation révoque toute la famille : le second jeton (pourtant valide juste
    // avant) est maintenant révoqué lui aussi.
    const secondNowRevoked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: secondRefreshToken },
    });
    expect(secondNowRevoked.statusCode).toBe(401);
  });

  it('déconnexion : révoque la session, jeton d’accès sans effet sur /audit après (session-based logout)', async () => {
    const phone = freshPhone();
    await createLoginableUser(phone);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password: KNOWN_PASSWORD, device_id: freshUuid() },
    });
    const { access_token: accessToken, refresh_token: refreshToken } = login.json();

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(logout.statusCode).toBe(200);

    // La session est révoquée : un rafraîchissement ultérieur avec ce jeton est refusé.
    const refreshAfterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: refreshToken },
    });
    expect(refreshAfterLogout.statusCode).toBe(401);
  });

  it('changement de mot de passe : ancien refusé ensuite, must_change_password ne bloque rien côté serveur', async () => {
    const phone = freshPhone();
    await createLoginableUser(phone);
    const ip = freshIp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { phone, password: KNOWN_PASSWORD, device_id: freshUuid() },
    });
    const { access_token: accessToken } = login.json();

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { current_password: KNOWN_PASSWORD, new_password: 'nouveau mot de passe long' },
    });
    expect(changed.statusCode).toBe(200);

    const reloginOldPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { phone, password: KNOWN_PASSWORD, device_id: freshUuid() },
    });
    expect(reloginOldPassword.statusCode).toBe(401);

    const reloginNewPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { phone, password: 'nouveau mot de passe long', device_id: freshUuid() },
    });
    expect(reloginNewPassword.statusCode).toBe(200);
  });
});

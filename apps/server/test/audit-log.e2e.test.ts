/**
 * `GET /api/v1/audit` bout en bout (REQ-065, REQ-209 ; 07-security-rbac/03-audit.md §6) :
 * même gabarit que http.e2e.test.ts (NestJS + Fastify, app.inject()). Droit absent → 403 et
 * un `access.denied` audité (BR-AUD-004) ; droit présent → 200 et la consultation elle-même
 * auditée (`audit.log.read`, BR-AUD-009).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  signAccessToken,
  type JwtKeyPair,
} from '../src/modules/identity/application/public/jwt.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestPermission,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const AUDIT_LOG_READ_PERMISSION = 'audit.log.read';

async function createRealUser(): Promise<string> {
  return db.transaction().execute((trx) => insertTestUser(trx));
}

async function createRealDevice(enrolledBy: string): Promise<string> {
  return db.transaction().execute((trx) => insertTestDevice(trx, enrolledBy, { status: 'ACTIVE' }));
}

describe('GET /api/v1/audit (§6, BR-AUD-004, BR-AUD-009)', () => {
  let app: NestFastifyApplication;
  let jwtKeys: JwtKeyPair;
  let clock: Clock;
  let authorizedUser: string;
  let unauthorizedUser: string;
  let device: string;
  let authorizedToken: string;
  let unauthorizedToken: string;

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    jwtKeys = app.get(JWT_KEYS);
    clock = app.get(CLOCK);

    authorizedUser = await createRealUser();
    unauthorizedUser = await createRealUser();
    device = await createRealDevice(authorizedUser);

    authorizedToken = await signAccessToken(
      jwtKeys.privateKey,
      { sub: authorizedUser, device_id: device, session_id: freshUuid() },
      clock.now(),
    );
    unauthorizedToken = await signAccessToken(
      jwtKeys.privateKey,
      { sub: unauthorizedUser, device_id: device, session_id: freshUuid() },
      clock.now(),
    );

    await db.transaction().execute(async (trx) => {
      await insertTestPermission(trx, AUDIT_LOG_READ_PERMISSION);
      const role = await insertTestRole(trx, authorizedUser);
      await grantTestPermission(trx, role, AUDIT_LOG_READ_PERMISSION, authorizedUser);
      await assignTestRole(trx, authorizedUser, role, authorizedUser);
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('sans Authorization : 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/audit' });
    expect(response.statusCode).toBe(401);
  });

  it('droit absent : 403, et le refus est audité (access.denied, BR-AUD-004)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { authorization: `Bearer ${unauthorizedToken}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'action', 'error_code'])
      .where('actor_user_id', '=', toBin(unauthorizedUser))
      .where('action', '=', 'access.denied')
      .executeTakeFirstOrThrow();
    expect(denied.result).toBe('DENIED');
    expect(denied.error_code).toBe('FORBIDDEN');
  });

  it('droit présent : 200, entrées renvoyées, et la consultation elle-même est auditée (BR-AUD-009)', async () => {
    // Au moins une entrée déjà présente (le refus ci-dessus) pour que la liste ne soit pas vide.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=5',
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: readonly unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);

    const selfAudit = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'entity_type'])
      .where('actor_user_id', '=', toBin(authorizedUser))
      .where('action', '=', 'audit.log.read')
      .executeTakeFirstOrThrow();
    expect(selfAudit.result).toBe('SUCCESS');
    expect(selfAudit.entity_type).toBe('AUDIT_LOG');
  });

  it('filtre invalide (entity_id non UUID) : 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?entity_id=pas-un-uuid',
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

/**
 * Câblage HTTP réel de `/api/v1/sync/push` et `/api/v1/sync/pull` (P0-12) : comme
 * `http.e2e.test.ts` pour `/commands`, complète `sync-push-pull.test.ts` (qui teste les
 * services directement) en validant la garde d'authentification, le contrôleur — dont la
 * vérification « device_id du corps == appareil authentifié » et la coercition de la
 * chaîne de requête (`coerceQuery`, cursor/limit texte → nombre) — et la (dé)sérialisation
 * JSON bout en bout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';
import type { Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../src/platform/sync/command-handler-registry.provider.js';
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

const HTTP_SYNC_DEMO_TYPE = 'test.sync_http_demo.record';
const HTTP_SYNC_DEMO_PERMISSION = 'test.sync_http_demo.record';
const OCCURRED_AT = '2026-09-24T09:00:00.000Z';

async function createRealUser(): Promise<string> {
  return db.transaction().execute((trx) => insertTestUser(trx));
}

async function createRealDevice(enrolledBy: string): Promise<string> {
  return db.transaction().execute((trx) => insertTestDevice(trx, enrolledBy, { status: 'ACTIVE' }));
}

describe('POST /api/v1/sync/push, GET /api/v1/sync/pull (câblage NestJS + Fastify)', () => {
  let app: NestFastifyApplication;
  let jwtKeys: JwtKeyPair;
  let clock: Clock;
  let user: string;
  let device: string;
  let token: string;

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

    user = await createRealUser();
    device = await createRealDevice(user);
    token = await signAccessToken(
      jwtKeys.privateKey,
      { sub: user, device_id: device, session_id: freshUuid() },
      clock.now(),
    );

    await db.transaction().execute(async (trx) => {
      await insertTestPermission(trx, HTTP_SYNC_DEMO_PERMISSION);
      const role = await insertTestRole(trx, user);
      await grantTestPermission(trx, role, HTTP_SYNC_DEMO_PERMISSION, user);
      await assignTestRole(trx, user, role, user);
    });

    // Même technique que http.e2e.test.ts : enregistre un gestionnaire de démonstration
    // dans le *vrai* registre de l'application, pour prouver le trajet complet HTTP →
    // garde → SyncPushService → pipeline → gestionnaire → réponse.
    const registry = app.get<CommandHandlerRegistry>(COMMAND_HANDLER_REGISTRY);
    registry.register({
      commandType: HTTP_SYNC_DEMO_TYPE,
      version: 1,
      payloadSchema: z.object({ note: z.string().min(1).max(200) }),
      permissionCode: HTTP_SYNC_DEMO_PERMISSION,
      handler: async () => ({ status: 'APPLIED' as const }),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  function buildPushEnvelope(overrides: {
    readonly command_id: string;
    readonly device_seq: number;
  }): Record<string, unknown> {
    return {
      command_id: overrides.command_id,
      device_seq: overrides.device_seq,
      command_type: HTTP_SYNC_DEMO_TYPE,
      command_version: 1,
      author_user_id: user,
      aggregate_type: 'TEST_SETTING',
      aggregate_id: freshUuid(),
      base_version: null,
      depends_on: [],
      occurred_at: OCCURRED_AT,
      client_created_at: OCCURRED_AT,
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: { note: 'via HTTP sync' },
    };
  }

  it('POST /api/v1/sync/push sans Authorization renvoie 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/sync/push', payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /api/v1/sync/push avec un device_id de corps différent du jeton renvoie 403', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        device_id: freshUuid(), // valide en forme, mais pas l'appareil authentifié
        batch_id: freshUuid(),
        device_sent_at: OCCURRED_AT,
        commands: [buildPushEnvelope({ command_id: freshUuid(), device_seq: 1 })],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('POST /api/v1/sync/push avec un corps malformé renvoie 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: device },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('chemin heureux : POST /api/v1/sync/push → 200, results[] APPLIED', async () => {
    const commandId = freshUuid();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        device_id: device,
        batch_id: freshUuid(),
        // Horloge réelle (pas OCCURRED_AT, fixe dans le passé) : évite un CLOCK_SUSPECT
        // parasite ici — l'écart d'horloge est déjà couvert par AT-036 dans
        // sync-push-pull.test.ts, ce test-ci prouve seulement le câblage HTTP.
        device_sent_at: clock.now().toISOString(),
        commands: [buildPushEnvelope({ command_id: commandId, device_seq: 10 })],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results).toEqual([{ command_id: commandId, status: 'APPLIED' }]);
    expect(typeof body.server_time).toBe('string');
    expect(typeof body.clock_skew_ms).toBe('number');
  });

  it('GET /api/v1/sync/pull sans Authorization renvoie 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?dataset=x&cursor=0',
    });
    expect(response.statusCode).toBe(401);
  });

  it('chemin heureux : GET /api/v1/sync/pull → 200, chaîne de requête coercée (cursor/limit texte)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?dataset=test_http_pull&cursor=0&limit=10',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.changes)).toBe(true);
    expect(typeof body.next_cursor).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
  });
});

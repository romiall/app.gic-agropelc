/**
 * Câblage HTTP réel (NestJS + Fastify) : `Test.createTestingModule` + `app.inject()`
 * (pas de socket réseau) — complète pipeline.integration.test.ts, qui teste le service
 * directement, en validant la garde d'authentification, le contrôleur et la
 * (dé)sérialisation JSON bout en bout.
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
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
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

const OCCURRED_AT = new Date('2026-09-24T09:00:00.000Z');
const HTTP_DEMO_TYPE = 'test.http_demo.record';
const HTTP_DEMO_PERMISSION = 'test.http_demo.record';

// Écritures réelles (non annulées, voir helpers.ts) : mêmes helpers que sous withTestUow,
// portés par une vraie transaction commitée (db.transaction().execute fournit le
// Transaction<DB> qu'ils attendent).
async function createRealUser(): Promise<string> {
  return db.transaction().execute((trx) => insertTestUser(trx));
}

async function createRealDevice(enrolledBy: string): Promise<string> {
  return db.transaction().execute((trx) => insertTestDevice(trx, enrolledBy, { status: 'ACTIVE' }));
}

describe('POST /api/v1/commands, GET /health (câblage NestJS + Fastify)', () => {
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
      await insertTestPermission(trx, HTTP_DEMO_PERMISSION);
      const role = await insertTestRole(trx, user);
      await grantTestPermission(trx, role, HTTP_DEMO_PERMISSION, user);
      await assignTestRole(trx, user, role, user);
    });

    // Enregistrement du gestionnaire de démonstration dans le *vrai* registre de
    // l'application (celui que le contrôleur utilise) : prouve le trajet complet HTTP →
    // garde → pipeline → gestionnaire → réponse, sans dépendre d'un module métier construit.
    const registry = app.get<CommandHandlerRegistry>(COMMAND_HANDLER_REGISTRY);
    registry.register({
      commandType: HTTP_DEMO_TYPE,
      version: 1,
      payloadSchema: z.object({ note: z.string().min(1).max(200) }),
      permissionCode: HTTP_DEMO_PERMISSION,
      handler: async () => ({ status: 'APPLIED' as const }),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('GET /health répond 200 sans authentification', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready répond 200 (base joignable, retard du worker sous seuil)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(typeof body.checks.worker_lag_events).toBe('number');
  });

  it('POST /api/v1/commands sans Authorization renvoie 401 (apiErrorSchema)', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/commands', payload: {} });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(typeof body.error.correlation_id).toBe('string');
  });

  it(
    'correlation_id (P0-16, NFR-28) : présent sur toute réponse (en-tête), identique côté ' +
      'succès et dans la charge d’erreur, honoré quand le client en fournit un',
    async () => {
      const success = await app.inject({ method: 'GET', url: '/health' });
      expect(success.headers['x-correlation-id']).toBeTruthy();

      const failure = await app.inject({ method: 'POST', url: '/api/v1/commands', payload: {} });
      const failureHeader = failure.headers['x-correlation-id'];
      expect(failureHeader).toBeTruthy();
      expect(failure.json().error.correlation_id).toBe(failureHeader);

      // Un client (PWA) peut déjà porter son propre identifiant de corrélation : le serveur
      // le reprend tel quel plutôt que d'en fabriquer un second, pour une future corrélation
      // de bout en bout appareil → serveur.
      const clientProvided = 'client-side-correlation-42';
      const withClientId = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-correlation-id': clientProvided },
      });
      expect(withClientId.headers['x-correlation-id']).toBe(clientProvided);
    },
  );

  it('POST /api/v1/commands avec un jeton invalide renvoie 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { authorization: 'Bearer pas-un-jeton' },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/v1/commands avec une enveloppe malformée renvoie 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { authorization: `Bearer ${token}` },
      payload: { command_id: 'pas-un-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('chemin heureux bout en bout : garde → pipeline → gestionnaire → 200 APPLIED', async () => {
    const commandId = freshUuid();
    const envelope = {
      command_id: commandId,
      device_seq: 1,
      command_type: HTTP_DEMO_TYPE,
      command_version: 1,
      author_user_id: user,
      aggregate_type: 'TEST_SETTING',
      aggregate_id: freshUuid(),
      base_version: null,
      depends_on: [],
      occurred_at: OCCURRED_AT.toISOString(),
      client_created_at: OCCURRED_AT.toISOString(),
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: { note: 'via HTTP' },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { authorization: `Bearer ${token}` },
      payload: envelope,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ command_id: commandId, status: 'APPLIED' });

    // P0-16 (NFR-28) : le correlation_id de la requête HTTP se retrouve, identique, dans
    // l'audit et dans l'événement de domaine émis par cette même commande — pas seulement
    // dans une réponse d'erreur.
    const correlationId = response.headers['x-correlation-id'] as string;
    expect(correlationId).toBeTruthy();

    const auditRow = await db
      .selectFrom('audit_audit_log')
      .select('correlation_id')
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(auditRow.correlation_id).not.toBeNull();
    expect(fromBin(auditRow.correlation_id!)).toBe(correlationId);

    const eventRow = await db
      .selectFrom('platform_domain_events')
      .select('correlation_id')
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(eventRow.correlation_id).not.toBeNull();
    expect(fromBin(eventRow.correlation_id!)).toBe(correlationId);
  });
});

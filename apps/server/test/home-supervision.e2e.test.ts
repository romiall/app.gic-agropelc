/**
 * Accueil du rôle SUPERVISION (AV-529) de bout en bout : NestJS + Fastify, `app.inject()`, rôle réel du seed affecté en
 * portée GLOBAL, base réelle (même gabarit que `home.e2e.test.ts`).
 *
 * Démontre que l'accueil d'un compte de supervision consultative répond au contrat partagé avec la PWA, ne porte ni file
 * de validations ni conflits à traiter (rôle strictement consultatif), et montre la trésorerie, les ventes, les créances,
 * le stock et la production de toute l'entreprise sans lever d'erreur. Les chiffres globaux de la base de test, partagée
 * et persistante, ne sont jamais affirmés.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { homeResponseSchema, type HomeResponse } from '@gic/contracts';
import type { Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestUser,
  signTestAccessToken,
} from './helpers.js';

describe('Accueil du rôle SUPERVISION (AV-529)', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let supervisor: string;
  let supervisorDevice: string;
  let token: string;

  async function seededRole(code: string): Promise<string> {
    const role = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(role.id);
  }

  async function home(): Promise<HomeResponse> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/home',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    return homeResponseSchema.parse(response.json());
  }

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    clock = app.get(CLOCK);
    const jwtKeys = app.get(JWT_KEYS);
    const supervision = await seededRole('SUPERVISION');

    await db.transaction().execute(async (trx) => {
      supervisor = await insertTestUser(trx);
      supervisorDevice = await insertTestDevice(trx, supervisor, { status: 'ACTIVE' });
      await assignTestRole(trx, supervisor, supervision, supervisor);
    });
    token = await signTestAccessToken(
      jwtKeys.privateKey,
      { sub: supervisor, device_id: supervisorDevice, session_id: freshUuid() },
      clock.now(),
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeTestDb();
  });

  it('un seul rôle, une seule section, conforme au contrat partagé', async () => {
    const body = await home();
    expect(body.user.roles).toEqual(['SUPERVISION']);
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]?.role).toBe('SUPERVISION');
    expect(body.sections[0]?.roleLabel).toBe('Supervision consultative');
  });

  it('actions consultatives seulement : tour de contrôle, créances, coûts et marges, synchronisation', async () => {
    const body = await home();
    const codes = body.sections[0]!.actions.map((action) => action.code);
    expect(codes).toEqual(['CONTROL_TOWER', 'RECEIVABLES', 'COSTS_MARGINS', 'SYNC_STATUS']);
    expect(codes).not.toContain('VALIDATIONS');
    expect(codes).not.toContain('PRICES');
  });

  it('montre la trésorerie de toute l’entreprise, sans file de validations ni conflits à traiter', async () => {
    const body = await home();
    const kpiCodes = body.sections[0]!.kpis.map((kpi) => kpi.code);
    expect(kpiCodes).toContain('KPI-FIN-06');
    const signalCodes = body.signals.map((signal) => signal.code);
    expect(signalCodes).not.toContain('APPROVALS_PENDING');
    expect(signalCodes).not.toContain('SYNC_CONFLICTS');
  });
});

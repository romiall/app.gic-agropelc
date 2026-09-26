/**
 * Lectures HTTP du CRM et du pointage (P3-06, `crm-api/`, `fieldwork-api/`) de bout en bout :
 * NestJS + Fastify, `app.inject()` (même gabarit qu'inventory-read.e2e.test.ts), données écrites
 * par le vrai pipeline avec les rôles réels du seed.
 *
 * Démontre : portées OWN (commercial), TEAM (responsable), SITE (vendeur de PDV) et refus (403
 * sans droit, 404 hors portée, audités) ; ancrages par défaut ; contrôle de doublon masqué hors
 * périmètre (AV-014) ; fiche client avec historique et activité ; AT-015 — l'effort commercial
 * d'une journée, d'une semaine et d'une plage libre égale les opérations sous-jacentes ; sessions
 * et tentatives de pointage d'un jour métier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { convertOnConfirmedSale } from '../src/modules/crm/application/public/index.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const DAY = '2026-09-20';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const CENTER = { lat: 4.0511, lng: 9.7679 };
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
  token: string;
}

describe('Lectures HTTP du CRM et du pointage (P3-06)', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let cte1: Actor;
  let cte2: Actor;
  let rco: Actor;
  let ven: Actor;
  let mag: Actor;
  let zoneId: string;
  let siteId: string;
  let teamId: string;
  let outcomeId: string;
  let c1: string;
  let c2: string;
  let c3: string;
  let c4: string;
  let v1: string;
  let v2: string;
  let session1: string;
  let target1: string;
  const phone1 = `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  async function get(actor: Actor, url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${actor.token}` } });
  }

  async function command(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ) {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  async function createCustomer(
    actor: Actor,
    occurredAt: string,
    displayName: string,
    phone = `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
  ): Promise<string> {
    const id = freshUuid();
    await command(actor, 'crm.customer.create', 'CUSTOMER', id, occurredAt, {
      displayName,
      zoneId,
      sourceCode: 'PROSPECTION_TERRAIN',
      phonePrimary: phone,
      position: { ...CENTER, accuracyM: 10 },
    });
    return id;
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  const idsOf = (items: readonly { id: string }[]) => items.map((item) => item.id).sort();

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);
    const jwtKeys = app.get(JWT_KEYS);

    const roles = {
      cte: await roleId('COMMERCIAL_TERRAIN'),
      rco: await roleId('RESP_COMMERCIAL'),
      ven: await roleId('VENDEUR_PDV'),
      mag: await roleId('MAGASINIER'),
    };
    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      zoneId = await insertTestZone(trx, admin);
      await trx
        .updateTable('organization_zones')
        .set({
          geofence_lat: String(CENTER.lat),
          geofence_lng: String(CENTER.lng),
          geofence_radius_m: '500',
        })
        .where('id', '=', toBin(zoneId))
        .execute();
      siteId = await insertTestSite(trx, admin, zoneId);
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = {},
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, admin, options);
        return { userId, deviceId, token: '' };
      };
      cte1 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      cte2 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      const rcoId = await insertTestUser(trx);
      teamId = await insertTestTeam(trx, rcoId, admin);
      await insertTestTeamMembership(trx, teamId, cte1.userId, admin);
      await insertTestTeamMembership(trx, teamId, cte2.userId, admin);
      await assignTestRole(trx, rcoId, roles.rco, admin, {
        scopeType: 'TEAM',
        scopeTeamId: teamId,
      });
      rco = { userId: rcoId, deviceId: await insertTestDevice(trx, rcoId), token: '' };
      ven = await actor(roles.ven, { scopeType: 'SITE', scopeSiteId: siteId });
      mag = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteId });

      outcomeId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(outcomeId),
          category: 'VISIT_OUTCOME',
          code: `TEST_${outcomeId.replace(/-/g, '').slice(-12).toUpperCase()}`,
          label: 'Intéressé',
          created_by: toBin(admin),
        })
        .execute();
    });
    for (const actor of [cte1, cte2, rco, ven, mag]) {
      actor.token = await signAccessToken(
        jwtKeys.privateKey,
        { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
        clock.now(),
      );
    }

    // Journée du 20/09 : portefeuilles, pointage, visites, interaction, objectif, conversion.
    c1 = await createCustomer(cte1, at('07:00:00'), 'Boutique Mama Akwa', phone1);
    c2 = await createCustomer(cte1, at('07:05:00'), 'Quincaillerie Bonamoussadi');
    c3 = await createCustomer(cte2, at('07:10:00'), 'Dépôt Ndokoti');
    const venCustomer = freshUuid();
    await command(ven, 'crm.customer.create', 'CUSTOMER', venCustomer, at('07:15:00'), {
      displayName: 'Client comptoir',
      zoneId,
      sourceCode: 'VISITE_SPONTANEE',
      phonePrimary: `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    });
    c4 = venCustomer;
    session1 = freshUuid();
    await command(cte1, 'fieldwork.checkin.record', 'GEO_CHECKIN', freshUuid(), at('06:30:00'), {
      checkinType: 'START_SERVICE',
      declaredZoneId: zoneId,
      position: CENTER,
      accuracyM: 12,
      clientResult: 'ACCEPTED',
      sessionId: session1,
    });
    v1 = freshUuid();
    await command(cte1, 'crm.visit.record', 'VISIT', v1, at('08:00:00'), {
      customerId: c1,
      position: { ...CENTER, accuracyM: 8 },
      outcomeReasonCodeId: outcomeId,
    });
    v2 = freshUuid();
    await command(cte2, 'crm.visit.record', 'VISIT', v2, at('08:30:00'), {
      customerId: c3,
      position: null,
      outcomeReasonCodeId: outcomeId,
    });
    await command(cte1, 'crm.interaction.record', 'INTERACTION', freshUuid(), at('09:00:00'), {
      customerId: c1,
      channel: 'APPEL',
    });
    target1 = freshUuid();
    await command(rco, 'crm.target.set', 'SALES_TARGET', target1, at('06:00:00'), {
      targetType: 'USER',
      userId: cte1.userId,
      metric: 'VISITES',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      targetValue: 10,
    });
    await db.transaction().execute((trx) =>
      convertOnConfirmedSale(trx, {
        customerId: c2,
        saleId: freshUuid(),
        saleOccurredAt: new Date(at('10:00:00')),
        actorUserId: cte1.userId,
        historyId: freshUuid(),
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('GET /customers : portefeuille par défaut selon la portée — OWN, TEAM, SITE', async () => {
    const own = await get(cte1, '/api/v1/customers');
    expect(own.statusCode, own.body).toBe(200);
    expect(idsOf(own.json().customers)).toEqual([c1, c2].sort());
    const team = await get(rco, '/api/v1/customers');
    expect(idsOf(team.json().customers)).toEqual([c1, c2, c3].sort());
    const pos = await get(ven, '/api/v1/customers');
    expect(idsOf(pos.json().customers)).toEqual([c4]);
    // Ancrage sur le portefeuille d'un collègue : rien hors portée n'est renvoyé.
    const colleague = await get(cte2, `/api/v1/customers?owner=${cte1.userId}`);
    expect(colleague.json().customers).toEqual([]);
    const search = await get(cte1, '/api/v1/customers?q=Mama');
    expect(idsOf(search.json().customers)).toEqual([c1]);
    const converted = await get(cte1, '/api/v1/customers?stage=CUSTOMER');
    expect(idsOf(converted.json().customers)).toEqual([c2]);
    expect((await get(mag, '/api/v1/customers')).statusCode).toBe(403);
  });

  it('GET /customers/{id} : fiche avec titulaires, historique et activité ; hors portée ⇒ 404 audité', async () => {
    const outside = await get(cte1, `/api/v1/customers/${c3}`);
    expect(outside.statusCode).toBe(404);
    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result'])
      .where('actor_user_id', '=', toBin(cte1.userId))
      .where('entity_id', '=', toBin(c3))
      .executeTakeFirstOrThrow();
    expect(denied).toEqual({ action: 'access.denied', result: 'DENIED' });

    const sheet = await get(rco, `/api/v1/customers/${c3}`);
    expect(sheet.statusCode, sheet.body).toBe(200);
    const body = sheet.json();
    expect(body.customer.id).toBe(c3);
    expect(body.assignments).toHaveLength(1);
    expect(body.stage_history.map((h: { toStage: string }) => h.toStage)).toEqual(['PROSPECT']);
    expect(idsOf(body.recent_visits)).toEqual([v2]);
    expect(body.recent_visits[0].flags).toEqual(['OUT_OF_SESSION']);
    expect((await get(mag, `/api/v1/customers/${c3}`)).statusCode).toBe(403);
  });

  it('GET /customers/duplicate-check : réponse masquée hors périmètre (AV-014)', async () => {
    const byColleague = await get(cte2, `/api/v1/customers/duplicate-check?phone=${phone1}`);
    expect(byColleague.statusCode, byColleague.body).toBe(200);
    expect(byColleague.json()).toEqual({
      phone: `+237${phone1}`,
      exists: true,
      in_scope: false,
      message: 'Compte existant, suivi par un autre commercial.',
    });
    const byOwner = await get(cte1, `/api/v1/customers/duplicate-check?phone=%2B237${phone1}`);
    expect(byOwner.json()).toMatchObject({ exists: true, in_scope: true, customer: { id: c1 } });
    const unknown = await get(cte1, '/api/v1/customers/duplicate-check?phone=699000001');
    expect(unknown.json().exists).toBe(false);
    const invalid = await get(cte1, '/api/v1/customers/duplicate-check?phone=abc');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('PHONE_INVALID');
  });

  it('GET /visits, /interactions : activité de soi, de l’équipe ; filtrage par période', async () => {
    const mine = await get(cte1, '/api/v1/visits');
    expect(mine.statusCode, mine.body).toBe(200);
    expect(idsOf(mine.json().visits)).toEqual([v1]);
    expect(mine.json().visits[0].workSessionId).toBe(session1);
    const team = await get(rco, '/api/v1/visits');
    expect(idsOf(team.json().visits)).toEqual([v1, v2].sort());
    const colleague = await get(cte2, `/api/v1/visits?user_id=${cte1.userId}`);
    expect(colleague.json().visits).toEqual([]);
    const later = await get(cte1, '/api/v1/visits?from=2026-09-21');
    expect(later.json().visits).toEqual([]);
    const byCustomer = await get(cte1, `/api/v1/visits?customer_id=${c1}&from=${DAY}&to=${DAY}`);
    expect(idsOf(byCustomer.json().visits)).toEqual([v1]);
    const interactions = await get(cte1, '/api/v1/interactions');
    expect(interactions.json().interactions).toHaveLength(1);
    expect(interactions.json().interactions[0].channel).toBe('APPEL');
  });

  it('GET /targets : ses objectifs, ceux de l’équipe pour le responsable', async () => {
    const mine = await get(cte1, '/api/v1/targets');
    expect(mine.statusCode, mine.body).toBe(200);
    expect(idsOf(mine.json().targets)).toEqual([target1]);
    expect(mine.json().targets[0]).toMatchObject({
      metric: 'VISITES',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      targetValue: 10,
    });
    const byManager = await get(rco, `/api/v1/targets?user_id=${cte1.userId}`);
    expect(idsOf(byManager.json().targets)).toEqual([target1]);
    const byColleague = await get(cte2, `/api/v1/targets?user_id=${cte1.userId}`);
    expect(byColleague.json().targets).toEqual([]);
  });

  it('AT-015 : effort commercial — jour, semaine, plage libre égaux aux opérations sous-jacentes', async () => {
    const expected = {
      prospectsCreated: 2,
      visits: 1,
      customersVisited: 1,
      prospectsVisited: 1,
      interactions: 1,
      newCustomers: 1,
    };
    for (const [from, to] of [
      [DAY, DAY],
      ['2026-09-14', '2026-09-20'],
      ['2026-09-01', '2026-09-25'],
    ]) {
      const response = await get(cte1, `/api/v1/performance/commercial?from=${from}&to=${to}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().effort).toEqual(expected);
      expect(response.json().targets).toMatchObject([{ id: target1, realized: 1 }]);
    }
    const empty = await get(cte1, '/api/v1/performance/commercial?from=2026-09-21&to=2026-09-21');
    expect(empty.json().effort).toMatchObject({ visits: 0, prospectsCreated: 0 });
    expect(
      (
        await get(
          rco,
          `/api/v1/performance/commercial?user_id=${cte1.userId}&from=${DAY}&to=${DAY}`,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await get(
          cte2,
          `/api/v1/performance/commercial?user_id=${cte1.userId}&from=${DAY}&to=${DAY}`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('GET /work-sessions : sessions et tentatives du jour, par agent ou par équipe', async () => {
    const mine = await get(cte1, `/api/v1/work-sessions?date=${DAY}`);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(idsOf(mine.json().sessions)).toEqual([session1]);
    expect(mine.json().checkins).toHaveLength(1);
    expect(mine.json().checkins[0].serverResult).toBe('ACCEPTED');
    const team = await get(rco, `/api/v1/work-sessions?team_id=${teamId}&date=${DAY}`);
    expect(idsOf(team.json().sessions)).toEqual([session1]);
    const colleague = await get(cte2, `/api/v1/work-sessions?user_id=${cte1.userId}&date=${DAY}`);
    expect(colleague.json().sessions).toEqual([]);
    expect((await get(mag, `/api/v1/work-sessions?date=${DAY}`)).statusCode).toBe(403);
  });
});

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
import { sql } from 'kysely';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import {
  convertOnConfirmedSale,
  listTargets,
} from '../src/modules/crm/application/public/index.js';
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
  freshLocalPhone,
  signTestAccessToken,
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
  let phone1: string;

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
    phone?: string,
  ): Promise<string> {
    const id = freshUuid();
    await command(actor, 'crm.customer.create', 'CUSTOMER', id, occurredAt, {
      displayName,
      zoneId,
      sourceCode: 'PROSPECTION_TERRAIN',
      phonePrimary: phone ?? (await freshLocalPhone()),
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
    phone1 = await freshLocalPhone();
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
      actor.token = await signTestAccessToken(
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
      phonePrimary: await freshLocalPhone(),
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
    // S-39 (AV-522) : sans paramètre, le responsable lit aussi les objectifs des membres de l'équipe qu'il dirige.
    const teamDefault = await get(rco, '/api/v1/targets');
    expect(teamDefault.statusCode, teamDefault.body).toBe(200);
    expect(idsOf(teamDefault.json().targets)).toContain(target1);
    // Un collègue sans équipe dirigée ne lit toujours pas l'objectif d'un autre.
    const colleagueDefault = await get(cte2, '/api/v1/targets');
    expect(idsOf(colleagueDefault.json().targets)).not.toContain(target1);
    const byColleague = await get(cte2, `/api/v1/targets?user_id=${cte1.userId}`);
    expect(byColleague.json().targets).toEqual([]);
  });

  it('GET /targets : les objectifs de l’équipe dirigée se filtrent dans la requête, pas après un plafond de lecture (S-39)', async () => {
    const teamTarget = freshUuid();
    await command(rco, 'crm.target.set', 'SALES_TARGET', teamTarget, at('06:05:00'), {
      targetType: 'TEAM',
      teamId,
      metric: 'VISITES',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      targetValue: 40,
    });
    // L'équipe d'un autre responsable, avec un objectif plus récent (période commencée plus tard) : trié avant celui du
    // responsable, il le chasserait d'une lecture plafonnée si le tri sur le responsable se faisait après coup.
    const otherTeamTarget = freshUuid();
    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      const otherManager = await insertTestUser(trx);
      const otherTeam = await insertTestTeam(trx, otherManager, admin);
      await trx
        .insertInto('crm_sales_targets')
        .values({
          id: toBin(otherTeamTarget),
          target_type: 'TEAM',
          team_id: toBin(otherTeam),
          metric: 'VISITES',
          period_start: new Date('2026-09-10T00:00:00.000Z'),
          period_end: new Date('2026-09-30T00:00:00.000Z'),
          target_value: 25,
          created_by: toBin(admin),
        })
        .execute();
    });

    const response = await get(rco, '/api/v1/targets');
    expect(response.statusCode, response.body).toBe(200);
    expect(idsOf(response.json().targets)).toContain(teamTarget);
    expect(idsOf(response.json().targets)).not.toContain(otherTeamTarget);
    // Un commercial ne lit pas l'objectif de l'équipe d'un autre.
    const colleague = await get(cte2, '/api/v1/targets');
    expect(idsOf(colleague.json().targets)).not.toContain(teamTarget);

    // Plafonnée à une ligne, la lecture rend quand même l'objectif de l'équipe dirigée : le filtre est dans la requête.
    const capped = await listTargets(db, {
      targetType: 'TEAM',
      teamManagerUserId: rco.userId,
      limit: 1,
    });
    expect(capped.map((target) => target.id)).toEqual([teamTarget]);
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

  // ---- PP-E : présence du personnel (fiche PT, AV-313) et bilan hebdomadaire (fiche BH, AV-314) ----------------
  describe('présence du personnel et bilan hebdomadaire (PP-E)', () => {
    /** Lundi de la semaine du 20/09 (journée de données ci-dessus). */
    const WEEK = '2026-09-14';
    let rfe: Actor;
    let rfeOther: Actor;
    /** Responsable de production : affectation globale, droits de présence « de site ». */
    let rpr: Actor;
    let dir: Actor;
    let rcoOther: Actor;
    let siteOther: string;
    const sheetId = freshUuid();
    const reportId = freshUuid();

    async function attempt(
      actor: Actor,
      commandType: string,
      aggregateType: string,
      aggregateId: string,
      occurredAt: string,
      payload: unknown,
      baseVersion: number | null = null,
    ) {
      return pipeline.handle(
        {
          command_id: freshUuid(),
          device_seq: ++deviceSeq,
          command_version: 1,
          command_type: commandType,
          aggregate_type: aggregateType,
          aggregate_id: aggregateId,
          author_user_id: actor.userId,
          base_version: baseVersion,
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
    }
    const code = (r: Awaited<ReturnType<typeof attempt>>) =>
      r.status === 'REJECTED' ? r.error.code : r.status;

    beforeAll(async () => {
      const jwtKeys = app.get(JWT_KEYS);
      await db.transaction().execute(async (trx) => {
        const admin = await insertTestUser(trx);
        siteOther = await insertTestSite(trx, admin, zoneId);
        const actor = async (
          role: string,
          options: Parameters<typeof assignTestRole>[4] = {},
        ): Promise<Actor> => {
          const userId = await insertTestUser(trx);
          const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
          await assignTestRole(trx, userId, role, admin, options);
          return { userId, deviceId, token: '' };
        };
        rfe = await actor(await roleId('RESP_FERME'), { scopeType: 'SITE', scopeSiteId: siteId });
        rfeOther = await actor(await roleId('RESP_FERME'), {
          scopeType: 'SITE',
          scopeSiteId: siteOther,
        });
        dir = await actor(await roleId('DIRECTION'));
        rpr = await actor(await roleId('RESP_PRODUCTION'));
        const rcoOtherId = await insertTestUser(trx);
        const emptyTeam = await insertTestTeam(trx, rcoOtherId, admin);
        await assignTestRole(trx, rcoOtherId, await roleId('RESP_COMMERCIAL'), admin, {
          scopeType: 'TEAM',
          scopeTeamId: emptyTeam,
        });
        rcoOther = {
          userId: rcoOtherId,
          deviceId: await insertTestDevice(trx, rcoOtherId),
          token: '',
        };
      });
      for (const a of [rfe, rfeOther, rpr, dir, rcoOther]) {
        a.token = await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: a.userId, device_id: a.deviceId, session_id: freshUuid() },
          clock.now(),
        );
      }
    });

    const sheetPayload = (overrides: Record<string, unknown> = {}) => ({
      siteId,
      weekStart: WEEK,
      paperRef: '000042',
      responsibleName: 'Joseph Ngo Bayiha',
      lines: [
        {
          personName: 'Paul Essomba',
          personRole: 'Ouvrier',
          missionLabel: 'Poulailler B2',
          days: [
            { date: '2026-09-14', arrival: '07:00', departure: '16:00' },
            { date: '2026-09-15', absenceCode: 'M' },
            { date: '2026-09-16', arrival: '07:15', departure: '15:30' },
          ],
        },
        {
          personName: 'Rose Atangana',
          days: [{ date: '2026-09-14', arrival: '18:00', departure: '23:30' }],
        },
      ],
      ...overrides,
    });

    it('fieldwork.presence.record : feuille reportée par le responsable du site, rejeu sans doublon, lecture bornée au site', async () => {
      const first = await attempt(
        rfe,
        'fieldwork.presence.record',
        'PRESENCE_SHEET',
        sheetId,
        `${DAY}T10:00:00.000Z`,
        sheetPayload(),
      );
      expect(first.status, JSON.stringify(first)).toBe('APPLIED');
      // Même feuille renvoyée sous une autre commande : reconnue, aucune ligne en double.
      const replay = await attempt(
        rfe,
        'fieldwork.presence.record',
        'PRESENCE_SHEET',
        sheetId,
        `${DAY}T10:05:00.000Z`,
        sheetPayload(),
      );
      expect(replay.status, JSON.stringify(replay)).toBe('APPLIED');
      const rows = await db
        .selectFrom('fieldwork_staff_presence')
        .select('id')
        .where('sheet_id', '=', toBin(sheetId))
        .execute();
      expect(rows).toHaveLength(4);

      const mine = await get(rfe, `/api/v1/staff-presence?week_start=${WEEK}`);
      expect(mine.statusCode, mine.body).toBe(200);
      const sheets = mine.json().sheets as {
        id: string;
        paperRef: string;
        responsibleName: string;
        status: string;
        lines: {
          personName: string;
          days: { date: string; arrival: string | null; absenceCode: string | null }[];
        }[];
      }[];
      expect(sheets.map((s) => s.id)).toEqual([sheetId]);
      expect(sheets[0]).toMatchObject({
        paperRef: '000042',
        responsibleName: 'Joseph Ngo Bayiha',
        status: 'RECORDED',
      });
      expect(sheets[0]!.lines.map((l) => l.personName)).toEqual(['Paul Essomba', 'Rose Atangana']);
      expect(sheets[0]!.lines[0]!.days).toEqual([
        { date: '2026-09-14', arrival: '07:00', departure: '16:00', absenceCode: null },
        { date: '2026-09-15', arrival: null, departure: null, absenceCode: 'M' },
        { date: '2026-09-16', arrival: '07:15', departure: '15:30', absenceCode: null },
      ]);
      // Portée : un responsable d'un autre site ne la voit pas ; la Direction, si ; un commercial n'a pas le droit.
      expect(
        (await get(rfeOther, `/api/v1/staff-presence?week_start=${WEEK}`)).json().sheets,
      ).toEqual([]);
      expect(
        (await get(rfeOther, `/api/v1/staff-presence?site_id=${siteId}&week_start=${WEEK}`)).json()
          .sheets,
      ).toEqual([]);
      expect(
        (await get(dir, `/api/v1/staff-presence?week_start=${WEEK}`))
          .json()
          .sheets.map((s: { id: string }) => s.id),
      ).toContain(sheetId);
      expect((await get(cte1, `/api/v1/staff-presence?week_start=${WEEK}`)).statusCode).toBe(403);
    });

    it('fieldwork.presence.record : site hors périmètre, droit absent et feuille invalide sont refusés', async () => {
      const at10 = `${DAY}T10:30:00.000Z`;
      const record = (actor: Actor, payload: unknown) =>
        attempt(actor, 'fieldwork.presence.record', 'PRESENCE_SHEET', freshUuid(), at10, payload);
      expect(code(await record(rfeOther, sheetPayload()))).toBe('FORBIDDEN_SCOPE');
      expect((await record(cte1, sheetPayload())).status).toBe('REJECTED');
      expect(code(await record(rfe, sheetPayload({ siteId: freshUuid() })))).toBe('SITE_NOT_FOUND');
      expect(code(await record(rfe, sheetPayload({ weekStart: '2026-09-15' })))).toBe(
        'PRESENCE_WEEK_NOT_MONDAY',
      );
      expect(
        code(
          await record(
            rfe,
            sheetPayload({
              lines: [{ personName: 'A', days: [{ date: '2026-09-21', arrival: '07:00' }] }],
            }),
          ),
        ),
      ).toBe('PRESENCE_DAY_OUT_OF_WEEK');
      expect(
        code(
          await record(
            rfe,
            sheetPayload({
              lines: [
                {
                  personName: 'A',
                  days: [{ date: '2026-09-14', arrival: '07:00', absenceCode: 'A' }],
                },
              ],
            }),
          ),
        ),
      ).toBe('PRESENCE_ABSENCE_WITH_TIMES');
      expect(
        code(
          await record(
            rfe,
            sheetPayload({
              lines: [
                {
                  personName: 'A',
                  days: [{ date: '2026-09-14', arrival: '16:00', departure: '07:00' }],
                },
              ],
            }),
          ),
        ),
      ).toBe('PRESENCE_DEPARTURE_NOT_AFTER_ARRIVAL');
      const day = { date: '2026-09-14', absenceCode: 'R' };
      expect(
        code(
          await record(
            rfe,
            sheetPayload({
              lines: [
                { personName: 'Paul', days: [day] },
                { personName: ' paul ', days: [day] },
              ],
            }),
          ),
        ),
      ).toBe('PRESENCE_PERSON_DUPLICATE');
      expect(
        code(
          await record(
            rfe,
            sheetPayload({ lines: [{ personName: 'A', userId: freshUuid(), days: [day] }] }),
          ),
        ),
      ).toBe('REFERENCE_INVALID');
    });

    it('fieldwork.presence.cancel : annulation motivée, rien ne disparaît, feuille figée', async () => {
      const cancel = (actor: Actor, comment: string) =>
        attempt(
          actor,
          'fieldwork.presence.cancel',
          'PRESENCE_SHEET',
          sheetId,
          `${DAY}T11:00:00.000Z`,
          { comment },
        );
      expect(code(await cancel(rfeOther, 'Pas ma feuille'))).toBe('FORBIDDEN_SCOPE');
      const done = await cancel(rfe, 'Feuille saisie deux fois');
      expect(done.status, JSON.stringify(done)).toBe('APPLIED');
      expect(code(await cancel(rfe, 'Encore'))).toBe('ALREADY_CANCELLED');
      expect((await get(rfe, `/api/v1/staff-presence?week_start=${WEEK}`)).json().sheets).toEqual(
        [],
      );
      const all = await get(
        rfe,
        `/api/v1/staff-presence?week_start=${WEEK}&include_cancelled=true`,
      );
      expect(all.json().sheets).toMatchObject([
        { id: sheetId, status: 'CANCELLED', cancelComment: 'Feuille saisie deux fois' },
      ]);
      // La feuille et ses lignes ne se modifient ni ne se suppriment (déclencheurs).
      await expect(
        db
          .updateTable('fieldwork_presence_sheets')
          .set({ paper_ref: 'X' })
          .where('id', '=', toBin(sheetId))
          .execute(),
      ).rejects.toThrow();
      await expect(
        db
          .updateTable('fieldwork_staff_presence')
          .set({ person_name: 'X' })
          .where('sheet_id', '=', toBin(sheetId))
          .execute(),
      ).rejects.toThrow();
      await expect(
        db.deleteFrom('fieldwork_staff_presence').where('sheet_id', '=', toBin(sheetId)).execute(),
      ).rejects.toThrow();
      // Une feuille annulée ne redevient pas `RECORDED` (garde du déclencheur, règle 4).
      await expect(
        db
          .updateTable('fieldwork_presence_sheets')
          .set({
            status: 'RECORDED',
            cancelled_at: null,
            cancelled_by: null,
            cancel_comment: null,
          })
          .where('id', '=', toBin(sheetId))
          .execute(),
      ).rejects.toThrow();
    });

    it('fieldwork.presence.record : un identifiant déjà pris par une autre feuille, ou par une feuille annulée, n’est pas un rejeu', async () => {
      const record = (actor: Actor, payload: unknown) =>
        attempt(
          actor,
          'fieldwork.presence.record',
          'PRESENCE_SHEET',
          sheetId,
          `${DAY}T12:00:00.000Z`,
          payload,
        );
      // La feuille a été annulée plus haut : la renvoyer à l'identique ne réussit pas en silence (rien n'est reporté).
      expect(code(await record(rfe, sheetPayload()))).toBe('PRESENCE_SHEET_CANCELLED');
      // Autre contenu sous le même identifiant, ou même contenu d'un autre auteur : refusé, jamais avalé.
      expect(code(await record(rfe, sheetPayload({ paperRef: '000043' })))).toBe(
        'PRESENCE_ID_TAKEN',
      );
      expect(code(await record(dir, sheetPayload()))).toBe('PRESENCE_ID_TAKEN');
      const rows = await db
        .selectFrom('fieldwork_staff_presence')
        .select('id')
        .where('sheet_id', '=', toBin(sheetId))
        .execute();
      expect(rows).toHaveLength(4);
    });

    it('fieldwork.presence.record : une semaine qui n’a pas commencé est refusée, elle se reporte dès qu’elle a commencé', async () => {
      // DAY est un dimanche : la semaine du lundi 21/09 n'a pas encore commencé.
      const next = sheetPayload({
        weekStart: '2026-09-21',
        lines: [
          { personName: 'A', days: [{ date: '2026-09-21', arrival: '07:00', departure: '16:00' }] },
        ],
      });
      const record = (occurredAt: string) =>
        attempt(rfe, 'fieldwork.presence.record', 'PRESENCE_SHEET', freshUuid(), occurredAt, next);
      expect(code(await record(`${DAY}T10:00:00.000Z`))).toBe('PRESENCE_WEEK_IN_FUTURE');
      const started = await record('2026-09-21T08:00:00.000Z');
      expect(started.status, JSON.stringify(started)).toBe('APPLIED');
    });

    it('GET /staff-presence : un responsable de production (affectation globale, droits de site) lit les feuilles de tous les sites', async () => {
      const ids = [freshUuid(), freshUuid()];
      const sites = [siteId, siteOther];
      for (const [index, id] of ids.entries()) {
        const recorded = await attempt(
          rpr,
          'fieldwork.presence.record',
          'PRESENCE_SHEET',
          id,
          `${DAY}T13:00:00.000Z`,
          sheetPayload({ siteId: sites[index], paperRef: `RPR-${index}` }),
        );
        expect(recorded.status, JSON.stringify(recorded)).toBe('APPLIED');
      }
      const idsOf = async (query: string) =>
        ((await get(rpr, `/api/v1/staff-presence?${query}`)).json().sheets as { id: string }[]).map(
          (sheet) => sheet.id,
        );
      expect(await idsOf(`week_start=${WEEK}`)).toEqual(expect.arrayContaining(ids));
      const other = await idsOf(`site_id=${siteOther}&week_start=${WEEK}`);
      expect(other).toContain(ids[1]);
      expect(other).not.toContain(ids[0]);
    });

    it('fieldwork.presence.record : la seconde feuille du même site, de la même semaine et du même numéro est enregistrée avec un avertissement (AV-514 (6))', async () => {
      const PAST_WEEK = '2026-09-07';
      const record = (actor: Actor, overrides: Record<string, unknown>, id = freshUuid()) =>
        attempt(
          actor,
          'fieldwork.presence.record',
          'PRESENCE_SHEET',
          id,
          `${DAY}T14:00:00.000Z`,
          sheetPayload({
            weekStart: PAST_WEEK,
            lines: [
              {
                personName: 'Alain',
                days: [{ date: PAST_WEEK, arrival: '07:00', departure: '16:00' }],
              },
            ],
            ...overrides,
          }),
        );
      const cancel = (id: string) =>
        attempt(rfe, 'fieldwork.presence.cancel', 'PRESENCE_SHEET', id, `${DAY}T15:00:00.000Z`, {
          comment: 'Feuille en double',
        });
      const warningsOf = (result: Awaited<ReturnType<typeof attempt>>) =>
        'warnings' in result ? result.warnings : [];
      /** Feuilles non annulées du site pour la semaine d'essai, avec leur numéro tel qu'il est enregistré. */
      const liveSheets = async () =>
        db
          .selectFrom('fieldwork_presence_sheets')
          .select(['id', 'paper_ref'])
          .where('site_id', '=', toBin(siteId))
          .where(sql<boolean>`week_start = ${PAST_WEEK}`)
          .where('status', '=', 'RECORDED')
          .execute();

      const firstId = freshUuid();
      const first = await record(rfe, { paperRef: 'DUP-7' }, firstId);
      expect(first.status, JSON.stringify(first)).toBe('APPLIED');

      // Le même numéro écrit autrement (casse, espaces) sous un autre identifiant : enregistrée, et signalée.
      const secondId = freshUuid();
      const second = await record(rfe, { paperRef: ' dup-7 ' }, secondId);
      expect(second.status, JSON.stringify(second)).toBe('APPLIED_WITH_WARNINGS');
      expect(warningsOf(second)).toEqual(['PRESENCE_SHEET_DUPLICATE']);
      expect((await liveSheets()).map((sheet) => sheet.paper_ref).sort()).toEqual([
        'DUP-7',
        'dup-7',
      ]);

      // Un autre numéro, aucun numéro, ou le même numéro sur un autre site : pas de signalement.
      expect((await record(rfe, { paperRef: 'DUP-8' })).status).toBe('APPLIED');
      expect((await record(rfe, { paperRef: null })).status).toBe('APPLIED');
      expect((await record(rfe, { paperRef: null })).status).toBe('APPLIED');
      const elsewhere = await record(rfeOther, { paperRef: 'DUP-7', siteId: siteOther });
      expect(elsewhere.status, JSON.stringify(elsewhere)).toBe('APPLIED');

      // Le rejeu de la seconde feuille (même identifiant, même contenu) ne double rien : le flux n'est pas signalé deux fois.
      const before = (await liveSheets()).length;
      const replay = await record(rfe, { paperRef: ' dup-7 ' }, secondId);
      expect(replay.status, JSON.stringify(replay)).toBe('APPLIED');
      expect((await liveSheets()).length).toBe(before);

      // Une feuille annulée ne compte pas : les deux annulées, le numéro se reporte sans signalement.
      expect((await cancel(firstId)).status).toBe('APPLIED');
      expect((await cancel(secondId)).status).toBe('APPLIED');
      const third = await record(rfe, { paperRef: 'DUP-7' });
      expect(third.status, JSON.stringify(third)).toBe('APPLIED');
      // La troisième est vivante : la quatrième est signalée à son tour.
      expect(warningsOf(await record(rfe, { paperRef: 'DUP-7' }))).toEqual([
        'PRESENCE_SHEET_DUPLICATE',
      ]);
    });

    it('GET /staff-presence et /weekly-reports : une date impossible est un 400, jamais une erreur serveur', async () => {
      expect((await get(dir, '/api/v1/staff-presence?week_start=2026-02-30')).statusCode).toBe(400);
      expect((await get(dir, '/api/v1/weekly-reports?week_start=2026-13-01')).statusCode).toBe(400);
      expect(
        (await get(dir, '/api/v1/weekly-reports/figures?week_start=2026-02-30')).statusCode,
      ).toBe(400);
    });

    it('crm.weekly_report.submit : rédaction, validations, correction (le plus récent l’emporte), bilan d’un autre refusé', async () => {
      const submit = (actor: Actor, id: string, occurredAt: string, payload: unknown) =>
        attempt(actor, 'crm.weekly_report.submit', 'WEEKLY_REPORT', id, occurredAt, payload);
      const MONDAY_AFTER = '2026-09-21T10:00:00.000Z';
      expect(code(await submit(cte1, freshUuid(), MONDAY_AFTER, { weekStart: WEEK }))).toBe(
        'REPORT_EMPTY',
      );
      expect(
        code(
          await submit(cte1, freshUuid(), MONDAY_AFTER, {
            weekStart: '2026-09-15',
            successes: 'x',
          }),
        ),
      ).toBe('REPORT_WEEK_INVALID');
      expect(
        code(
          await submit(cte1, freshUuid(), MONDAY_AFTER, {
            weekStart: '2026-09-28',
            successes: 'x',
          }),
        ),
      ).toBe('REPORT_WEEK_INVALID');
      expect(
        (await submit(mag, freshUuid(), MONDAY_AFTER, { weekStart: WEEK, successes: 'x' })).status,
      ).toBe('REJECTED');

      const first = await submit(cte1, reportId, MONDAY_AFTER, {
        weekStart: WEEK,
        successes: 'Deux commandes',
        needs: 'Plateaux',
      });
      expect(first.status, JSON.stringify(first)).toBe('APPLIED');
      const read = async (actor: Actor, query: string) =>
        (await get(actor, `/api/v1/weekly-reports?${query}`)).json().reports as {
          id: string;
          userId: string;
          status: string;
          successes: string | null;
          needs: string | null;
          version: number;
          managerComment: string | null;
        }[];
      expect(await read(cte1, `user_id=me&week_start=${WEEK}`)).toMatchObject([
        {
          id: reportId,
          userId: cte1.userId,
          status: 'SUBMITTED',
          successes: 'Deux commandes',
          needs: 'Plateaux',
          version: 1,
        },
      ]);

      // Correction plus récente : texte remplacé ; envoi plus ancien arrivé après : ignoré.
      expect(
        (
          await submit(cte1, reportId, '2026-09-21T12:00:00.000Z', {
            weekStart: WEEK,
            successes: 'Trois commandes',
          })
        ).status,
      ).toBe('APPLIED');
      expect(
        (
          await submit(cte1, reportId, '2026-09-21T09:00:00.000Z', {
            weekStart: WEEK,
            successes: 'Ancien texte',
          })
        ).status,
      ).toBe('APPLIED');
      expect(await read(cte1, `user_id=me&week_start=${WEEK}`)).toMatchObject([
        { successes: 'Trois commandes', needs: null, version: 2 },
      ]);

      // Le bilan d'un autre commercial ne se réécrit pas ; une seconde fiche pour la même semaine est refusée.
      expect(
        code(
          await submit(cte2, reportId, '2026-09-21T13:00:00.000Z', {
            weekStart: WEEK,
            successes: 'Détournement',
          }),
        ),
      ).toBe('FORBIDDEN_SCOPE');
      expect(
        code(
          await submit(cte1, freshUuid(), '2026-09-21T13:00:00.000Z', {
            weekStart: WEEK,
            successes: 'Autre fiche',
          }),
        ),
      ).toBe('REPORT_EXISTS');

      // Lecture : le sien, celui de l'équipe pour le responsable, rien pour un collègue ou un autre responsable.
      expect((await read(rco, `week_start=${WEEK}`)).map((r) => r.id)).toEqual([reportId]);
      expect((await read(dir, `week_start=${WEEK}`)).map((r) => r.id)).toContain(reportId);
      expect(await read(cte2, `user_id=${cte1.userId}&week_start=${WEEK}`)).toEqual([]);
      expect(await read(rcoOther, `week_start=${WEEK}`)).toEqual([]);
      expect((await get(mag, `/api/v1/weekly-reports?week_start=${WEEK}`)).statusCode).toBe(403);
    });

    it('GET /weekly-reports/figures : chiffres calculés de la semaine, valeur des pertes masquée sans droit de valorisation', async () => {
      const expected = {
        visits: 1,
        newProspects: 2,
        newCustomers: 1,
        salesXaf: 0,
        collectedXaf: 0,
        lossDeclarations: 0,
      };
      const own = await get(cte1, `/api/v1/weekly-reports/figures?week_start=${WEEK}`);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().figures).toEqual({ ...expected, lossValueXaf: null });
      const team = await get(
        rco,
        `/api/v1/weekly-reports/figures?user_id=${cte1.userId}&week_start=${WEEK}`,
      );
      expect(team.json().figures).toEqual({ ...expected, lossValueXaf: null });
      // La Direction détient le droit de valorisation : la valeur des pertes (zéro ici) est servie.
      const full = await get(
        dir,
        `/api/v1/weekly-reports/figures?user_id=${cte1.userId}&week_start=${WEEK}`,
      );
      expect(full.json().figures).toEqual({ ...expected, lossValueXaf: 0 });
      // Semaine suivante : rien.
      const empty = await get(cte1, '/api/v1/weekly-reports/figures?week_start=2026-09-21');
      expect(empty.json().figures).toMatchObject({ visits: 0, newProspects: 0, newCustomers: 0 });
      // Portée et paramètres.
      expect(
        (
          await get(
            cte2,
            `/api/v1/weekly-reports/figures?user_id=${cte1.userId}&week_start=${WEEK}`,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (await get(cte1, '/api/v1/weekly-reports/figures?week_start=2026-09-15')).statusCode,
      ).toBe(400);
      expect((await get(mag, `/api/v1/weekly-reports/figures?week_start=${WEEK}`)).statusCode).toBe(
        403,
      );
    });

    it('crm.weekly_report.review : « vu » par le responsable de l’équipe, bilan ensuite figé', async () => {
      const review = (
        actor: Actor,
        payload: unknown,
        occurredAt = '2026-09-22T09:00:00.000Z',
        baseVersion: number | null = null,
      ) =>
        attempt(
          actor,
          'crm.weekly_report.review',
          'WEEKLY_REPORT',
          reportId,
          occurredAt,
          payload,
          baseVersion,
        );
      expect((await review(cte1, {})).status).toBe('REJECTED');
      expect(code(await review(rcoOther, { comment: 'Pas mon équipe' }))).toBe('FORBIDDEN_SCOPE');
      // Le « vu » vaut pour la version que le responsable a lue : le bilan en est à la version 2 (une correction a eu
      // lieu depuis une lecture de la version 1), le « vu » est refusé et le bilan reste modifiable.
      expect(code(await review(rco, { comment: 'Périmé' }, undefined, 1))).toBe('REPORT_CHANGED');
      expect(
        (await get(cte1, `/api/v1/weekly-reports?user_id=me&week_start=${WEEK}`)).json().reports[0]
          .status,
      ).toBe('SUBMITTED');
      const done = await review(rco, { comment: 'Bon rythme' }, undefined, 2);
      expect(done.status, JSON.stringify(done)).toBe('APPLIED');
      const reports = (
        await get(cte1, `/api/v1/weekly-reports?user_id=me&week_start=${WEEK}`)
      ).json().reports;
      expect(reports).toMatchObject([
        { status: 'REVIEWED', managerComment: 'Bon rythme', reviewedBy: rco.userId },
      ]);

      // Figé : plus de correction par le commercial, ni en SQL direct.
      expect(
        code(
          await attempt(
            cte1,
            'crm.weekly_report.submit',
            'WEEKLY_REPORT',
            reportId,
            '2026-09-23T10:00:00.000Z',
            { weekStart: WEEK, successes: 'Trop tard' },
          ),
        ),
      ).toBe('REPORT_LOCKED');
      await expect(
        db
          .updateTable('crm_weekly_reports')
          .set({ successes: 'Réécrit' })
          .where('id', '=', toBin(reportId))
          .execute(),
      ).rejects.toThrow();
      // Un bilan vu ne redevient pas modifiable, même en SQL direct (deux UPDATE ne contournent pas le figement).
      await expect(
        db
          .updateTable('crm_weekly_reports')
          .set({ status: 'SUBMITTED', reviewed_at: null, reviewed_by: null, manager_comment: null })
          .where('id', '=', toBin(reportId))
          .execute(),
      ).rejects.toThrow();
      const state = async () =>
        (await get(rco, `/api/v1/weekly-reports?week_start=${WEEK}`)).json().reports[0] as {
          managerComment: string | null;
          reviewedBy: string;
          reviewedAt: string;
        };
      // Le responsable peut revoir son commentaire (un « vu » plus récent, pour la version lue).
      expect(
        (await review(rco, { comment: 'Voir jeudi' }, '2026-09-22T10:00:00.000Z', 3)).status,
      ).toBe('APPLIED');
      expect((await state()).managerComment).toBe('Voir jeudi');
      // Un « vu » plus ancien arrivé après (écrit hors ligne) ne fait reculer ni la date ni le commentaire.
      expect((await review(dir, { comment: 'Ancien' }, '2026-09-22T08:00:00.000Z')).status).toBe(
        'APPLIED',
      );
      const afterOlder = await state();
      expect(afterOlder).toMatchObject({ managerComment: 'Voir jeudi', reviewedBy: rco.userId });
      // Un second « vu » plus récent, sans commentaire, garde celui qui existe ; la Direction devient le dernier vu.
      expect((await review(dir, {}, '2026-09-22T11:00:00.000Z')).status).toBe('APPLIED');
      expect(await state()).toMatchObject({ managerComment: 'Voir jeudi', reviewedBy: dir.userId });
      // Un commentaire explicitement vide (`null`) l'efface.
      expect((await review(dir, { comment: null }, '2026-09-22T12:00:00.000Z')).status).toBe(
        'APPLIED',
      );
      expect((await state()).managerComment).toBeNull();
    });
  });
});

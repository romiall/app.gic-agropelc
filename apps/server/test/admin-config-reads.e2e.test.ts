/**
 * Lectures d'administration de RP-1 (ECR-ADM-06, ECR-ADM-07, ECR-AUD-01 ; S-19, S-28 ; AV-493, AV-495) :
 * `GET /zones`, `GET /teams`, `GET /organization/settings/current` et l'historique nommé, `GET /approvals/policies`,
 * `GET /audit` (dates, acteur nommé, Finance limitée aux entités financières) et `GET /audit/entity-types`.
 * Même gabarit que `audit-log.e2e.test.ts` : NestJS + Fastify, `app.inject()`, vrais rôles semés.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { businessDayOf, type Clock, type IdGenerator } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { recordAudit } from '../src/audit/record-audit.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { type JwtKeyPair } from '../src/modules/identity/application/public/jwt.js';
import {
  auditEntityRestriction,
  DEFAULT_FINANCE_AUDIT_ENTITY_TYPES,
  parseEntityTypes,
} from '../src/audit-api/audit-scope.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
  withTestUow,
} from './helpers.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';

async function roleId(code: string): Promise<string> {
  const row = await db
    .selectFrom('identity_roles')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

/** Les permissions de ces essais sont celles du catalogue semé : on ne les réécrit pas (`insertTestPermission` le ferait). */
async function ensurePermission(trx: UnitOfWork, code: string): Promise<void> {
  const known = await trx
    .selectFrom('identity_permissions')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst();
  if (known) return;
  await trx
    .insertInto('identity_permissions')
    .values({
      code,
      module: 'test',
      description: 'Permission de test',
      supported_scopes: '["ALL"]',
    })
    .execute();
}

describe('lectures d’administration (RP-1)', () => {
  let app: NestFastifyApplication;
  let jwtKeys: JwtKeyPair;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let device: string;

  let admin: string;
  let director: string;
  let finance: string;
  let auditOnly: string;
  let nobody: string;
  const tokens = new Map<string, string>();

  const get = (url: string, user: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokens.get(user)!}` } });

  async function newUser(name: string): Promise<string> {
    const id = await db.transaction().execute((trx) => insertTestUser(trx));
    await db
      .updateTable('identity_users')
      .set({ full_name: name })
      .where('id', '=', toBin(id))
      .execute();
    tokens.set(
      id,
      await signTestAccessToken(
        jwtKeys.privateKey,
        { sub: id, device_id: device, session_id: freshUuid() },
        clock.now(),
      ),
    );
    return id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwtKeys = app.get(JWT_KEYS);
    clock = app.get(CLOCK);
    idGenerator = app.get(ID_GENERATOR);

    const bootstrap = await db.transaction().execute((trx) => insertTestUser(trx));
    device = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, bootstrap, { status: 'ACTIVE' }));

    admin = await newUser('Awa Admin');
    director = await newUser('Denis Direction');
    finance = await newUser('Fanta Finance');
    auditOnly = await newUser('Aude Auditeur');
    nobody = await newUser('Nadine Sansdroit');

    const adminRole = await roleId('ADMIN');
    const directionRole = await roleId('DIRECTION');
    const financeRole = await roleId('FINANCE');
    await db.transaction().execute(async (trx) => {
      await assignTestRole(trx, admin, adminRole, admin);
      await assignTestRole(trx, director, directionRole, admin);
      await assignTestRole(trx, finance, financeRole, admin);
      // Un rôle sur mesure qui détient `audit.log.read` sans être Direction ni Admin : lecture limitée.
      await ensurePermission(trx, 'audit.log.read');
      const custom = await insertTestRole(trx, admin);
      await grantTestPermission(trx, custom, 'audit.log.read', admin);
      await assignTestRole(trx, auditOnly, custom, admin);
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  describe('GET /zones (S-19)', () => {
    let zoneA: string;
    let zoneB: string;
    let zoneC: string;
    let zoneReader: string;

    beforeAll(async () => {
      await db.transaction().execute(async (trx) => {
        zoneA = await insertTestZone(trx, admin);
        zoneB = await insertTestZone(trx, admin, { parentId: zoneA });
        zoneC = await insertTestZone(trx, admin);
      });
      await db
        .updateTable('organization_zones')
        .set({ geofence_lat: '4.051056', geofence_lng: '9.767869', geofence_radius_m: '350.0' })
        .where('id', '=', toBin(zoneA))
        .execute();
      zoneReader = await newUser('Zoé Zone');
      await db.transaction().execute(async (trx) => {
        await ensurePermission(trx, 'org.structure.read');
        const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['ZONE'] });
        await grantTestPermission(trx, role, 'org.structure.read', admin, { maxScope: 'ZONE' });
        await assignTestRole(trx, zoneReader, role, admin, {
          scopeType: 'ZONE',
          scopeZoneId: zoneA,
        });
      });
    });

    it('portée ALL : toutes les zones, avec leur parent, leur profondeur et leur géorepère', async () => {
      const response = await get('/api/v1/zones', admin);
      expect(response.statusCode).toBe(200);
      const { zones } = response.json() as {
        zones: {
          id: string;
          parentId: string | null;
          depth: number;
          geofence: { lat: number; lng: number; radiusM: number } | null;
          isActive: boolean;
        }[];
      };
      const byId = new Map(zones.map((zone) => [zone.id, zone]));
      expect([...byId.keys()]).toEqual(expect.arrayContaining([zoneA, zoneB, zoneC]));
      expect(byId.get(zoneB)).toMatchObject({ parentId: zoneA, depth: 2, geofence: null });
      expect(byId.get(zoneA)?.geofence).toEqual({ lat: 4.051056, lng: 9.767869, radiusM: 350 });
      // Ordre de la racine aux feuilles : un parent précède son enfant.
      const order = zones.map((zone) => zone.id);
      expect(order.indexOf(zoneA)).toBeLessThan(order.indexOf(zoneB));
    });

    it('portée ZONE : la zone de l’affectation et ses descendantes seulement', async () => {
      const response = await get('/api/v1/zones', zoneReader);
      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { zones: { id: string }[] }).zones.map((zone) => zone.id);
      expect(ids.sort()).toEqual([zoneA, zoneB].sort());
    });

    it('sans le droit de lecture de la structure : 403', async () => {
      const response = await get('/api/v1/zones', nobody);
      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /teams (S-28, AV-495)', () => {
    let teamOne: string;
    let teamTwo: string;
    let member: string;
    let manager: string;
    let outsider: string;

    beforeAll(async () => {
      member = await newUser('Marie Membre');
      manager = await newUser('Marc Manager');
      outsider = await newUser('Olive Autre');
      await db.transaction().execute(async (trx) => {
        teamOne = await insertTestTeam(trx, manager, admin);
        teamTwo = await insertTestTeam(trx, outsider, admin);
        await insertTestTeamMembership(trx, teamOne, member, admin);
        await insertTestTeamMembership(trx, teamOne, nobody, admin, {
          validFrom: new Date('2020-01-01T00:00:00.000Z'),
          validTo: new Date('2020-02-01T00:00:00.000Z'),
        });
        await ensurePermission(trx, 'org.structure.read');
        const role = await insertTestRole(trx, admin);
        await grantTestPermission(trx, role, 'org.structure.read', admin, { maxScope: 'SITE' });
        await assignTestRole(trx, member, role, admin);
        await assignTestRole(trx, outsider, role, admin);
      });
    });

    it('portée ALL : toutes les équipes, responsable et membres nommés, appartenances échues exclues', async () => {
      const response = await get('/api/v1/teams', admin);
      expect(response.statusCode).toBe(200);
      const { teams } = response.json() as {
        teams: {
          id: string;
          managerName: string | null;
          members: { userId: string; fullName: string | null }[];
        }[];
      };
      const one = teams.find((team) => team.id === teamOne);
      expect(one?.managerName).toBe('Marc Manager');
      expect(one?.members.map((entry) => [entry.userId, entry.fullName])).toEqual([
        [member, 'Marie Membre'],
      ]);
      expect(teams.map((team) => team.id)).toEqual(expect.arrayContaining([teamOne, teamTwo]));
    });

    it('sans portée ALL : seulement les équipes que l’on dirige ou dont on est membre', async () => {
      const asMember = await get('/api/v1/teams', member);
      expect(asMember.statusCode).toBe(200);
      expect((asMember.json() as { teams: { id: string }[] }).teams.map((team) => team.id)).toEqual(
        [teamOne],
      );

      const asManager = await get('/api/v1/teams', outsider);
      expect(
        (asManager.json() as { teams: { id: string }[] }).teams.map((team) => team.id),
      ).toEqual([teamTwo]);
    });

    it('sans le droit de lecture de la structure : 403', async () => {
      expect((await get('/api/v1/teams', nobody)).statusCode).toBe(403);
    });
  });

  describe('paramètres : valeur en vigueur et historique nommé (ECR-ADM-07)', () => {
    const key = `rp1.test.${freshUuid().slice(-12)}`;
    let site: string;

    beforeAll(async () => {
      const zone = await db.transaction().execute((trx) => insertTestZone(trx, admin));
      site = await db.transaction().execute((trx) => insertTestSite(trx, admin, zone));
      const version = (
        value: number,
        validFrom: string,
        extra: { scopeSite?: string; visible?: boolean; reason?: string } = {},
      ) =>
        db
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key,
            value: jsonValue(value),
            scope_type: extra.scopeSite ? 'SITE' : 'GLOBAL',
            scope_id: extra.scopeSite ? toBin(extra.scopeSite) : null,
            valid_from: new Date(validFrom),
            is_client_visible: extra.visible ? 1 : 0,
            created_by: toBin(admin),
            reason: extra.reason ?? null,
          })
          .execute();
      await version(1, '2020-01-01T00:00:00.000Z');
      await version(2, '2021-01-01T00:00:00.000Z', { visible: true, reason: 'Essai' });
      await version(9, '2021-06-01T00:00:00.000Z', { scopeSite: site });
      await version(3, '2099-01-01T00:00:00.000Z');
    });

    it('une version par clé et par portée : la dernière entrée en vigueur, jamais une version future', async () => {
      const response = await get('/api/v1/organization/settings/current', admin);
      expect(response.statusCode).toBe(200);
      const { settings } = response.json() as {
        settings: {
          key: string;
          value: unknown;
          scopeType: string;
          scopeId: string | null;
          isClientVisible: boolean;
          createdByName: string | null;
        }[];
      };
      const mine = settings.filter((setting) => setting.key === key);
      expect(mine.map((setting) => [setting.scopeType, setting.value])).toEqual([
        ['GLOBAL', 2],
        ['SITE', 9],
      ]);
      expect(mine[0]).toMatchObject({ isClientVisible: true, createdByName: 'Awa Admin' });
      expect(mine[1]).toMatchObject({ scopeId: site });
      // Le semis est là : une clé connue du catalogue a sa valeur en vigueur.
      expect(settings.some((setting) => setting.key === 'fieldwork.geofence_radius_m')).toBe(true);
    });

    it('historique : toutes les versions, la plus récente d’abord, avec l’auteur nommé et le motif', async () => {
      const response = await get(
        `/api/v1/organization/settings?key=${encodeURIComponent(key)}&scope_type=GLOBAL`,
        admin,
      );
      expect(response.statusCode).toBe(200);
      const { history } = response.json() as {
        history: { value: unknown; reason: string | null; createdByName: string | null }[];
      };
      expect(history.map((entry) => entry.value)).toEqual([3, 2, 1]);
      expect(history[1]).toMatchObject({ reason: 'Essai', createdByName: 'Awa Admin' });
    });

    it('sans `org.settings.manage` : 403 audité (`access.denied`) sur la liste comme sur l’historique', async () => {
      expect((await get('/api/v1/organization/settings/current', nobody)).statusCode).toBe(403);
      expect(
        (await get(`/api/v1/organization/settings?key=${encodeURIComponent(key)}`, finance))
          .statusCode,
      ).toBe(403);
      for (const actor of [nobody, finance]) {
        const denied = await db
          .selectFrom('audit_audit_log')
          .select('entity_type')
          .where('actor_user_id', '=', toBin(actor))
          .where('action', '=', 'access.denied')
          .where('entity_type', '=', 'SETTING')
          .execute();
        expect(denied.length, `refus de ${actor} non audité`).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('GET /approvals/policies (ECR-ADM-07, AV-494)', () => {
    const code = `RP1_TEST_${freshUuid().slice(-10).toUpperCase()}`;

    beforeAll(async () => {
      await db
        .insertInto('approvals_control_policies')
        .values({
          id: toBin(freshUuid()),
          code,
          version: 1,
          operation_type: 'EXPENSE',
          condition: jsonValue({ category: 'ESSAI' }),
          requires_photo: 1,
          valid_from: new Date('2020-01-01T00:00:00.000Z'),
          valid_to: new Date('2020-06-01T00:00:00.000Z'),
          status: 'RETIRED',
          created_by: toBin(admin),
        })
        .execute();
    });

    it('politiques en vigueur seulement, et les permissions d’approbation proposées', async () => {
      const response = await get('/api/v1/approvals/policies', admin);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        policies: { code: string; status: string }[];
        approver_permissions: { code: string; description: string }[];
      };
      expect(body.policies.every((policy) => policy.status === 'ACTIVE')).toBe(true);
      expect(body.policies.some((policy) => policy.code === code)).toBe(false);
      const codes = body.approver_permissions.map((permission) => permission.code);
      expect(codes).toContain('finance.expense.approve');
      // L'ordre est celui de l'interclassement de la base (la ponctuation passe avant les lettres) : seule
      // l'unicité est vérifiée.
      expect(new Set(codes).size).toBe(codes.length);
    });

    it('avec un code : toutes les versions de ce code (historique), auteur nommé, condition rendue telle quelle', async () => {
      const response = await get(`/api/v1/approvals/policies?code=${code}`, director);
      expect(response.statusCode).toBe(200);
      const { policies } = response.json() as {
        policies: {
          code: string;
          version: number;
          status: string;
          requiresPhoto: boolean;
          condition: unknown;
          createdByName: string | null;
        }[];
      };
      expect(policies).toHaveLength(1);
      expect(policies[0]).toMatchObject({
        code,
        version: 1,
        status: 'RETIRED',
        requiresPhoto: true,
        condition: { category: 'ESSAI' },
        createdByName: 'Awa Admin',
      });
    });

    it('sans `approvals.policy.manage` : 403 audité', async () => {
      const response = await get('/api/v1/approvals/policies', finance);
      expect(response.statusCode).toBe(403);
      const denied = await db
        .selectFrom('audit_audit_log')
        .select('entity_type')
        .where('actor_user_id', '=', toBin(finance))
        .where('action', '=', 'access.denied')
        .where('entity_type', '=', 'CONTROL_POLICY')
        .executeTakeFirstOrThrow();
      expect(denied.entity_type).toBe('CONTROL_POLICY');
    });
  });

  describe('GET /audit : dates, acteur nommé, Finance limitée (ECR-AUD-01, AV-493)', () => {
    let userEntryId: string;
    let saleEntryId: string;

    beforeAll(async () => {
      const deps = { idGenerator, clock };
      const write = (entityType: string, action: string) =>
        db.transaction().execute((trx) =>
          recordAudit(trx, deps, {
            occurredAt: clock.now(),
            actorUserId: admin,
            actorRoles: ['ADMIN'],
            deviceId: device,
            action,
            entityType,
            entityId: freshUuid(),
            before: { status: 'A' },
            after: { status: 'B' },
            result: 'SUCCESS',
          }),
        );
      userEntryId = (await write('USER', 'identity.user.suspend')).id;
      saleEntryId = (await write('SALE', 'sales.sale.record')).id;
    });

    const mine = (extra = '') => `/api/v1/audit?actor_user_id=${admin}${extra}`;
    const idsOf = (response: { json: () => unknown }) =>
      (response.json() as { entries: { id: string }[] }).entries.map((entry) => entry.id);

    it('Admin et Direction lisent tout ; chaque entrée porte le nom de l’acteur', async () => {
      for (const reader of [admin, director]) {
        const response = await get(mine(), reader);
        expect(response.statusCode).toBe(200);
        const { entries } = response.json() as {
          entries: { id: string; actorName: string | null; entityType: string }[];
        };
        expect(entries.map((entry) => entry.id)).toEqual(
          expect.arrayContaining([userEntryId, saleEntryId]),
        );
        expect(entries.find((entry) => entry.id === userEntryId)?.actorName).toBe('Awa Admin');
      }
    });

    it('la Finance ne lit que les entités financières : le filtre, la liste et le journal entier', async () => {
      const unfiltered = await get(mine(), finance);
      expect(unfiltered.statusCode).toBe(200);
      expect(idsOf(unfiltered)).toContain(saleEntryId);
      expect(idsOf(unfiltered)).not.toContain(userEntryId);

      // Un type d'entité hors liste ne rend rien, sans révéler s'il existe.
      expect(idsOf(await get(mine('&entity_type=USER'), finance))).toEqual([]);
      expect(idsOf(await get(mine('&entity_type=SALE'), finance))).toContain(saleEntryId);

      // Ni l'identifiant seul ne contourne la restriction.
      const userEntry = await db
        .selectFrom('audit_audit_log')
        .select('entity_id')
        .where('id', '=', toBin(userEntryId))
        .executeTakeFirstOrThrow();
      const entityId = fromBin(userEntry.entity_id!);
      expect(idsOf(await get(`/api/v1/audit?entity_id=${entityId}`, finance))).toEqual([]);
      expect(idsOf(await get(`/api/v1/audit?entity_id=${entityId}`, admin))).toEqual([userEntryId]);
    });

    it('un rôle qui n’est ni Direction ni Admin est limité comme la Finance (fermé par défaut)', async () => {
      expect(idsOf(await get(mine('&entity_type=USER'), auditOnly))).toEqual([]);
      expect(idsOf(await get(mine('&entity_type=SALE'), auditOnly))).toContain(saleEntryId);
    });

    it('types d’entité proposés : tous pour l’Admin, seulement les financiers pour la Finance', async () => {
      const all = await get('/api/v1/audit/entity-types', admin);
      expect(all.statusCode).toBe(200);
      const adminTypes = (all.json() as { entity_types: string[] }).entity_types;
      expect(adminTypes).toEqual(expect.arrayContaining(['USER', 'SALE']));
      expect(new Set(adminTypes).size).toBe(adminTypes.length);

      const financial = await get('/api/v1/audit/entity-types', finance);
      const financeTypes = (financial.json() as { entity_types: string[] }).entity_types;
      expect(financeTypes).toContain('SALE');
      expect(financeTypes).not.toContain('USER');
      expect(financeTypes.every((type) => DEFAULT_FINANCE_AUDIT_ENTITY_TYPES.includes(type))).toBe(
        true,
      );
      expect((await get('/api/v1/audit/entity-types', nobody)).statusCode).toBe(403);
    });

    it('période : jours métier sur l’enregistrement serveur, bornes incluses', async () => {
      const today = businessDayOf(clock.now());
      expect(idsOf(await get(mine(`&from=${today}&to=${today}`), admin))).toEqual(
        expect.arrayContaining([userEntryId, saleEntryId]),
      );
      expect(idsOf(await get(mine('&from=2099-01-01'), admin))).toEqual([]);
      expect(idsOf(await get(mine('&to=2000-01-01'), admin))).toEqual([]);
    });

    it('période invalide (fin avant début, date impossible) : 400', async () => {
      for (const query of ['from=2026-02-01&to=2026-01-01', 'from=2026-13-45', 'to=hier']) {
        const response = await get(`/api/v1/audit?${query}`, admin);
        expect(response.statusCode, query).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('la consultation est elle-même auditée avec ses filtres, restriction comprise (BR-AUD-009)', async () => {
      await get(mine('&entity_type=SALE'), finance);
      const row = await db
        .selectFrom('audit_audit_log')
        .select(['after', 'entity_type'])
        .where('actor_user_id', '=', toBin(finance))
        .where('action', '=', 'audit.log.read')
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      expect(row.entity_type).toBe('AUDIT_LOG');
      expect(row.after).toMatchObject({ entityType: 'SALE' });
      expect((row.after as { entityTypes: string[] }).entityTypes).toEqual([
        ...DEFAULT_FINANCE_AUDIT_ENTITY_TYPES,
      ]);
    });
  });

  describe('restriction de la Finance par le paramètre `audit.finance_entity_types` (AV-493)', () => {
    it('lit la liste en vigueur ; une liste vide ferme la lecture ; une valeur invalide retombe sur le défaut', async () => {
      const result = await withTestUow(async (trx) => {
        const setVersion = async (value: unknown, validFrom: string) =>
          trx
            .insertInto('organization_system_settings')
            .values({
              id: toBin(freshUuid()),
              key: 'audit.finance_entity_types',
              value: jsonValue(value),
              scope_type: 'GLOBAL',
              scope_id: null,
              valid_from: new Date(validFrom),
              created_by: toBin(admin),
            })
            .execute();
        const at = new Date('2098-01-01T00:00:00.000Z');
        await setVersion(['CASH_SESSION', ' SALE '], '2097-01-01T00:00:00.000Z');
        const configured = await auditEntityRestriction(trx, finance, at);
        await setVersion([], '2097-06-01T00:00:00.000Z');
        const closed = await auditEntityRestriction(trx, finance, at);
        await setVersion('pas une liste', '2097-09-01T00:00:00.000Z');
        const invalid = await auditEntityRestriction(trx, finance, at);
        const unrestricted = await auditEntityRestriction(trx, admin, at);
        return { configured, closed, invalid, unrestricted };
      });
      expect(result.configured).toEqual(['CASH_SESSION', 'SALE']);
      expect(result.closed).toEqual([]);
      expect(result.invalid).toEqual([...DEFAULT_FINANCE_AUDIT_ENTITY_TYPES]);
      expect(result.unrestricted).toBeNull();
    });

    it('lecture de la liste : textes non vides seulement, sans doublon', () => {
      expect(parseEntityTypes(['A', 'B', 'A'])).toEqual(['A', 'B']);
      expect(parseEntityTypes([])).toEqual([]);
      expect(parseEntityTypes(['A', ''])).toBeNull();
      expect(parseEntityTypes(['A', 1])).toBeNull();
      expect(parseEntityTypes({ a: 1 })).toBeNull();
      expect(parseEntityTypes(null)).toBeNull();
    });
  });
});

/**
 * `organization.{zone,site,pos,location,team,setting}.*` (P0-11) à travers le **vrai**
 * pipeline de commande (même gabarit que `identity-lifecycle.test.ts`, P0-09/10) —
 * écritures réelles, non annulées (command_id/aggregate_id frais à chaque test).
 * Démontre le critère de sortie de phase : `organization.setting.set` + historique lisible
 * (`listSettingHistory`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerZoneCommands } from '../src/modules/organization/application/commands/zone-commands.js';
import { registerSiteCommands } from '../src/modules/organization/application/commands/site-commands.js';
import { registerPosCommands } from '../src/modules/organization/application/commands/pos-commands.js';
import { registerLocationCommands } from '../src/modules/organization/application/commands/location-commands.js';
import { registerTeamCommands } from '../src/modules/organization/application/commands/team-commands.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import {
  listSettingHistory,
  currentSettingValue,
} from '../src/modules/organization/application/public/index.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-09-24T09:00:00.000Z';
const LATER_OCCURRED_AT = '2026-09-24T10:00:00.000Z';

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registerZoneCommands(registry);
  registerSiteCommands(registry);
  registerPosCommands(registry);
  registerLocationCommands(registry);
  registerTeamCommands(registry);
  registerSettingCommands(registry);
  return registry;
}

interface EnvelopeOverrides {
  readonly command_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly occurred_at: string;
  readonly payload: unknown;
}

function buildEnvelope(
  authorUserId: string,
  overrides: EnvelopeOverrides,
): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    client_created_at: overrides.occurred_at,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

async function createRealUser(): Promise<string> {
  return db.transaction().execute((trx) => insertTestUser(trx));
}

describe('organization.* (P0-11)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-09-24T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);

    admin = await createRealUser();
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'org.structure.manage', admin);
      await grantTestPermission(trx, role, 'org.settings.manage', admin);
      await assignTestRole(trx, admin, role, admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const ctx = () => ({
    authenticatedUserId: admin,
    authenticatedDeviceId: adminDevice,
    transport: 'ONLINE_API' as const,
  });

  describe('zone', () => {
    it('create : zone racine, puis enfant — zone_ancestors couvre soi-même et le parent', async () => {
      const rootId = freshUuid();
      const rootResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.create',
          aggregate_type: 'ZONE',
          aggregate_id: rootId,
          occurred_at: OCCURRED_AT,
          payload: { code: `Z-${rootId.slice(-8)}`, name: 'Racine', level: 'REGION' },
        }),
        ctx(),
      );
      expect(rootResult.status).toBe('APPLIED');

      const childId = freshUuid();
      const childResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.create',
          aggregate_type: 'ZONE',
          aggregate_id: childId,
          occurred_at: OCCURRED_AT,
          payload: {
            code: `Z-${childId.slice(-8)}`,
            name: 'Enfant',
            level: 'VILLE',
            parentId: rootId,
            lat: 4.05,
            lng: 9.7,
          },
        }),
        ctx(),
      );
      expect(childResult.status).toBe('APPLIED');

      const ancestors = await db
        .selectFrom('organization_zone_ancestors')
        .select(['ancestor_id', 'depth'])
        .where('zone_id', '=', toBin(childId))
        .execute();
      expect(ancestors).toHaveLength(2); // elle-même (depth 0) + la racine (depth 1)
      const zoneRow = await db
        .selectFrom('organization_zones')
        .select(['depth', 'geofence_radius_m'])
        .where('id', '=', toBin(childId))
        .executeTakeFirstOrThrow();
      expect(zoneRow.depth).toBe(2);
      expect(Number(zoneRow.geofence_radius_m)).toBe(500); // défaut appliqué (buildGeofence)
    });

    it('create : géorepère invalide (latitude sans longitude) → REJECTED GEOFENCE_INVALID', async () => {
      const zoneId = freshUuid();
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.create',
          aggregate_type: 'ZONE',
          aggregate_id: zoneId,
          occurred_at: OCCURRED_AT,
          payload: { code: `Z-${zoneId.slice(-8)}`, name: 'Invalide', level: 'SECTEUR', lat: 4.05 },
        }),
        ctx(),
      );
      expect(result.status).toBe('REJECTED');
      expect(result).toMatchObject({ error: { code: 'GEOFENCE_INVALID' } });
    });

    it('update : nom et actif', async () => {
      const zoneId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.create',
          aggregate_type: 'ZONE',
          aggregate_id: zoneId,
          occurred_at: OCCURRED_AT,
          payload: { code: `Z-${zoneId.slice(-8)}`, name: 'Avant', level: 'SECTEUR' },
        }),
        ctx(),
      );
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.update',
          aggregate_type: 'ZONE',
          aggregate_id: zoneId,
          occurred_at: LATER_OCCURRED_AT,
          payload: { name: 'Après', isActive: false },
        }),
        ctx(),
      );
      expect(result.status).toBe('APPLIED');
      const row = await db
        .selectFrom('organization_zones')
        .select(['name', 'is_active'])
        .where('id', '=', toBin(zoneId))
        .executeTakeFirstOrThrow();
      expect(row.name).toBe('Après');
      expect(row.is_active).toBe(0);
    });
  });

  describe('site', () => {
    async function createRealZone(): Promise<string> {
      return db.transaction().execute((trx) => insertTestZone(trx, admin));
    }

    it('create, update, close', async () => {
      const zoneId = await createRealZone();
      const siteId = freshUuid();
      const createResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.site.create',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: OCCURRED_AT,
          payload: {
            code: siteId.slice(-8).toUpperCase(),
            name: 'PDV Test',
            siteType: 'POINT_DE_VENTE',
            zoneId,
          },
        }),
        ctx(),
      );
      expect(createResult.status).toBe('APPLIED');

      const updateResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.site.update',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: LATER_OCCURRED_AT,
          payload: { name: 'PDV Test (renommé)', lat: 4.05, lng: 9.7 },
        }),
        ctx(),
      );
      expect(updateResult.status).toBe('APPLIED');

      const closeResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.site.close',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: LATER_OCCURRED_AT,
          payload: {},
        }),
        ctx(),
      );
      expect(closeResult.status).toBe('APPLIED');

      const row = await db
        .selectFrom('organization_sites')
        .select(['name', 'status', 'closed_on'])
        .where('id', '=', toBin(siteId))
        .executeTakeFirstOrThrow();
      expect(row.name).toBe('PDV Test (renommé)');
      expect(row.status).toBe('CLOSED');
      expect(row.closed_on).not.toBeNull();

      // Rejeu (déjà CLOSED) : APPLIED sans effet.
      const replay = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.site.close',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: LATER_OCCURRED_AT,
          payload: {},
        }),
        ctx(),
      );
      expect(replay.status).toBe('APPLIED');
    });
  });

  describe('point de vente et emplacements', () => {
    it('pos.configure exige un site POINT_DE_VENTE et un emplacement de vente existant', async () => {
      const zoneId = await db.transaction().execute((trx) => insertTestZone(trx, admin));
      const siteId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.site.create',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: OCCURRED_AT,
          payload: {
            code: siteId.slice(-8).toUpperCase(),
            name: 'PDV Config',
            siteType: 'POINT_DE_VENTE',
            zoneId,
          },
        }),
        ctx(),
      );

      const salesLocationId = freshUuid();
      const locationResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.location.create',
          aggregate_type: 'LOCATION',
          aggregate_id: salesLocationId,
          occurred_at: OCCURRED_AT,
          payload: { siteId, code: 'CAISSE', name: 'Caisse', locationType: 'POS' },
        }),
        ctx(),
      );
      expect(locationResult.status).toBe('APPLIED');

      // designatedDeviceId inexistant → REJECTED NOT_FOUND, pas une erreur SQL brute.
      const withMissingDevice = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.pos.configure',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: OCCURRED_AT,
          payload: {
            salesLocationId,
            custodyMode: 'EXCLUSIVE_DEVICE',
            designatedDeviceId: freshUuid(),
          },
        }),
        ctx(),
      );
      expect(withMissingDevice.status).toBe('REJECTED');
      expect(withMissingDevice).toMatchObject({ error: { code: 'NOT_FOUND' } });

      const realDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
      const configureResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.pos.configure',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: OCCURRED_AT,
          payload: {
            salesLocationId,
            custodyMode: 'EXCLUSIVE_DEVICE',
            designatedDeviceId: realDevice,
          },
        }),
        ctx(),
      );
      expect(configureResult.status).toBe('APPLIED');

      // Reconfiguration (upsert) : passage en SHARED, plus de designatedDeviceId.
      const reconfigureResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.pos.configure',
          aggregate_type: 'SITE',
          aggregate_id: siteId,
          occurred_at: LATER_OCCURRED_AT,
          payload: { salesLocationId, custodyMode: 'SHARED' },
        }),
        ctx(),
      );
      expect(reconfigureResult.status).toBe('APPLIED');
      const posRow = await db
        .selectFrom('organization_points_of_sale')
        .select(['custody_mode', 'designated_device_id'])
        .where('site_id', '=', toBin(siteId))
        .executeTakeFirstOrThrow();
      expect(posRow.custody_mode).toBe('SHARED');
      expect(posRow.designated_device_id).toBeNull();
    });

    it('location.create : PEN exige un parent BUILDING, MOBILE exige un détenteur EXCLUSIVE_USER actif', async () => {
      const zoneId = await db.transaction().execute((trx) => insertTestZone(trx, admin));
      const siteId = await db.transaction().execute((trx) => insertTestSite(trx, admin, zoneId));

      const penWithoutParent = freshUuid();
      const penResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.location.create',
          aggregate_type: 'LOCATION',
          aggregate_id: penWithoutParent,
          occurred_at: OCCURRED_AT,
          payload: { siteId, code: 'CASE-1', name: 'Case 1', locationType: 'PEN' },
        }),
        ctx(),
      );
      expect(penResult.status).toBe('REJECTED');
      expect(penResult).toMatchObject({ error: { code: 'LOCATION_PARENT_INVALID' } });

      const buildingId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.location.create',
          aggregate_type: 'LOCATION',
          aggregate_id: buildingId,
          occurred_at: OCCURRED_AT,
          payload: { siteId, code: 'BAT-1', name: 'Bâtiment 1', locationType: 'BUILDING' },
        }),
        ctx(),
      );
      const penWithParent = freshUuid();
      const penOkResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.location.create',
          aggregate_type: 'LOCATION',
          aggregate_id: penWithParent,
          occurred_at: OCCURRED_AT,
          payload: {
            siteId,
            parentLocationId: buildingId,
            code: 'CASE-2',
            name: 'Case 2',
            locationType: 'PEN',
          },
        }),
        ctx(),
      );
      expect(penOkResult.status).toBe('APPLIED');

      const custodian = await createRealUser();
      const mobileId = freshUuid();
      const mobileResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.location.create',
          aggregate_type: 'LOCATION',
          aggregate_id: mobileId,
          occurred_at: OCCURRED_AT,
          payload: {
            siteId,
            code: 'MOB-1',
            name: 'Stock mobile',
            locationType: 'MOBILE',
            custodyMode: 'EXCLUSIVE_USER',
            custodianUserId: custodian,
          },
        }),
        ctx(),
      );
      expect(mobileResult.status).toBe('APPLIED');

      // Désactivation, puis rejeu idempotent.
      const deactivateResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.location.deactivate',
          aggregate_type: 'LOCATION',
          aggregate_id: buildingId,
          occurred_at: LATER_OCCURRED_AT,
          payload: {},
        }),
        ctx(),
      );
      expect(deactivateResult.status).toBe('APPLIED');
      const deactivateReplay = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.location.deactivate',
          aggregate_type: 'LOCATION',
          aggregate_id: buildingId,
          occurred_at: LATER_OCCURRED_AT,
          payload: {},
        }),
        ctx(),
      );
      expect(deactivateReplay.status).toBe('APPLIED');
    });
  });

  describe('équipe', () => {
    it('create, assign_member (ferme l’ancienne appartenance), remove_member', async () => {
      const manager = await createRealUser();
      const teamAId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.team.create',
          aggregate_type: 'TEAM',
          aggregate_id: teamAId,
          occurred_at: OCCURRED_AT,
          payload: { code: `T-${teamAId.slice(-8)}`, name: 'Équipe A', managerUserId: manager },
        }),
        ctx(),
      );
      const teamBId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.team.create',
          aggregate_type: 'TEAM',
          aggregate_id: teamBId,
          occurred_at: OCCURRED_AT,
          payload: { code: `T-${teamBId.slice(-8)}`, name: 'Équipe B', managerUserId: manager },
        }),
        ctx(),
      );

      const member = await createRealUser();
      const membership1 = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.team.assign_member',
          aggregate_type: 'TEAM_MEMBERSHIP',
          aggregate_id: membership1,
          occurred_at: OCCURRED_AT,
          payload: { userId: member, teamId: teamAId },
        }),
        ctx(),
      );

      const membership2 = freshUuid();
      const moveResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.team.assign_member',
          aggregate_type: 'TEAM_MEMBERSHIP',
          aggregate_id: membership2,
          occurred_at: LATER_OCCURRED_AT,
          payload: { userId: member, teamId: teamBId },
        }),
        ctx(),
      );
      expect(moveResult.status).toBe('APPLIED');

      const first = await db
        .selectFrom('organization_team_memberships')
        .select('valid_to')
        .where('id', '=', toBin(membership1))
        .executeTakeFirstOrThrow();
      expect(first.valid_to).not.toBeNull(); // fermée par le déplacement

      const removeResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.team.remove_member',
          aggregate_type: 'TEAM_MEMBERSHIP',
          aggregate_id: freshUuid(),
          occurred_at: '2026-09-24T11:00:00.000Z',
          payload: { userId: member },
        }),
        ctx(),
      );
      expect(removeResult.status).toBe('APPLIED');

      const second = await db
        .selectFrom('organization_team_memberships')
        .select('valid_to')
        .where('id', '=', toBin(membership2))
        .executeTakeFirstOrThrow();
      expect(second.valid_to).not.toBeNull();
    });
  });

  describe('paramètre système (critère de sortie P0-11)', () => {
    it('setting.set : versionne (jamais d’UPDATE), historique lisible, valeur en vigueur correcte à chaque instant', async () => {
      const key = `test.p0_11.${freshUuid()}`;

      const first = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.setting.set',
          aggregate_type: 'SETTING',
          aggregate_id: freshUuid(),
          occurred_at: OCCURRED_AT,
          payload: { key, value: 100, scopeType: 'GLOBAL', reason: 'Valeur initiale.' },
        }),
        ctx(),
      );
      expect(first.status).toBe('APPLIED');

      const second = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.setting.set',
          aggregate_type: 'SETTING',
          aggregate_id: freshUuid(),
          occurred_at: LATER_OCCURRED_AT,
          payload: { key, value: 200, scopeType: 'GLOBAL', reason: 'Révision.' },
        }),
        ctx(),
      );
      expect(second.status).toBe('APPLIED');

      const history = await listSettingHistory(db, { key });
      expect(history).toHaveLength(2);
      expect(history[0]!.value).toBe(200); // le plus récent en premier
      expect(history[1]!.value).toBe(100);

      const beforeAnyChange = await currentSettingValue(db, {
        key,
        scopeType: 'GLOBAL',
        scopeId: null,
        at: new Date('2026-09-24T08:00:00.000Z'),
      });
      expect(beforeAnyChange).toBeUndefined();

      const betweenChanges = await currentSettingValue(db, {
        key,
        scopeType: 'GLOBAL',
        scopeId: null,
        at: new Date('2026-09-24T09:30:00.000Z'),
      });
      expect(betweenChanges).toBe(100);

      const afterSecondChange = await currentSettingValue(db, {
        key,
        scopeType: 'GLOBAL',
        scopeId: null,
        at: new Date('2026-09-24T12:00:00.000Z'),
      });
      expect(afterSecondChange).toBe(200);
    });

    it('setting.set : scopeType SITE exige un scopeId, et une cible réelle', async () => {
      const key = `test.p0_11.site.${freshUuid()}`;
      const missingScope = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.setting.set',
          aggregate_type: 'SETTING',
          aggregate_id: freshUuid(),
          occurred_at: OCCURRED_AT,
          payload: { key, value: 1, scopeType: 'SITE' },
        }),
        ctx(),
      );
      expect(missingScope.status).toBe('REJECTED');
      expect(missingScope).toMatchObject({ error: { code: 'VALIDATION_ERROR:VALIDATION_ERROR' } });

      const zoneId = await db.transaction().execute((trx) => insertTestZone(trx, admin));
      const siteId = await db.transaction().execute((trx) => insertTestSite(trx, admin, zoneId));
      const withRealSite = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.setting.set',
          aggregate_type: 'SETTING',
          aggregate_id: freshUuid(),
          occurred_at: OCCURRED_AT,
          payload: { key, value: 42, scopeType: 'SITE', scopeId: siteId },
        }),
        ctx(),
      );
      expect(withRealSite.status).toBe('APPLIED');
    });
  });
});

/**
 * `organization.{zone,site,pos,location,team,setting}.*` (P0-11) à travers le **vrai**
 * pipeline de commande (même gabarit que `identity-lifecycle.test.ts`, P0-09/10) —
 * écritures réelles, non annulées (command_id/aggregate_id frais à chaque test).
 * Démontre le critère de sortie de phase : `organization.setting.set` + historique lisible
 * (`listSettingHistory`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
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
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
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

    it('AV-022 : rayon par défaut = paramètre fieldwork.geofence_radius_m en vigueur (règle 8)', async () => {
      // Versions datées de 2021 : sans effet sur les autres tests (heures métier ≥ 2026).
      await db.transaction().execute(async (trx) => {
        for (const [validFrom, value] of [
          ['2021-03-01T00:00:00.000Z', 800],
          ['2021-03-02T00:00:00.000Z', 500],
        ] as const) {
          await trx
            .insertInto('organization_system_settings')
            .values({
              id: toBin(freshUuid()),
              key: 'fieldwork.geofence_radius_m',
              value: JSON.stringify(value),
              scope_type: 'GLOBAL',
              valid_from: new Date(validFrom),
              is_client_visible: 1,
              reason: 'Test AV-022',
              created_by: toBin(admin),
            })
            .execute();
        }
      });
      const zoneId = freshUuid();
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.create',
          aggregate_type: 'ZONE',
          aggregate_id: zoneId,
          occurred_at: '2021-03-01T12:00:00.000Z',
          payload: {
            code: `Z-${zoneId.slice(-8)}`,
            name: 'Paramétrée',
            level: 'SECTEUR',
            lat: 4.05,
            lng: 9.7,
          },
        }),
        ctx(),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      const row = await db
        .selectFrom('organization_zones')
        .select('geofence_radius_m')
        .where('id', '=', toBin(zoneId))
        .executeTakeFirstOrThrow();
      expect(Number(row.geofence_radius_m)).toBe(800);
    });

    it('update : géorepère fixé, modifié (avant / après à l’audit), puis retiré', async () => {
      const zoneId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.create',
          aggregate_type: 'ZONE',
          aggregate_id: zoneId,
          occurred_at: OCCURRED_AT,
          payload: { code: `Z-${zoneId.slice(-8)}`, name: 'Marché', level: 'MARCHE' },
        }),
        ctx(),
      );
      const update = (geofence: unknown) =>
        pipeline.handle(
          buildEnvelope(admin, {
            command_type: 'organization.zone.update',
            aggregate_type: 'ZONE',
            aggregate_id: zoneId,
            occurred_at: LATER_OCCURRED_AT,
            payload: { geofence },
          }),
          ctx(),
        );
      const geofenceOf = async () =>
        db
          .selectFrom('organization_zones')
          .select(['geofence_lat', 'geofence_lng', 'geofence_radius_m'])
          .where('id', '=', toBin(zoneId))
          .executeTakeFirstOrThrow();

      expect((await update({ lat: 4.0511, lng: 9.7679 })).status).toBe('APPLIED');
      expect(Number((await geofenceOf()).geofence_radius_m)).toBe(500); // défaut paramétré
      const moved = await update({ lat: 4.06, lng: 9.77, radiusM: 300 });
      expect(moved.status).toBe('APPLIED');
      const audit = await db
        .selectFrom('audit_audit_log')
        .select(['before', 'after'])
        .where('command_id', '=', toBin(moved.command_id))
        .executeTakeFirstOrThrow();
      expect(audit.before).toEqual({ geofence: { lat: 4.0511, lng: 9.7679, radiusM: 500 } });
      expect(audit.after).toMatchObject({ geofence: { lat: 4.06, lng: 9.77, radiusM: 300 } });
      const invalid = await update({ lat: 4.06, lng: 9.77, radiusM: 20 });
      expect(invalid).toMatchObject({ status: 'REJECTED', error: { code: 'GEOFENCE_INVALID' } });
      expect((await update(null)).status).toBe('APPLIED');
      expect(await geofenceOf()).toEqual({
        geofence_lat: null,
        geofence_lng: null,
        geofence_radius_m: null,
      });
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

  describe('zone — déplacement (AV-515)', () => {
    const createZone = async (parentId?: string): Promise<string> => {
      const id = freshUuid();
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.create',
          aggregate_type: 'ZONE',
          aggregate_id: id,
          occurred_at: OCCURRED_AT,
          payload: {
            code: `Z-${id.slice(-8)}`,
            name: `Zone ${id.slice(-4)}`,
            level: 'VILLE',
            ...(parentId ? { parentId } : {}),
          },
        }),
        ctx(),
      );
      expect(result.status, JSON.stringify(result)).toBe('APPLIED');
      return id;
    };
    const moveZone = (id: string, parentId: string | null) =>
      pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.zone.move',
          aggregate_type: 'ZONE',
          aggregate_id: id,
          occurred_at: LATER_OCCURRED_AT,
          payload: { parentId },
        }),
        ctx(),
      );
    /** Fermeture d'une zone : ancêtre → distance. */
    const closureOf = async (id: string): Promise<Record<string, number>> =>
      Object.fromEntries(
        (
          await db
            .selectFrom('organization_zone_ancestors')
            .select(['ancestor_id', 'depth'])
            .where('zone_id', '=', toBin(id))
            .execute()
        ).map((row) => [fromBin(row.ancestor_id), row.depth]),
      );
    const rowOf = (id: string) =>
      db
        .selectFrom('organization_zones')
        .select(['parent_id', 'depth', 'version'])
        .where('id', '=', toBin(id))
        .executeTakeFirstOrThrow();

    it('une zone et sa sous-arborescence changent de parente : fermeture, profondeurs et publication aux appareils', async () => {
      // A > B > C et D > E : B (avec C) passe sous D, puis à la racine.
      const a = await createZone();
      const b = await createZone(a);
      const c = await createZone(b);
      const d = await createZone();
      const e = await createZone(d);
      expect(await closureOf(c)).toEqual({ [c]: 0, [b]: 1, [a]: 2 });

      const moved = await moveZone(b, e);
      expect(moved.status, JSON.stringify(moved)).toBe('APPLIED');
      expect(await closureOf(b)).toEqual({ [b]: 0, [e]: 1, [d]: 2 });
      expect(await closureOf(c)).toEqual({ [c]: 0, [b]: 1, [e]: 2, [d]: 3 });
      expect(await closureOf(a)).toEqual({ [a]: 0 });
      expect(fromBin((await rowOf(b)).parent_id!)).toBe(e);
      expect((await rowOf(b)).depth).toBe(3);
      expect((await rowOf(c)).depth).toBe(4);
      // La zone déplacée et ses descendantes sont publiées (la profondeur d'une règle de prix en dépend).
      const published = await db
        .selectFrom('sync_change_feed')
        .select('entity_id')
        .where('dataset', '=', 'zone')
        .where('entity_id', 'in', [toBin(b), toBin(c)])
        .execute();
      expect(published.map((row) => fromBin(row.entity_id))).toContain(c);

      // À la racine : plus aucune ancêtre au-dessus de la zone déplacée.
      const toRoot = await moveZone(b, null);
      expect(toRoot.status, JSON.stringify(toRoot)).toBe('APPLIED');
      expect(await closureOf(b)).toEqual({ [b]: 0 });
      expect(await closureOf(c)).toEqual({ [c]: 0, [b]: 1 });
      expect((await rowOf(b)).parent_id).toBeNull();
      expect([(await rowOf(b)).depth, (await rowOf(c)).depth]).toEqual([1, 2]);
      expect(await closureOf(e)).toEqual({ [e]: 0, [d]: 1 });

      // Même parente : appliqué sans effet (la version de la zone ne bouge pas).
      const before = (await rowOf(b)).version;
      expect((await moveZone(b, null)).status).toBe('APPLIED');
      expect((await rowOf(b)).version).toBe(before);
    });

    it('refus : sous elle-même ou sous une descendante (cycle), parente ou zone introuvable', async () => {
      const a = await createZone();
      const b = await createZone(a);
      const c = await createZone(b);
      expect(await moveZone(a, c)).toMatchObject({
        status: 'REJECTED',
        error: { code: 'ZONE_CYCLE' },
      });
      expect(await moveZone(a, a)).toMatchObject({
        status: 'REJECTED',
        error: { code: 'ZONE_CYCLE' },
      });
      expect(await moveZone(c, freshUuid())).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOT_FOUND' },
      });
      expect(await moveZone(freshUuid(), a)).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOT_FOUND' },
      });
      // Rien n'a bougé.
      expect(await closureOf(c)).toEqual({ [c]: 0, [b]: 1, [a]: 2 });
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
            openedOn: '2026-09-20',
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
        .select([
          'name',
          'status',
          sql<string>`DATE_FORMAT(opened_on, '%Y-%m-%d')`.as('opened_day'),
          sql<string>`DATE_FORMAT(closed_on, '%Y-%m-%d')`.as('closed_day'),
        ])
        .where('id', '=', toBin(siteId))
        .executeTakeFirstOrThrow();
      expect(row.name).toBe('PDV Test (renommé)');
      expect(row.status).toBe('CLOSED');
      // Colonnes `DATE` : le jour saisi, et le jour métier de la fermeture (Douala), jamais la veille.
      expect(row.opened_day).toBe('2026-09-20');
      expect(row.closed_day).toBe('2026-09-24');

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

      // S-28 (RP-3) : les appartenances d'équipe sont publiées dans sync_change_feed.
      const feedRows = await db
        .selectFrom('sync_change_feed')
        .select(['dataset', 'entity_type', 'scope_type', 'change_type'])
        .where('dataset', '=', 'team_membership')
        .where('entity_id', 'in', [toBin(membership1), toBin(membership2)])
        .orderBy('seq', 'asc')
        .execute();
      expect(feedRows.length).toBeGreaterThanOrEqual(4);
      expect(feedRows[0]).toMatchObject({
        dataset: 'team_membership',
        entity_type: 'TEAM_MEMBERSHIP',
        scope_type: 'GLOBAL',
        change_type: 'UPSERT',
      });
    });
  });

  describe('équipe — fermeture (AV-515)', () => {
    it('close : équipe inactive, appartenances closes et publiées, plus de membre accepté, rejeu sans effet', async () => {
      const manager = await createRealUser();
      const teamId = freshUuid();
      await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.team.create',
          aggregate_type: 'TEAM',
          aggregate_id: teamId,
          occurred_at: OCCURRED_AT,
          payload: {
            code: `T-${teamId.slice(-8)}`,
            name: 'Équipe à fermer',
            managerUserId: manager,
          },
        }),
        ctx(),
      );
      const memberships: string[] = [];
      for (let index = 0; index < 2; index++) {
        const membershipId = freshUuid();
        memberships.push(membershipId);
        const assigned = await pipeline.handle(
          buildEnvelope(admin, {
            command_type: 'organization.team.assign_member',
            aggregate_type: 'TEAM_MEMBERSHIP',
            aggregate_id: membershipId,
            occurred_at: OCCURRED_AT,
            payload: { userId: await createRealUser(), teamId },
          }),
          ctx(),
        );
        expect(assigned.status, JSON.stringify(assigned)).toBe('APPLIED');
      }
      const close = (reason?: string) =>
        pipeline.handle(
          buildEnvelope(admin, {
            command_type: 'organization.team.close',
            aggregate_type: 'TEAM',
            aggregate_id: teamId,
            occurred_at: LATER_OCCURRED_AT,
            payload: reason === undefined ? {} : { reason },
          }),
          ctx(),
        );
      const closed = await close('Réorganisation');
      expect(closed.status, JSON.stringify(closed)).toBe('APPLIED');

      const team = await db
        .selectFrom('organization_teams')
        .select(['is_active', 'version'])
        .where('id', '=', toBin(teamId))
        .executeTakeFirstOrThrow();
      expect(Number(team.is_active)).toBe(0);
      const rows = await db
        .selectFrom('organization_team_memberships')
        .select('valid_to')
        .where('team_id', '=', toBin(teamId))
        .execute();
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.valid_to).not.toBeNull();
      // Chaque appartenance close est republiée (l'appareil cesse de compter ces membres).
      const published = await db
        .selectFrom('sync_change_feed')
        .select('entity_id')
        .where('dataset', '=', 'team_membership')
        .where(
          'entity_id',
          'in',
          memberships.map((id) => toBin(id)),
        )
        .execute();
      expect(published.length).toBeGreaterThanOrEqual(4);

      // Une équipe fermée ne reçoit plus de membre.
      const refused = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'organization.team.assign_member',
          aggregate_type: 'TEAM_MEMBERSHIP',
          aggregate_id: freshUuid(),
          occurred_at: LATER_OCCURRED_AT,
          payload: { userId: await createRealUser(), teamId },
        }),
        ctx(),
      );
      expect(refused).toMatchObject({ status: 'REJECTED', error: { code: 'TEAM_CLOSED' } });

      // Rejeu sous un autre identifiant de commande : sans effet.
      expect((await close()).status).toBe('APPLIED');
      const after = await db
        .selectFrom('organization_teams')
        .select('version')
        .where('id', '=', toBin(teamId))
        .executeTakeFirstOrThrow();
      expect(after.version).toBe(team.version);
      expect(await close()).not.toMatchObject({ status: 'REJECTED' });
      expect(
        await pipeline.handle(
          buildEnvelope(admin, {
            command_type: 'organization.team.close',
            aggregate_type: 'TEAM',
            aggregate_id: freshUuid(),
            occurred_at: LATER_OCCURRED_AT,
            payload: {},
          }),
          ctx(),
        ),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
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

    it('AV-496 : la valeur d’une clé du catalogue est contrôlée par le serveur ; une clé hors catalogue reste libre', async () => {
      const set = (payload: Record<string, unknown>) =>
        pipeline.handle(
          buildEnvelope(admin, {
            command_type: 'organization.setting.set',
            aggregate_type: 'SETTING',
            aggregate_id: freshUuid(),
            occurred_at: OCCURRED_AT,
            payload,
          }),
          ctx(),
        );
      const refusal = { status: 'REJECTED', error: { code: 'SETTING_VALUE_INVALID' } };
      // Ces refus n'écrivent rien : les clés réelles restent intactes sur la base partagée.
      expect(
        await set({ key: 'finance.cash_session_force_close_hours', value: 0, scopeType: 'GLOBAL' }),
      ).toMatchObject(refusal);
      expect(
        await set({
          key: 'finance.cash_session_force_close_hours',
          value: '24',
          scopeType: 'GLOBAL',
        }),
      ).toMatchObject(refusal);
      expect(
        await set({
          key: 'finance.cash_session_force_close_hours',
          value: 1.5,
          scopeType: 'GLOBAL',
        }),
      ).toMatchObject(refusal);
      expect(
        await set({
          key: 'sales.delivery_requires_full_payment',
          value: 'oui',
          scopeType: 'GLOBAL',
        }),
      ).toMatchObject(refusal);
      expect(
        await set({
          key: 'production.egg_grade_product_codes',
          value: ['GROS', ' '],
          scopeType: 'GLOBAL',
        }),
      ).toMatchObject(refusal);
      expect(
        await set({ key: 'pricing.max_discount_pct.VENDEUR_PDV', value: 150, scopeType: 'GLOBAL' }),
      ).toMatchObject(refusal);
      // Valeur absente, même pour une clé hors catalogue.
      expect(await set({ key: `test.av496.${freshUuid()}`, scopeType: 'GLOBAL' })).toMatchObject(
        refusal,
      );

      // Valide : posée sur un site d'essai (jamais en global sur une clé réelle) ; hors catalogue : toute valeur.
      const zoneId = await db.transaction().execute((trx) => insertTestZone(trx, admin));
      const siteId = await db.transaction().execute((trx) => insertTestSite(trx, admin, zoneId));
      expect(
        (
          await set({
            key: 'finance.cash_session_force_close_hours',
            value: 12,
            scopeType: 'SITE',
            scopeId: siteId,
          })
        ).status,
      ).toBe('APPLIED');
      expect(
        (await set({ key: `test.av496.${freshUuid()}`, value: { a: [1, 2] }, scopeType: 'GLOBAL' }))
          .status,
      ).toBe('APPLIED');
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

/**
 * P9-27 — KPI-OPS-02, opérations en attente et conflits ouverts (AV-462 (b), AV-479 ; AT-054, BR-ANA-009) :
 * équivalence de la fonction de référence `syncBacklog` avec (1) la définition indépendante écrite sur les
 * lignes sources, (2) les lectures HTTP existantes (`GET /sync/conflicts` pour les conflits, le tableau de
 * distribution `GET /analytics/dashboards/distribution` pour les restes déclarés par appareil).
 *
 * Deux mondes, tous deux faits d'identifiants neufs (base partagée, assertions relatives au monde créé) :
 * un monde **annulé** (`rolledBack`) pour les points qui comparent la fonction aux lignes sources, un monde
 * **validé** (`committed`) pour les lectures HTTP, qu'une transaction annulée ne rendrait pas visibles. Les
 * conflits ouverts du monde validé sont refermés en fin d'essai (`DISMISSED`) ; les appareils et les sites,
 * neufs, restent sans effet sur les autres essais.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { distributionDashboardResponseSchema, type CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { recordConflict } from '../src/platform/sync/conflicts.js';
import { devicesOfSites } from '../src/sync/device-freshness.js';
import { authorDataset, DEVICE_DATASET } from '../src/sync/sync-state-datasets.js';
import { syncBacklog } from '../src/sync/sync-backlog.js';
import { newActor, type Actor } from './cash-transfer-fixtures.js';
import { committed, rolledBack } from './communication-test-kit.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
} from './helpers.js';

/** Instant fixe, passé : jamais d'horloge décalée vers le futur (paramètres système immuables). */
const CONFIGURED_AT = '2026-10-05T08:00:00.000Z';
let deviceSeq = 0;

interface World {
  readonly root: string;
  /** Point de vente. */
  readonly siteS: string;
  /** Magasin d'un autre site. */
  readonly siteT: string;
  readonly posLocation: string;
  /** En service, reste déclaré 7 (et 100 sur une ligne d'auteur, jamais ajoutée). */
  readonly deviceA: string;
  /** En service, reste déclaré 0. */
  readonly deviceB: string;
  /** En service, jamais synchronisé (aucune ligne d'état). */
  readonly deviceC: string;
  /** Bloqué, reste déclaré 5 : jamais compté. */
  readonly deviceD: string;
  /** En service sur l'autre site, reste déclaré 3. */
  readonly deviceE: string;
  /** Conflits ouverts du site S (3) ; le quatrième est résolu. */
  readonly openOnS: readonly string[];
  readonly conflictOnT: string;
  readonly conflictWithoutSite: string;
}

/** Monde de l'essai : sites, appareils (avec restes déclarés) et conflits, tous neufs. */
async function buildWorld(uow: UnitOfWork): Promise<World> {
  const root = await insertTestUser(uow);
  const zone = await insertTestZone(uow, root);
  const siteS = await insertTestSite(uow, root, zone, { siteType: 'POINT_DE_VENTE' });
  const siteT = await insertTestSite(uow, root, zone, { siteType: 'MAGASIN' });
  const posLocation = await insertTestLocation(uow, root, siteS, { locationType: 'POS' });

  const device = async (status: 'ACTIVE' | 'BLOCKED', siteId: string): Promise<string> => {
    const id = await insertTestDevice(uow, root, { status });
    await uow
      .updateTable('identity_devices')
      .set({ designated_site_id: toBin(siteId) })
      .where('id', '=', toBin(id))
      .execute();
    return id;
  };
  const report = async (deviceId: string, pending: number, dataset = DEVICE_DATASET) => {
    await uow
      .insertInto('sync_device_sync_state')
      .values({ device_id: toBin(deviceId), dataset, pending_reported: pending })
      .execute();
  };
  const deviceA = await device('ACTIVE', siteS);
  const deviceB = await device('ACTIVE', siteS);
  const deviceC = await device('ACTIVE', siteS);
  const deviceD = await device('BLOCKED', siteS);
  const deviceE = await device('ACTIVE', siteT);
  await report(deviceA, 7);
  // Ligne d'un auteur de tablette partagée : son reste est déjà inclus dans celui de la ligne de l'appareil.
  await report(deviceA, 100, authorDataset(root));
  await report(deviceB, 0);
  await report(deviceD, 5);
  await report(deviceE, 3);

  const conflict = async (
    conflictType: string,
    ownerRole: string,
    siteId: string | null,
  ): Promise<string> => {
    const id = freshUuid();
    await recordConflict(uow, {
      id,
      commandId: null,
      conflictType,
      entityType: 'TEST_ENTITY',
      entityId: freshUuid(),
      siteId,
      ownerRole,
      applied: false,
      details: {},
    });
    return id;
  };
  const stockA = await conflict('STOCK_NEGATIVE', 'MAGASINIER', siteS);
  const stockB = await conflict('STOCK_NEGATIVE', 'MAGASINIER', siteS);
  const duplicate = await conflict('DUPLICATE_SUSPECTED', 'DIRECTION', siteS);
  const resolved = await conflict('TRANSFER_UNMATCHED', 'MAGASINIER', siteS);
  // Seule la résolution est modifiable (déclencheur `trg_sync_sync_conflicts_update_guard`).
  await uow
    .updateTable('sync_sync_conflicts')
    .set({
      status: 'RESOLVED',
      resolution: 'KEEP_SERVER',
      resolved_at: new Date(CONFIGURED_AT),
      resolved_by: toBin(root),
    })
    .where('id', '=', toBin(resolved))
    .execute();
  const conflictOnT = await conflict('STOCK_NEGATIVE', 'MAGASINIER', siteT);
  const conflictWithoutSite = await conflict('DUPLICATE_SUSPECTED', 'DIRECTION', null);

  return {
    root,
    siteS,
    siteT,
    posLocation,
    deviceA,
    deviceB,
    deviceC,
    deviceD,
    deviceE,
    openOnS: [stockA, stockB, duplicate],
    conflictOnT,
    conflictWithoutSite,
  };
}

/** Définition indépendante : restes déclarés des appareils en service, calculés en TypeScript sur les lignes. */
async function documentsBacklog(uow: UnitOfWork, deviceIds: readonly string[]) {
  const ids = deviceIds.map((id) => toBin(id));
  const devices = await uow
    .selectFrom('identity_devices')
    .select(['id', 'status'])
    .where('id', 'in', ids)
    .execute();
  const states = await uow
    .selectFrom('sync_device_sync_state')
    .select(['device_id', 'dataset', 'pending_reported'])
    .where('device_id', 'in', ids)
    .execute();
  let inService = 0;
  let withBacklog = 0;
  let pending = 0;
  for (const device of devices) {
    if (device.status !== 'ACTIVE') continue;
    inService += 1;
    const own = states.find(
      (state) => state.device_id.equals(device.id) && state.dataset === '_device',
    );
    const reported = own?.pending_reported ?? 0;
    if (reported > 0) withBacklog += 1;
    pending += reported;
  }
  return { inService, withBacklog, pending };
}

/** Conflits ouverts d'un site, comptés sur les lignes (statut `OPEN`), par type. */
async function documentsConflicts(uow: UnitOfWork, siteId: string, ownerRole?: string) {
  const rows = await uow
    .selectFrom('sync_sync_conflicts')
    .select(['conflict_type', 'owner_role', 'status'])
    .where('site_id', '=', toBin(siteId))
    .execute();
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    if (row.status !== 'OPEN') continue;
    if (ownerRole !== undefined && row.owner_role !== ownerRole) continue;
    byType[row.conflict_type] = (byType[row.conflict_type] ?? 0) + 1;
    total += 1;
  }
  return { total, byType };
}

describe('P9-27 : KPI-OPS-02, synchronisation', { timeout: 120_000 }, () => {
  describe('fonction de référence contre les lignes sources (monde annulé)', () => {
    it('opérations en attente : seuls les appareils en service lus comptent, reste de la ligne appareil', async () => {
      await rolledBack(async (uow) => {
        const w = await buildWorld(uow);
        const lus = [w.deviceA, w.deviceB, w.deviceC, w.deviceD];
        const result = await syncBacklog(uow, { devices: { deviceIds: lus }, conflicts: false });
        // A (7), B (0), C (jamais synchronisé : 0) sont en service ; D est bloqué ; E n'est pas lu.
        expect(result).toEqual({
          devicesInService: 3,
          devicesWithBacklog: 1,
          pendingOperations: 7,
          openConflicts: null,
        });
        const documents = await documentsBacklog(uow, lus);
        expect(documents).toEqual({ inService: 3, withBacklog: 1, pending: 7 });
        expect(result.devicesInService).toBe(documents.inService);
        expect(result.devicesWithBacklog).toBe(documents.withBacklog);
        expect(result.pendingOperations).toBe(documents.pending);

        // Un doublon dans la liste ne double rien ; des identifiants inconnus (au-delà d'un paquet de
        // 500) ne comptent pour rien.
        const crowd = Array.from({ length: 600 }, () => freshUuid());
        const noisy = await syncBacklog(uow, {
          devices: { deviceIds: [...crowd, w.deviceA, w.deviceA] },
          conflicts: false,
        });
        expect(noisy).toMatchObject({
          devicesInService: 1,
          devicesWithBacklog: 1,
          pendingOperations: 7,
        });
      });
    });

    it("'ALL' : tous les appareils en service (différence avant/après) ; liste vide : zéros", async () => {
      await rolledBack(async (uow) => {
        const before = await syncBacklog(uow, { devices: 'ALL', conflicts: false });
        await buildWorld(uow);
        const after = await syncBacklog(uow, { devices: 'ALL', conflicts: false });
        // A, B, C et E sont en service (D, bloqué, ne l'est pas) ; restes 7 + 0 + 3 ; A seul de S, E de T
        // ont un reste.
        expect(after.devicesInService - before.devicesInService).toBe(4);
        expect(after.devicesWithBacklog - before.devicesWithBacklog).toBe(2);
        expect(after.pendingOperations - before.pendingOperations).toBe(7 + 3);

        // Une liste vide ne lit rien : zéros, jamais « tous les appareils ».
        expect(
          await syncBacklog(uow, { devices: { deviceIds: [] }, conflicts: { siteIds: [] } }),
        ).toEqual({
          devicesInService: 0,
          devicesWithBacklog: 0,
          pendingOperations: 0,
          openConflicts: { total: 0, byType: {} },
        });
        expect(
          (await syncBacklog(uow, { devices: { deviceIds: [] }, conflicts: { ownerRoles: [] } }))
            .openConflicts,
        ).toEqual({ total: 0, byType: {} });
      });
    });

    it('conflits ouverts : statut OPEN seulement, par site et par rôle propriétaire', async () => {
      await rolledBack(async (uow) => {
        const noDevices = { deviceIds: [] as string[] };
        const everything = await syncBacklog(uow, { devices: noDevices, conflicts: {} });
        const w = await buildWorld(uow);

        const onS = await syncBacklog(uow, {
          devices: noDevices,
          conflicts: { siteIds: [w.siteS] },
        });
        // Trois conflits ouverts sur S ; le quatrième est résolu (et ne compte plus).
        expect(onS.openConflicts).toEqual({
          total: 3,
          byType: { STOCK_NEGATIVE: 2, DUPLICATE_SUSPECTED: 1 },
        });
        const documents = await documentsConflicts(uow, w.siteS);
        expect(onS.openConflicts).toEqual(documents);

        const magasinier = await syncBacklog(uow, {
          devices: noDevices,
          conflicts: { ownerRoles: ['MAGASINIER'], siteIds: [w.siteS] },
        });
        expect(magasinier.openConflicts).toEqual({ total: 2, byType: { STOCK_NEGATIVE: 2 } });
        const magasinierDocuments = await documentsConflicts(uow, w.siteS, 'MAGASINIER');
        expect(magasinier.openConflicts).toEqual(magasinierDocuments);

        // Sans filtre : tous les conflits ouverts, ceux d'un autre site et ceux sans site compris.
        const after = await syncBacklog(uow, { devices: noDevices, conflicts: {} });
        expect(after.openConflicts!.total - everything.openConflicts!.total).toBe(3 + 1 + 1);
        const counted = await uow
          .selectFrom('sync_sync_conflicts')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('status', '=', 'OPEN')
          .executeTakeFirstOrThrow();
        expect(after.openConflicts!.total).toBe(Number(counted.count));

        // Un site sans conflit, des listes vides, et le lecteur sans le droit (conflits non lus).
        const other = await syncBacklog(uow, {
          devices: noDevices,
          conflicts: { siteIds: [w.siteT] },
        });
        expect(other.openConflicts).toEqual({ total: 1, byType: { STOCK_NEGATIVE: 1 } });
        expect(
          (await syncBacklog(uow, { devices: noDevices, conflicts: { siteIds: [] } }))
            .openConflicts,
        ).toEqual({ total: 0, byType: {} });
        expect(
          (await syncBacklog(uow, { devices: noDevices, conflicts: { ownerRoles: [] } }))
            .openConflicts,
        ).toEqual({ total: 0, byType: {} });
        expect(
          (await syncBacklog(uow, { devices: noDevices, conflicts: false })).openConflicts,
        ).toBeNull();
      });
    });
  });

  describe('fonction de référence contre les lectures HTTP existantes (monde validé)', () => {
    let app: NestFastifyApplication;
    let world: World;
    let dir: Actor;
    let dirToken: string;
    let pipeline: CommandPipelineService;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      registerCorrelationId(app, app.get(ID_GENERATOR));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      pipeline = app.get(CommandPipelineService);

      world = await committed((uow) => buildWorld(uow));
      const admin = await newActor('ADMIN', world.root);
      dir = await newActor('DIRECTION', world.root);
      // Le site S devient un point de vente configuré (sans quoi le tableau de distribution ne le liste pas).
      const result: CommandResult = await pipeline.handle(
        {
          command_id: freshUuid(),
          device_seq: ++deviceSeq,
          command_version: 1,
          command_type: 'organization.pos.configure',
          aggregate_type: 'SITE',
          aggregate_id: world.siteS,
          author_user_id: admin.userId,
          base_version: null,
          depends_on: [],
          occurred_at: CONFIGURED_AT,
          client_created_at: CONFIGURED_AT,
          captured_offline: false,
          backdated_reason: null,
          attachment_ids: [],
          payload: { salesLocationId: world.posLocation, custodyMode: 'SHARED' },
        },
        {
          authenticatedUserId: admin.userId,
          authenticatedDeviceId: admin.deviceId,
          transport: 'ONLINE_API',
        },
      );
      expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
      dirToken = await signTestAccessToken(
        app.get(JWT_KEYS).privateKey,
        { sub: dir.userId, device_id: dir.deviceId, session_id: freshUuid() },
        app.get(CLOCK).now(),
      );
    }, 120_000);

    afterAll(async () => {
      // Les conflits ouverts du monde sont refermés : ils ne doivent pas peser sur les autres essais.
      if (world !== undefined) {
        await db
          .updateTable('sync_sync_conflicts')
          .set({
            status: 'DISMISSED',
            resolution: 'KEEP_SERVER',
            resolved_at: new Date(),
            resolved_by: toBin(world.root),
          })
          .where(
            'id',
            'in',
            [...world.openOnS, world.conflictOnT, world.conflictWithoutSite].map((id) => toBin(id)),
          )
          .where('status', '=', 'OPEN')
          .execute();
      }
      await app.close();
      await closeTestDb();
    });

    const get = (url: string) =>
      app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${dirToken}` } });

    it('conflits : la fonction compte autant que la file GET /sync/conflicts du site', async () => {
      const response = await get(
        `/api/v1/sync/conflicts?status=OPEN&site_id=${world.siteS}&limit=200`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const listed = (response.json() as { conflicts: { id: string }[] }).conflicts;
      const summary = await syncBacklog(db, {
        devices: { deviceIds: [] },
        conflicts: { siteIds: [world.siteS] },
      });
      expect(listed.map((conflict) => conflict.id).sort()).toEqual([...world.openOnS].sort());
      expect(listed).toHaveLength(3);
      expect(summary.openConflicts!.total).toBe(listed.length);
    });

    it('opérations : la fonction égale la somme des restes du point de vente au tableau de distribution', async () => {
      const response = await get(
        `/api/v1/analytics/dashboards/distribution?site_id=${world.siteS}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const board = distributionDashboardResponseSchema.parse(response.json());
      expect(board.pointsOfSale).toHaveLength(1);
      const items = board.pointsOfSale[0]!.devices.items;
      const shown = items
        .filter((item) => item.status === 'ACTIVE')
        .reduce((sum, item) => sum + (item.pendingReported ?? 0), 0);

      // Les appareils du point de vente sont ceux que le tableau lit (`devicesOfSites`) ; le bloqué D en est écarté.
      const deviceIds = (await devicesOfSites(db, [world.siteS])).get(world.siteS) ?? [];
      expect([...deviceIds].sort()).toEqual([world.deviceA, world.deviceB, world.deviceC].sort());
      const result = await syncBacklog(db, { devices: { deviceIds }, conflicts: false });
      expect(result.pendingOperations).toBe(shown);
      expect(result.pendingOperations).toBe(7);
      expect(result.devicesInService).toBe(items.filter((item) => item.status === 'ACTIVE').length);
    });
  });
});

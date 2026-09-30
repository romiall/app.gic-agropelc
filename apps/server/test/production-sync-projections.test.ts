/**
 * Projections `/sync/pull` du jeu `production` (P7-12 ; 01-architecture-offline.md §3.1 : « lots
 * actifs du site, lots d'incubation en cours, saisies des 30 derniers jours », filtre `SITE`),
 * alimentées par `production` et, pour les pertes et consommations d'un lot, par `inventory`.
 * Données écrites par le vrai pipeline avec les rôles réels du seed ; téléchargement par le vrai
 * `SyncPullService`.
 *
 * Démontre : le responsable de ferme reçoit les lots ouverts, l'incubation en cours et les saisies
 * récentes de sa ferme (entrées, pesées, observations, pertes, consommations, collectes,
 * abattages), sans aucune valeur (RC-05), jamais ceux d'une autre ferme ; une annulation ou une
 * décision de validation renvoie la saisie avec son nouveau statut ; un lot annulé sort de
 * l'appareil (`SCOPE_EXIT`) ; une saisie de plus de 30 jours n'est pas servie ; le Responsable
 * production, affecté globalement, reçoit toutes les fermes ; un magasinier affecté à une ferme
 * ne reçoit rien (pas de `production.lot.read`) ; le repli générique `GLOBAL` du pipeline ne sert
 * jamais une donnée de ferme.
 *
 * Les heures métier sont relatives à l'heure réelle : la fenêtre de 30 jours est évaluée par la
 * base (`UTC_TIMESTAMP`), au moment du téléchargement. Les paramètres des calibres, de l'œuf à
 * couver et des durées d'incubation sont insérés avec des valeurs stables (mêmes codes que
 * production-read.e2e.test.ts), datés de quelques heures avant le test (après le seed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerConsumptionCommands } from '../src/modules/inventory/application/commands/consumption-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerDailyCommands } from '../src/modules/production/application/commands/daily-commands.js';
import { registerEggCollectionCommands } from '../src/modules/production/application/commands/egg-collection-commands.js';
import { registerIncubationCommands } from '../src/modules/production/application/commands/incubation-commands.js';
import { registerSlaughterCommands } from '../src/modules/production/application/commands/slaughter-commands.js';
import {
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { computeDeviceScope } from '../src/sync/device-scope.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
/** Heure métier `minutes` avant maintenant (ISO). */
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const DAY_MINUTES = 24 * 60;
let deviceSeq = 0;

const GRADE_CODE = 'TEST-OEUF-E2E-GROS';
const HATCHING_CODE = 'TEST-OEUF-E2E-COUVER';

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('projections /sync/pull du jeu production (P7-12)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0: number;
  let admin: Actor;
  let rfeA: Actor;
  let rfeB: Actor;
  let rpr: Actor;
  let magA: Actor;
  let farmA: string;
  let farmB: string;
  let buildingA: string;
  let storeA: string;
  let incubatorA: string;
  let houseA: string;
  let broilerId: string;
  let chickId: string;
  let pulletId: string;
  let layerId: string;
  let feedId: string;
  let gradeId: string;
  let hatchingEggId: string;
  let wholeId: string;
  let chickLotA: string;
  let chickLotB: string;
  let pulletLot: string;
  let eggLot: string;
  let lotA: string;
  let lotB: string;
  let layerLot: string;
  let entryA: string;
  let weighingId: string;
  let oldWeighingId: string;
  let observationId: string;
  let mortalityId: string;
  let consumptionId: string;
  let collectionId: string;
  let slaughterId: string;
  let incubationId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<Result> {
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
    return result;
  }

  async function pull(actor: Actor, dataset = 'production'): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset, cursor: cursor0, limit: 2000 },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        now: clock.now(),
      },
    );
    return response.changes;
  }

  /** Dernier état reçu pour une entité (l'appareil applique les changements dans l'ordre). */
  function latest(changes: readonly Change[], entityType: string, entityId: string) {
    const matching = changes.filter(
      (c) => c.entity_type === entityType && c.entity_id === entityId,
    );
    return matching[matching.length - 1];
  }

  /** Clés de montant d'une donnée projetée, à toute profondeur (RC-05 : aucune attendue). */
  function amountKeys(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => amountKeys(item));
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
        ...(/xaf|unit_cost|value/i.test(key) ? [key] : []),
        ...amountKeys(item),
      ]);
    }
    return [];
  }

  async function placedLot(
    actor: Actor,
    lotType: string,
    productId: string,
    mainLocationId: string,
    source: { readonly productId: string; readonly locationId: string; readonly lotId: string },
    quantity: number,
  ): Promise<{ readonly lotId: string; readonly entryId: string }> {
    const lotId = freshUuid();
    await run(rpr, 'production.lot.create', 'PRODUCTION_LOT', lotId, ago(300), {
      lotType,
      productId,
      mainLocationId,
    });
    const entryId = freshUuid();
    await run(actor, 'production.lot.record_entry', 'LOT_ENTRY', entryId, ago(290), {
      productionLotId: lotId,
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: source.productId,
      sourceLocationId: source.locationId,
      sourceStockLotId: source.lotId,
      quantity,
    });
    return { lotId, entryId };
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerConsumptionCommands(registry, idGenerator);
    registerLotCommands(registry, idGenerator, sequences);
    registerDailyCommands(registry, idGenerator, sequences);
    registerEggCollectionCommands(registry, idGenerator, sequences);
    registerIncubationCommands(registry, idGenerator, sequences);
    registerSlaughterCommands(registry, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);
    const high = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(high?.seq ?? 0);

    const roles = {
      rfe: await roleId('RESP_FERME'),
      rpr: await roleId('RESP_PRODUCTION'),
      mag: await roleId('MAGASINIER'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      farmA = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      farmB = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingA = await insertTestLocation(trx, adminId, farmA, { locationType: 'BUILDING' });
      const buildingB = await insertTestLocation(trx, adminId, farmB, {
        locationType: 'BUILDING',
      });
      storeA = await insertTestLocation(trx, adminId, farmA);
      const storeB = await insertTestLocation(trx, adminId, farmB);
      incubatorA = await insertTestLocation(trx, adminId, farmA, { locationType: 'INCUBATOR' });
      houseA = await insertTestLocation(trx, adminId, farmA, { locationType: 'SLAUGHTERHOUSE' });
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = {},
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      rfeA = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmA });
      rfeB = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmB });
      rpr = await actor(roles.rpr);
      magA = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: farmA });

      for (const [unit, name, isCount] of [
        ['TETE', 'Tête', 1],
        ['KG', 'Kilogramme', 0],
        ['OEUF', 'Œuf', 1],
        ['PIECE', 'Pièce', 1],
      ] as const) {
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', unit)
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_units')
            .values({ code: unit, name, is_count: isCount })
            .execute();
        }
      }
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Élevage',
          created_by: toBin(adminId),
        })
        .execute();
      const product = async (values: {
        readonly code?: string;
        readonly name: string;
        readonly family: string;
        readonly species?: string;
        readonly unit: string;
        readonly standardCost?: number;
      }): Promise<string> => {
        if (values.code !== undefined) {
          const existing = await trx
            .selectFrom('catalog_products')
            .select('id')
            .where('code', '=', values.code)
            .executeTakeFirst();
          if (existing) return fromBin(existing.id);
        }
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: values.code ?? `P-${id.slice(-10)}`,
            name: values.name,
            category_id: toBin(categoryId),
            stock_family: values.family,
            species: values.species ?? null,
            base_unit_code: values.unit,
            lot_tracking: values.family === 'INTRANT' ? 'NONE' : 'REQUIRED',
            is_consumable: values.family === 'INTRANT' ? 1 : 0,
            created_by: toBin(adminId),
          })
          .execute();
        if (values.standardCost !== undefined) {
          await trx
            .insertInto('catalog_product_standard_costs')
            .values({
              id: toBin(freshUuid()),
              product_id: toBin(id),
              unit_cost_xaf: values.standardCost,
              valid_from: new Date('2026-01-01T00:00:00.000Z'),
              created_by: toBin(adminId),
            })
            .execute();
        }
        return id;
      };
      const animal = { family: 'BIOLOGIQUE', unit: 'TETE' };
      chickId = await product({ ...animal, name: 'Poussin chair', species: 'POULET_CHAIR' });
      broilerId = await product({
        ...animal,
        name: 'Poulet de chair vif',
        species: 'POULET_CHAIR',
      });
      pulletId = await product({ ...animal, name: 'Poulette', species: 'PONDEUSE' });
      layerId = await product({ ...animal, name: 'Poule pondeuse', species: 'PONDEUSE' });
      feedId = await product({ name: 'Aliment croissance', family: 'INTRANT', unit: 'KG' });
      const egg = { family: 'PRODUCTION_COMMERCIALISABLE', unit: 'OEUF' };
      gradeId = await product({ ...egg, code: GRADE_CODE, name: 'Œuf gros', standardCost: 90 });
      hatchingEggId = await product({ ...egg, code: HATCHING_CODE, name: 'Œuf à couver' });
      wholeId = await product({
        name: 'Poulet entier',
        family: 'PRODUCTION_COMMERCIALISABLE',
        unit: 'PIECE',
      });
      for (const [key, value] of [
        ['production.egg_grade_product_codes', [GRADE_CODE]],
        ['production.hatching_egg_product_code', HATCHING_CODE],
        [
          'production.incubation_durations',
          { POULE: { candlingDay: 7, transferDay: 18, hatchDay: 21 } },
        ],
      ] as const) {
        await trx
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key,
            value: JSON.stringify(value),
            scope_type: 'GLOBAL',
            // Plus récent que les versions du seed, datées du jour de son exécution.
            valid_from: new Date(ago(400)),
            is_client_visible: 1,
            reason: 'Test P7-12',
            created_by: toBin(adminId),
          })
          .execute();
      }
      const supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Couvoir',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
      const supplierLot = (productId: string, ref: string) =>
        ensureSupplierLot(
          trx,
          { idGenerator },
          {
            productId,
            supplierId,
            supplierLotRef: `${ref}-${supplierId.slice(-6)}`,
            fallbackCode: `F:${ref}-${supplierId.slice(-6)}`,
            expiryDate: null,
            originId: freshUuid(),
            fifoRankAt: new Date(ago(60 * DAY_MINUTES)),
            createdBy: adminId,
          },
        );
      chickLotA = await supplierLot(chickId, 'PCA');
      chickLotB = await supplierLot(chickId, 'PCB');
      pulletLot = await supplierLot(pulletId, 'PUL');
      eggLot = await supplierLot(hatchingEggId, 'OAC');
      const opening = await virtualLocationId(trx, 'V_OPENING');
      for (const [productId, lotId, locationId, quantity] of [
        [chickId, chickLotA, storeA, 400],
        [chickId, chickLotB, storeB, 100],
        [pulletId, pulletLot, storeA, 200],
        [hatchingEggId, eggLot, storeA, 100],
        [feedId, undefined, storeA, 500],
      ] as const) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            ...(lotId !== undefined ? { lotId } : {}),
            quantityBase: quantity,
            fromLocationId: opening,
            toLocationId: locationId,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: 200,
            occurredAt: new Date(ago(60 * DAY_MINUTES)),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: freshUuid(),
            createdBy: adminId,
            allowNegative: false,
          },
        );
      }
      void buildingB;
    });

    // Toute mortalité de la fenêtre du test part en validation (seuils à 0, sans photo).
    const policyId = freshUuid();
    await run(admin, 'approvals.policy.set', 'CONTROL_POLICY', policyId, ago(400), {
      code: `MORTALITY_${policyId.slice(-8)}`,
      operationType: 'MORTALITY',
      validFrom: ago(400),
      validTo: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      requiresApproval: true,
      requiresPhoto: false,
      approverPermission: 'production.mortality.approve',
      approverScope: 'ALL',
      condition: { relativePct: 0, absoluteHeads: 0 },
    });

    ({ lotId: lotA, entryId: entryA } = await placedLot(
      rfeA,
      'POULET_CHAIR',
      broilerId,
      buildingA,
      { productId: chickId, locationId: storeA, lotId: chickLotA },
      400,
    ));
    const farmBBuilding = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('site_id', '=', toBin(farmB))
      .where('location_type', '=', 'BUILDING')
      .executeTakeFirstOrThrow();
    const storeBRow = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('site_id', '=', toBin(farmB))
      .where('location_type', '!=', 'BUILDING')
      .executeTakeFirstOrThrow();
    ({ lotId: lotB } = await placedLot(
      rfeB,
      'POULET_CHAIR',
      broilerId,
      fromBin(farmBBuilding.id),
      { productId: chickId, locationId: fromBin(storeBRow.id), lotId: chickLotB },
      100,
    ));
    ({ lotId: layerLot } = await placedLot(
      rfeA,
      'PONDEUSE',
      layerId,
      buildingA,
      { productId: pulletId, locationId: storeA, lotId: pulletLot },
      200,
    ));

    weighingId = freshUuid();
    await run(rfeA, 'production.weighing.record', 'LOT_WEIGHING', weighingId, ago(200), {
      productionLotId: lotA,
      sampleSize: 20,
      avgWeightG: 45,
    });
    // Pesée datée de plus de 30 jours : hors de la fenêtre servie.
    oldWeighingId = freshUuid();
    await run(
      rfeA,
      'production.weighing.record',
      'LOT_WEIGHING',
      oldWeighingId,
      ago(40 * DAY_MINUTES),
      { productionLotId: lotA, sampleSize: 5, avgWeightG: 40 },
    );
    observationId = freshUuid();
    await run(rfeA, 'production.observation.record', 'LOT_OBSERVATION', observationId, ago(190), {
      productionLotId: lotA,
      observationType: 'AUTRE',
      text: 'RAS',
    });
    mortalityId = freshUuid();
    await run(rfeA, 'production.mortality.record', 'STOCK_LOSS', mortalityId, ago(180), {
      productionLotId: lotA,
      quantity: 2,
    });
    consumptionId = freshUuid();
    await run(rfeA, 'production.input.record', 'CONSUMPTION', consumptionId, ago(170), {
      productionLotId: lotA,
      locationId: storeA,
      productId: feedId,
      quantityBase: 25,
      unitCode: 'KG',
      quantity: 25,
      costType: 'ALIMENT',
    });
    collectionId = freshUuid();
    await run(rfeA, 'production.egg_collection.record', 'EGG_COLLECTION', collectionId, ago(160), {
      productionLotId: layerLot,
      storageLocationId: storeA,
      collected: 190,
      broken: 5,
      nonconforming: 5,
      hatching: 0,
      grades: [{ productId: gradeId, quantity: 180 }],
    });
    slaughterId = freshUuid();
    await run(rfeA, 'production.slaughter.record', 'SLAUGHTER', slaughterId, ago(150), {
      productionLotId: lotA,
      sourceLocationId: buildingA,
      slaughterhouseLocationId: houseA,
      heads: 10,
      condemnedHeads: 0,
      liveWeightG: 20_000,
      outputs: [{ productId: wholeId, toLocationId: storeA, quantityBase: 10, weightG: 14_000 }],
    });
    incubationId = freshUuid();
    await run(rfeA, 'production.incubation.start', 'INCUBATION_BATCH', incubationId, ago(140), {
      species: 'POULE',
      eggProductId: hatchingEggId,
      chickProductId: chickId,
      incubatorLocationId: incubatorA,
      eggSource: 'PURCHASED',
      eggsSet: 100,
      sourceLocationId: storeA,
      sourceStockLotId: eggLot,
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('responsable de ferme : lots ouverts, incubation en cours et saisies récentes de sa ferme, sans valeur', async () => {
    const changes = await pull(rfeA);
    const lot = latest(changes, 'PRODUCTION_LOT', lotA);
    expect(lot?.data).toMatchObject({
      id: lotA,
      lot_type: 'POULET_CHAIR',
      site_id: farmA,
      status: 'ACTIVE',
      initial_quantity: 400,
      stock_lot_id: expect.any(String),
    });
    expect(latest(changes, 'PRODUCTION_LOT', layerLot)?.data).toMatchObject({
      lot_type: 'PONDEUSE',
    });
    expect(latest(changes, 'PRODUCTION_LOT', lotB)).toBeUndefined();

    expect(latest(changes, 'LOT_ENTRY', entryA)?.data).toMatchObject({
      production_lot_id: lotA,
      quantity_base: 400,
      status: 'RECORDED',
    });
    expect(latest(changes, 'LOT_WEIGHING', weighingId)?.data).toMatchObject({
      avg_weight_g: 45,
      sample_size: 20,
      status: 'RECORDED',
    });
    expect(latest(changes, 'LOT_OBSERVATION', observationId)?.data).toMatchObject({
      observation_type: 'AUTRE',
      text: 'RAS',
    });
    expect(latest(changes, 'LOT_LOSS', mortalityId)?.data).toMatchObject({
      production_lot_id: lotA,
      category: 'MORTALITE',
      quantity_base: 2,
      requires_approval: true,
      status: 'PENDING_APPROVAL',
    });
    expect(latest(changes, 'LOT_CONSUMPTION', consumptionId)?.data).toMatchObject({
      production_lot_id: lotA,
      product_id: feedId,
      quantity_base: 25,
      cost_type: 'ALIMENT',
      status: 'RECORDED',
    });
    expect(latest(changes, 'EGG_COLLECTION', collectionId)?.data).toMatchObject({
      production_lot_id: layerLot,
      collected_qty: 190,
      marketable_qty: 180,
      grades: [{ product_id: gradeId, quantity: 180 }],
    });
    expect(latest(changes, 'SLAUGHTER', slaughterId)?.data).toMatchObject({
      heads_qty: 10,
      live_weight_g: 20_000,
      output_weight_g: 14_000,
      yield_rate: 0.7,
      outputs: [{ product_id: wholeId, quantity_base: 10, weight_g: 14_000 }],
    });
    expect(latest(changes, 'INCUBATION_BATCH', incubationId)?.data).toMatchObject({
      eggs_set_qty: 100,
      status: 'INCUBATING',
      expected_hatch_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });

    // RC-05 : aucune valeur, aucun coût dans le jeu.
    const withData = changes.filter((c) => c.data !== undefined);
    expect(withData.length).toBeGreaterThanOrEqual(10);
    expect(withData.flatMap((c) => amountKeys(c.data))).toEqual([]);
    // Aucune donnée d'une autre ferme.
    expect(withData.filter((c) => (c.data as { site_id?: string }).site_id === farmB)).toEqual([]);
  });

  it('fenêtre de 30 jours : une saisie plus ancienne n’est pas servie', async () => {
    expect(latest(await pull(rfeA), 'LOT_WEIGHING', oldWeighingId)).toBeUndefined();
  });

  it('annulation et décision de validation : la saisie revient avec son nouveau statut ; lot annulé → SCOPE_EXIT', async () => {
    await run(rfeA, 'production.weighing.cancel', 'LOT_WEIGHING', weighingId, ago(100), {
      comment: 'Balance déréglée',
    });
    await run(rfeA, 'inventory.consumption.cancel', 'CONSUMPTION', consumptionId, ago(95), {
      consumptionId,
      cancelComment: 'Mauvais bâtiment',
    });
    const loss = await db
      .selectFrom('inventory_loss_declarations')
      .select('approval_request_id')
      .where('id', '=', toBin(mortalityId))
      .executeTakeFirstOrThrow();
    const requestId = fromBin(loss.approval_request_id!);
    await run(rpr, 'approvals.request.approve', 'APPROVAL_REQUEST', requestId, ago(90), {
      requestId,
    });

    const planned = freshUuid();
    await run(rpr, 'production.lot.create', 'PRODUCTION_LOT', planned, ago(80), {
      lotType: 'POULET_CHAIR',
      productId: broilerId,
      mainLocationId: buildingA,
    });
    await run(rpr, 'production.lot.cancel', 'PRODUCTION_LOT', planned, ago(70), {
      comment: 'Bande reportée',
    });

    const changes = await pull(rfeA);
    expect(latest(changes, 'LOT_WEIGHING', weighingId)).toMatchObject({
      row_version: 2,
      data: { status: 'CANCELLED' },
    });
    expect(latest(changes, 'LOT_CONSUMPTION', consumptionId)?.data).toMatchObject({
      status: 'CANCELLED',
    });
    expect(latest(changes, 'LOT_LOSS', mortalityId)).toMatchObject({
      row_version: 2,
      data: { status: 'APPROVED' },
    });
    expect(latest(changes, 'PRODUCTION_LOT', planned)?.change_type).toBe('SCOPE_EXIT');
  });

  it('portée : le Responsable production reçoit toutes les fermes ; un magasinier de la ferme rien ; repli GLOBAL jamais servi', async () => {
    const all = await pull(rpr);
    expect(latest(all, 'PRODUCTION_LOT', lotA)?.data).toMatchObject({ site_id: farmA });
    expect(latest(all, 'PRODUCTION_LOT', lotB)?.data).toMatchObject({ site_id: farmB });

    const scope = await computeDeviceScope(db, rpr.userId, rpr.deviceId, NOW, 'production');
    const sites = scope.filter((e) => e.scopeType === 'SITE').map((e) => e.scopeId);
    expect(sites).toEqual(expect.arrayContaining([farmA, farmB]));
    // Hors du jeu production, l'affectation globale n'ouvre aucun site.
    const generic = await computeDeviceScope(db, rpr.userId, rpr.deviceId, NOW);
    expect(generic.filter((e) => e.scopeType === 'SITE')).toEqual([]);

    expect((await pull(rfeB)).filter((c) => c.data !== undefined).map((c) => c.entity_id)).toEqual(
      expect.not.arrayContaining([lotA, entryA, collectionId, slaughterId, incubationId]),
    );
    expect(latest(await pull(rfeB), 'PRODUCTION_LOT', lotB)?.data).toMatchObject({ id: lotB });

    const store = await pull(magA);
    expect(store.filter((c) => c.data !== undefined)).toEqual([]);

    // Lignes génériques du pipeline (jeu = type d'agrégat, portée GLOBAL) : aucune donnée.
    for (const dataset of [
      'production_lot',
      'lot_entry',
      'lot_weighing',
      'lot_observation',
      'egg_collection',
      'slaughter',
      'incubation_batch',
    ]) {
      const fallback = await pull(rfeA, dataset);
      expect(fallback.filter((c) => c.data !== undefined)).toEqual([]);
    }
  });
});

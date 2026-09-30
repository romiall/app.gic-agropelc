/**
 * P7-13 — tests d'acceptation de la production (09-non-functional/03-plan-de-tests.md), parts P7,
 * à travers le vrai pipeline avec les rôles réels du seed :
 * - AT-026 : cycle d'un lot de 2 400 poulets conforme à l'exemple de la stratégie finance §6.2 —
 *   mise en place 2 400 × 450, aliment 280 sacs × 15 000, vétérinaire 180 000, litière 140 000
 *   (la « dépense directe » de l'exemple ; en P8, une dépense imputée au lot), 90 morts (3,75 %),
 *   coût 5 600 000, coût par tête 5 600 000 / 2 310 ≈ 2 424 ; sortie des 2 310 têtes par
 *   abattage au coût restant exact, clôture sans coût non emporté. Le CA et la marge du lot
 *   arrivent avec les ventes (P4) ;
 * - AT-027 : 30 morts sur un lot de 2 000 → validation requise (paramètres AV-048 : seuils à 0,
 *   photo) ; les têtes attendent la décision, comptées à part. L'alerte `HIGH_MORTALITY` est en P9 ;
 * - AT-052 : 40 porcs sur 2 cases ; 5 têtes déplacées d'une case à l'autre ; pesée d'échantillon ;
 *   effectif par case = solde de l'emplacement, effectif du groupe inchangé, aucun identifiant
 *   individuel. La vente de 3 têtes arrive avec P4 ;
 * - AT-053 : l'administrateur ajoute un calibre d'œufs (produit + paramètre) : utilisable aussitôt
 *   par la collecte, sans changer le modèle de mouvement ; les collectes antérieures sont
 *   inchangées.
 * AT-028 et AT-029 : production-egg-collection-commands.test.ts, production-incubation-commands.
 *
 * Les politiques de mortalité du test valent une journée (la plus récente l'emporte) ; les codes
 * des calibres de AT-053 sont stables d'une exécution à l'autre (paramètres sans fin de validité).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerProductCommands } from '../src/modules/catalog/application/commands/product-commands.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerConsumptionCommands } from '../src/modules/inventory/application/commands/consumption-commands.js';
import { registerTransferCommands } from '../src/modules/inventory/application/commands/transfer-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerDailyCommands } from '../src/modules/production/application/commands/daily-commands.js';
import { registerEggCollectionCommands } from '../src/modules/production/application/commands/egg-collection-commands.js';
import { registerSlaughterCommands } from '../src/modules/production/application/commands/slaughter-commands.js';
import {
  ensureSupplierLot,
  lotHeadcount,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { getProductionLot } from '../src/modules/production/application/public/index.js';
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

/** Jour des AT-027, AT-052, AT-053 ; AT-026 court du 15/09 au 27/10. */
const DAY = '2026-10-28';
const at = (hhmmss: string, day = DAY) => `${day}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
let deviceSeq = 0;

const GRADE_MEDIUM = 'TEST-AT053-MOYEN';
const GRADE_LARGE = 'TEST-AT053-GROS';

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-13 : tests d’acceptation de la production (parts P7)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let policyAdmin: Actor;
  let admin: Actor;
  let farmManager: Actor;
  let productionManager: Actor;
  let farmId: string;
  let buildingId: string;
  let storeId: string;
  let houseId: string;
  let pen1: string;
  let pen2: string;
  let categoryId: string;
  let chickId: string;
  let broilerId: string;
  let feedId: string;
  let vaccineId: string;
  let litterId: string;
  let wholeId: string;
  let pigletId: string;
  let pigId: string;
  let pulletId: string;
  let layerId: string;
  let mediumId: string;
  let chickLot: string;
  let chickLot2: string;
  let pigletLot: string;
  let pulletLot: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<Result> {
    return pipeline.handle(
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
  }

  async function ok(...args: Parameters<typeof run>): Promise<Result> {
    const result = await run(...args);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  }

  async function lotWithEntries(
    lotType: string,
    productId: string,
    mainLocationId: string,
    time: string,
    entries: readonly {
      readonly productId: string;
      readonly lotId: string;
      readonly quantity: number;
      readonly toLocationId?: string;
    }[],
  ): Promise<string> {
    const id = freshUuid();
    await ok(productionManager, 'production.lot.create', 'PRODUCTION_LOT', id, time, {
      lotType,
      productId,
      mainLocationId,
    });
    for (const entry of entries) {
      await ok(farmManager, 'production.lot.record_entry', 'LOT_ENTRY', freshUuid(), time, {
        productionLotId: id,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: entry.productId,
        sourceLocationId: storeId,
        sourceStockLotId: entry.lotId,
        quantity: entry.quantity,
        ...(entry.toLocationId !== undefined ? { toLocationId: entry.toLocationId } : {}),
      });
    }
    return id;
  }

  /** Politique de mortalité valable un jour métier (la plus récente l'emporte). */
  async function mortalityPolicy(
    day: string,
    options: { readonly requiresApproval: boolean; readonly requiresPhoto: boolean },
  ): Promise<void> {
    const policyId = freshUuid();
    await ok(policyAdmin, 'approvals.policy.set', 'CONTROL_POLICY', policyId, at('00:00:00', day), {
      code: `MORTALITY_${policyId.slice(-8)}`,
      operationType: 'MORTALITY',
      validFrom: at('00:00:00', day),
      validTo: at('23:59:59', day),
      requiresApproval: options.requiresApproval,
      requiresPhoto: options.requiresPhoto,
      approverPermission: 'production.mortality.approve',
      approverScope: 'ALL',
      condition: { relativePct: 0, absoluteHeads: 0 },
    });
  }

  async function balanceAt(locationId: string, productId: string, lotId: string) {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .where('lot_key', '=', toBin(lotId))
      .executeTakeFirst();
    return row ? Number(row.qty_on_hand) : 0;
  }

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerProductCommands(registry);
    registerSettingCommands(registry);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerConsumptionCommands(registry, idGenerator);
    registerTransferCommands(registry, decisions, idGenerator, sequences);
    registerLotCommands(registry, idGenerator, sequences);
    registerDailyCommands(registry, idGenerator, sequences);
    registerEggCollectionCommands(registry, idGenerator, sequences);
    registerSlaughterCommands(registry, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      rfe: await roleId('RESP_FERME'),
      rpr: await roleId('RESP_PRODUCTION'),
      adm: await roleId('ADMIN'),
    };
    await db.transaction().execute(async (trx) => {
      const rootId = await insertTestUser(trx);
      policyAdmin = { userId: rootId, deviceId: await insertTestDevice(trx, rootId) };
      const policyRole = await insertTestRole(trx, rootId);
      await grantTestPermission(trx, policyRole, 'approvals.policy.manage', rootId);
      await assignTestRole(trx, rootId, policyRole, rootId);
      const zoneId = await insertTestZone(trx, rootId);
      farmId = await insertTestSite(trx, rootId, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, rootId, farmId, { locationType: 'BUILDING' });
      const pigHouse = await insertTestLocation(trx, rootId, farmId, { locationType: 'BUILDING' });
      pen1 = await insertTestLocation(trx, rootId, farmId, {
        locationType: 'PEN',
        parentLocationId: pigHouse,
      });
      pen2 = await insertTestLocation(trx, rootId, farmId, {
        locationType: 'PEN',
        parentLocationId: pigHouse,
      });
      storeId = await insertTestLocation(trx, rootId, farmId);
      houseId = await insertTestLocation(trx, rootId, farmId, { locationType: 'SLAUGHTERHOUSE' });
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, rootId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      productionManager = await actor(roles.rpr);
      admin = await actor(roles.adm);

      for (const [unit, name, isCount] of [
        ['TETE', 'Tête', 1],
        ['SAC', 'Sac', 1],
        ['FLACON', 'Flacon', 1],
        ['BALLE', 'Balle', 1],
        ['PIECE', 'Pièce', 1],
        ['OEUF', 'Œuf', 1],
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
      categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Ferme',
          created_by: toBin(rootId),
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
            created_by: toBin(rootId),
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
              created_by: toBin(rootId),
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
      pigletId = await product({ ...animal, name: 'Porcelet', species: 'PORC' });
      pigId = await product({ ...animal, name: 'Porc charcutier', species: 'PORC' });
      pulletId = await product({ ...animal, name: 'Poulette', species: 'PONDEUSE' });
      layerId = await product({ ...animal, name: 'Poule pondeuse', species: 'PONDEUSE' });
      feedId = await product({ name: 'Aliment chair (sac)', family: 'INTRANT', unit: 'SAC' });
      vaccineId = await product({ name: 'Vaccin (flacon)', family: 'INTRANT', unit: 'FLACON' });
      litterId = await product({ name: 'Litière (balle)', family: 'INTRANT', unit: 'BALLE' });
      wholeId = await product({
        name: 'Poulet entier',
        family: 'PRODUCTION_COMMERCIALISABLE',
        unit: 'PIECE',
      });
      mediumId = await product({
        code: GRADE_MEDIUM,
        name: 'Œuf moyen',
        family: 'PRODUCTION_COMMERCIALISABLE',
        unit: 'OEUF',
        standardCost: 75,
      });
      // Calibres en vigueur avant l'ajout par l'administrateur (AT-053).
      await trx
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: 'production.egg_grade_product_codes',
          value: JSON.stringify([GRADE_MEDIUM]),
          scope_type: 'GLOBAL',
          valid_from: new Date(at('06:00:00')),
          is_client_visible: 1,
          reason: 'Test P7-13 (AT-053)',
          created_by: toBin(rootId),
        })
        .execute();

      const supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Couvoir et naisseur',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(rootId),
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
            fifoRankAt: new Date('2026-09-01T00:00:00.000Z'),
            createdBy: rootId,
          },
        );
      chickLot = await supplierLot(chickId, 'PC1');
      chickLot2 = await supplierLot(chickId, 'PC2');
      pigletLot = await supplierLot(pigletId, 'PGL');
      pulletLot = await supplierLot(pulletId, 'PUL');
      const opening = await virtualLocationId(trx, 'V_OPENING');
      for (const [productId, lotId, quantity, cost] of [
        [chickId, chickLot, 2400, 450],
        [chickId, chickLot2, 2000, 450],
        [pigletId, pigletLot, 40, 25_000],
        [pulletId, pulletLot, 300, 3_000],
        [feedId, undefined, 280, 15_000],
        [vaccineId, undefined, 36, 5_000],
        [litterId, undefined, 140, 1_000],
      ] as const) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            ...(lotId !== undefined ? { lotId } : {}),
            quantityBase: quantity,
            fromLocationId: opening,
            toLocationId: storeId,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: cost,
            occurredAt: new Date('2026-09-01T05:00:00.000Z'),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: freshUuid(),
            createdBy: rootId,
            allowNegative: false,
          },
        );
      }
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('AT-026 : lot de 2 400 poulets — effectif, mortalité 3,75 %, coût 5 600 000, coût par tête 2 424, sortie au coût restant', async () => {
    const lotId = await lotWithEntries(
      'POULET_CHAIR',
      broilerId,
      buildingId,
      at('06:00:00', '2026-09-15'),
      [{ productId: chickId, lotId: chickLot, quantity: 2400 }],
    );
    const consume = (productId: string, quantity: number, costType: string, day: string) =>
      ok(farmManager, 'production.input.record', 'CONSUMPTION', freshUuid(), at('09:00:00', day), {
        productionLotId: lotId,
        locationId: storeId,
        productId,
        quantityBase: quantity,
        unitCode: productId === feedId ? 'SAC' : productId === vaccineId ? 'FLACON' : 'BALLE',
        quantity,
        costType,
      });
    await consume(litterId, 140, 'AUTRE_INTRANT', '2026-09-15');
    await consume(feedId, 100, 'ALIMENT', '2026-09-20');
    await consume(vaccineId, 36, 'VETERINAIRE', '2026-09-25');
    await consume(feedId, 100, 'ALIMENT', '2026-10-05');
    await consume(feedId, 80, 'ALIMENT', '2026-10-20');

    // 90 morts en trois déclarations, sans validation ce jour-là (politique du test).
    await mortalityPolicy('2026-09-16', { requiresApproval: false, requiresPhoto: false });
    for (const [time, quantity] of [
      ['08:00:00', 40],
      ['12:00:00', 30],
      ['17:00:00', 20],
    ] as const) {
      await ok(
        farmManager,
        'production.mortality.record',
        'STOCK_LOSS',
        freshUuid(),
        at(time, '2026-09-16'),
        { productionLotId: lotId, quantity },
      );
    }

    const lot = (await getProductionLot(db, lotId))!;
    expect(lot.headcount).toEqual({ unsold: 2310, rearing: 2310 });
    expect(lot.mortality).toMatchObject({ countedQuantity: 90, pendingQuantity: 0 });
    expect(lot.indicators.mortalityRate).toBe(0.0375);
    const byType = Object.fromEntries(lot.costs.breakdown.map((l) => [l.costType, l.netXaf]));
    expect(byType).toMatchObject({
      ANIMAUX: 1_080_000,
      ALIMENT: 4_200_000,
      VETERINAIRE: 180_000,
      AUTRE_INTRANT: 140_000,
    });
    expect(lot.costs.netXaf).toBe(5_600_000);
    expect(lot.costs.remainingXaf).toBe(5_600_000);
    expect(lot.costs.costPerHeadXaf).toBe(2424);

    // Les 2 310 têtes sortent par abattage : la sortie emporte le coût restant exact.
    const slaughterId = freshUuid();
    await ok(
      farmManager,
      'production.slaughter.record',
      'SLAUGHTER',
      slaughterId,
      at('08:00:00', '2026-10-27'),
      {
        productionLotId: lotId,
        sourceLocationId: buildingId,
        slaughterhouseLocationId: houseId,
        heads: 2310,
        condemnedHeads: 0,
        liveWeightG: 4_620_000,
        outputs: [
          { productId: wholeId, toLocationId: storeId, quantityBase: 2310, weightG: 3_234_000 },
        ],
      },
    );
    const slaughter = await db
      .selectFrom('production_slaughter_batches')
      .select(['total_input_value_xaf', 'yield_rate'])
      .where('id', '=', toBin(slaughterId))
      .executeTakeFirstOrThrow();
    expect(Number(slaughter.total_input_value_xaf)).toBe(5_600_000);
    expect(Number(slaughter.yield_rate)).toBe(0.7);

    await ok(
      productionManager,
      'production.lot.close',
      'PRODUCTION_LOT',
      lotId,
      at('18:00:00', '2026-10-27'),
      {},
    );
    const closed = await db
      .selectFrom('production_production_lots')
      .select(['status', 'closing_summary'])
      .where('id', '=', toBin(lotId))
      .executeTakeFirstOrThrow();
    expect(closed.status).toBe('CLOSED');
    expect(closed.closing_summary).toMatchObject({
      initialQuantity: 2400,
      mortalityQuantity: 90,
      mortalityRate: 0.0375,
      costDebitXaf: 5_600_000,
      unrecoveredCostXaf: 0,
    });
  });

  it('AT-027 : 30 morts sur un lot de 2 000 → validation requise (seuils AV-048), têtes en attente', async () => {
    await mortalityPolicy(DAY, { requiresApproval: true, requiresPhoto: true });
    const lotId = await lotWithEntries('POULET_CHAIR', broilerId, buildingId, at('06:00:00'), [
      { productId: chickId, lotId: chickLot2, quantity: 2000 },
    ]);
    const lossId = freshUuid();
    const declared = await ok(
      farmManager,
      'production.mortality.record',
      'STOCK_LOSS',
      lossId,
      at('08:00:00'),
      { productionLotId: lotId, quantity: 30 },
    );
    expect(declared).toMatchObject({ server_refs: { status: 'PENDING_APPROVAL' } });
    const loss = await db
      .selectFrom('inventory_loss_declarations')
      .select(['status', 'requires_approval', 'requires_photo', 'approval_request_id'])
      .where('id', '=', toBin(lossId))
      .executeTakeFirstOrThrow();
    expect(loss).toMatchObject({
      status: 'PENDING_APPROVAL',
      requires_approval: 1,
      requires_photo: 1,
    });
    const request = await db
      .selectFrom('approvals_approval_requests')
      .select(['operation_type', 'status'])
      .where('id', '=', loss.approval_request_id!)
      .executeTakeFirstOrThrow();
    expect(request).toEqual({ operation_type: 'MORTALITY', status: 'PENDING' });

    const lot = (await getProductionLot(db, lotId))!;
    expect(lot.mortality).toMatchObject({ countedQuantity: 0, pendingQuantity: 30 });
    expect(lot.headcount.rearing).toBe(1970);
    // Clôture impossible tant que des têtes attendent la décision.
    expect(
      code(await run(productionManager, 'production.lot.close', 'PRODUCTION_LOT', lotId, NOW, {})),
    ).not.toMatch(/^APPLIED/);
  });

  it('AT-052 : 40 porcs sur 2 cases ; 5 têtes déplacées ; pesée ; effectif par case = solde, groupe inchangé', async () => {
    const lotId = await lotWithEntries('PORC_ENGRAISSEMENT', pigId, pen1, at('07:00:00'), [
      { productId: pigletId, lotId: pigletLot, quantity: 25, toLocationId: pen1 },
      { productId: pigletId, lotId: pigletLot, quantity: 15, toLocationId: pen2 },
    ]);
    const lot = (await getProductionLot(db, lotId))!;
    expect(lot.headcount.rearing).toBe(40);
    expect(await balanceAt(pen1, pigId, lot.stockLotId)).toBe(25);
    expect(await balanceAt(pen2, pigId, lot.stockLotId)).toBe(15);

    await ok(
      farmManager,
      'inventory.transfer.move_internal',
      'STOCK_TRANSFER',
      freshUuid(),
      at('09:00:00'),
      {
        fromLocationId: pen1,
        toLocationId: pen2,
        lines: [{ productId: pigId, unitCode: 'TETE', quantityBase: 5, lotId: lot.stockLotId }],
      },
    );
    expect(await balanceAt(pen1, pigId, lot.stockLotId)).toBe(20);
    expect(await balanceAt(pen2, pigId, lot.stockLotId)).toBe(20);
    expect(await lotHeadcount(db, { lotId: lot.stockLotId, scope: 'REARING' })).toBe(40);

    await ok(
      farmManager,
      'production.weighing.record',
      'LOT_WEIGHING',
      freshUuid(),
      at('10:00:00'),
      {
        productionLotId: lotId,
        locationId: pen2,
        sampleSize: 5,
        avgWeightG: 35_000,
      },
    );
    const after = (await getProductionLot(db, lotId))!;
    expect(after.headcount).toEqual({ unsold: 40, rearing: 40 });
    expect(after.weighings).toEqual([
      expect.objectContaining({ locationId: pen2, sampleSize: 5, avgWeightG: 35_000 }),
    ]);
    // Aucun identifiant individuel : la table des animaux n'existe pas (extension future).
    const animals = await db
      .selectFrom('information_schema.tables' as never)
      .select('table_name' as never)
      .where('table_schema' as never, '=', 'gic_agropelc_test' as never)
      .where('table_name' as never, '=', 'production_animals' as never)
      .execute();
    expect(animals).toEqual([]);
  });

  it('AT-053 : un calibre ajouté par l’administrateur est aussitôt utilisable ; collectes antérieures inchangées', async () => {
    const layerLot = await lotWithEntries('PONDEUSE', layerId, buildingId, at('06:30:00'), [
      { productId: pulletId, lotId: pulletLot, quantity: 300 },
    ]);
    const collect = (time: string, grades: readonly { productId: string; quantity: number }[]) => {
      const id = freshUuid();
      const collected = grades.reduce((sum, g) => sum + g.quantity, 0) + 5;
      return run(farmManager, 'production.egg_collection.record', 'EGG_COLLECTION', id, at(time), {
        productionLotId: layerLot,
        storageLocationId: storeId,
        collected,
        broken: 5,
        nonconforming: 0,
        hatching: 0,
        grades,
      }).then((result) => ({ id, result }));
    };
    const before = await collect('09:00:00', [{ productId: mediumId, quantity: 100 }]);
    expect(code(before.result)).toBe('APPLIED');

    // L'administrateur crée le produit « gros calibre » (s'il n'existe pas déjà, code stable)
    // puis l'ajoute au paramètre des calibres.
    const existing = await db
      .selectFrom('catalog_products')
      .select('id')
      .where('code', '=', GRADE_LARGE)
      .executeTakeFirst();
    let largeId = existing ? fromBin(existing.id) : freshUuid();
    // Avant l'ajout au paramètre, le calibre est refusé.
    if (existing) {
      const early = await collect('10:00:00', [{ productId: largeId, quantity: 50 }]);
      expect(code(early.result)).toBe('EGG_GRADE_INVALID');
    } else {
      await ok(admin, 'catalog.product.create', 'PRODUCT', largeId, at('11:00:00'), {
        code: GRADE_LARGE,
        name: 'Œuf gros calibre',
        categoryId,
        stockFamily: 'PRODUCTION_COMMERCIALISABLE',
        baseUnitCode: 'OEUF',
        lotTracking: 'REQUIRED',
        isSellable: true,
        isProducible: true,
      });
      largeId = fromBin(
        (
          await db
            .selectFrom('catalog_products')
            .select('id')
            .where('code', '=', GRADE_LARGE)
            .executeTakeFirstOrThrow()
        ).id,
      );
    }
    await ok(admin, 'organization.setting.set', 'SETTING', freshUuid(), at('12:00:00'), {
      key: 'production.egg_grade_product_codes',
      value: [GRADE_MEDIUM, GRADE_LARGE],
      scopeType: 'GLOBAL',
      isClientVisible: true,
      reason: 'Ajout du gros calibre (AT-053)',
    });

    const after = await collect('14:00:00', [
      { productId: mediumId, quantity: 60 },
      { productId: largeId, quantity: 40 },
    ]);
    expect(code(after.result)).toBe('APPLIED');
    // Même modèle de mouvement : une entrée PRODUCTION_OUTPUT par calibre, dans le lot de stock
    // propre de la collecte.
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select(['product_id', 'move_type', 'quantity'])
      .where('source_doc_type', '=', 'EGG_COLLECTION')
      .where('source_doc_id', '=', toBin(after.id))
      .execute();
    expect(
      moves.map((m) => [fromBin(m.product_id), m.move_type, Number(m.quantity)]).sort(),
    ).toEqual(
      [
        [largeId, 'PRODUCTION_OUTPUT', 40],
        [mediumId, 'PRODUCTION_OUTPUT', 60],
      ].sort(),
    );
    // La collecte antérieure est inchangée.
    const earlier = await db
      .selectFrom('production_egg_collections')
      .select(['status', 'version', 'marketable_qty'])
      .where('id', '=', toBin(before.id))
      .executeTakeFirstOrThrow();
    expect(earlier).toEqual({ status: 'RECORDED', version: 1, marketable_qty: 100 });
    const earlierLines = await db
      .selectFrom('production_egg_collection_lines')
      .select(['product_id', 'quantity'])
      .where('collection_id', '=', toBin(before.id))
      .execute();
    expect(earlierLines.map((l) => [fromBin(l.product_id), l.quantity])).toEqual([[mediumId, 100]]);
  });
});

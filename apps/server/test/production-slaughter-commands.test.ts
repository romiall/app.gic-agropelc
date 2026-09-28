/**
 * P7-09 — abattage, à travers le vrai pipeline (AV-032, AV-100, AV-101, AV-102) :
 * - 60 poulets (dont 2 saisis) à 2 000 XAF la tête → poulet entier (pièces), cuisses et abats
 *   (kilo) ; valeur de 120 000 XAF répartie au prorata du poids, au franc près ; rendement ;
 *   lot de stock propre `TRANSFORMATION` avec péremption (AV-125) ; coût restant du lot ;
 * - le dernier abattage emporte le coût restant exact, puis le lot se clôture sans coût perdu ;
 * - refus : type de lot, abattoir, bilan de poids, produit, portée ;
 * - annulation par le Responsable production ; produits sortis → `STOCK_UNAVAILABLE`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerSlaughterCommands } from '../src/modules/production/application/commands/slaughter-commands.js';
import {
  costObjectBalance,
  ensureSupplierLot,
  lotHeadcount,
  recordCostEntry,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const DAY = '2026-10-24';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-09 : abattage', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let farmManager: Actor;
  let otherFarmManager: Actor;
  let productionManager: Actor;
  let buildingId: string;
  let houseId: string;
  let coldStoreId: string;
  let chickId: string;
  let broilerId: string;
  let layerId: string;
  let wholeId: string;
  let thighId: string;
  let offalId: string;
  let chickLotId: string;
  let lotId: string;
  let layerLotId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
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

  const slaughterPayload = (extra: Record<string, unknown> = {}) => ({
    productionLotId: lotId,
    sourceLocationId: buildingId,
    slaughterhouseLocationId: houseId,
    heads: 60,
    condemnedHeads: 2,
    liveWeightG: 150_000,
    outputs: [
      { productId: wholeId, toLocationId: coldStoreId, quantityBase: 50, weightG: 90_000 },
      { productId: thighId, toLocationId: coldStoreId, quantityBase: 12, weightG: 12_000 },
      { productId: offalId, toLocationId: coldStoreId, quantityBase: 6, weightG: 6_000 },
    ],
    ...extra,
  });

  async function slaughter(
    payload: unknown,
    actor: Actor = farmManager,
    time = at('09:00:00'),
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(actor, 'production.slaughter.record', 'SLAUGHTER', id, time, payload);
    return { id, result };
  }

  const lotNet = async (id: string) =>
    (await costObjectBalance(db, { costObjectType: 'PRODUCTION_LOT', costObjectId: id })).netXaf;

  async function heads(id: string): Promise<number> {
    const lot = await db
      .selectFrom('production_production_lots')
      .select('stock_lot_id')
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    return lotHeadcount(db, { lotId: fromBin(lot.stock_lot_id), scope: 'UNSOLD' });
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
    const sequences = new DocumentSequenceService();
    registerLotCommands(registry, idGenerator, sequences);
    registerSlaughterCommands(registry, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      const farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const otherFarmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      houseId = await insertTestLocation(trx, adminId, farmId, { locationType: 'SLAUGHTERHOUSE' });
      coldStoreId = await insertTestLocation(trx, adminId, farmId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      otherFarmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: otherFarmId });
      productionManager = await actor(roles.rpr);

      for (const [unit, name, isCount] of [
        ['TETE', 'Tête', 1],
        ['PIECE', 'Pièce', 1],
        ['KG', 'Kilogramme', 0],
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
          name: 'Abattage',
          created_by: toBin(adminId),
        })
        .execute();
      const product = async (
        name: string,
        family: string,
        unit: string,
        species: string | null = null,
      ): Promise<string> => {
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `P-${id.slice(-10)}`,
            name,
            category_id: toBin(categoryId),
            stock_family: family,
            species,
            base_unit_code: unit,
            lot_tracking: 'REQUIRED',
            created_by: toBin(adminId),
          })
          .execute();
        return id;
      };
      chickId = await product('Poussin', 'BIOLOGIQUE', 'TETE', 'POULET_CHAIR');
      broilerId = await product('Poulet de chair vif', 'BIOLOGIQUE', 'TETE', 'POULET_CHAIR');
      layerId = await product('Poule pondeuse', 'BIOLOGIQUE', 'TETE', 'PONDEUSE');
      wholeId = await product('Poulet entier', 'PRODUCTION_COMMERCIALISABLE', 'PIECE');
      thighId = await product('Cuisses de poulet', 'PRODUCTION_COMMERCIALISABLE', 'KG');
      offalId = await product('Abats de poulet', 'PRODUCTION_COMMERCIALISABLE', 'KG');
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
      chickLotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId: chickId,
          supplierId,
          supplierLotRef: `PC-${supplierId.slice(-6)}`,
          fallbackCode: `F:PC-${supplierId.slice(-6)}`,
          expiryDate: null,
          originId: freshUuid(),
          fifoRankAt: new Date(at('05:00:00')),
          createdBy: adminId,
        },
      );
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: chickId,
          lotId: chickLotId,
          quantityBase: 100,
          fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
          toLocationId: coldStoreId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 500,
          occurredAt: new Date(at('05:00:00')),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: adminId,
          allowNegative: false,
        },
      );
    });

    lotId = freshUuid();
    layerLotId = freshUuid();
    for (const [id, lotType, productId] of [
      [lotId, 'POULET_CHAIR', broilerId],
      [layerLotId, 'PONDEUSE', layerId],
    ] as const) {
      const created = await run(
        productionManager,
        'production.lot.create',
        'PRODUCTION_LOT',
        id,
        at('06:00:00'),
        { lotType, productId, mainLocationId: buildingId },
      );
      expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    }
    const placed = await run(
      farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      at('06:30:00'),
      {
        productionLotId: lotId,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: chickId,
        sourceLocationId: coldStoreId,
        sourceStockLotId: chickLotId,
        quantity: 100,
      },
    );
    expect(placed.status, JSON.stringify(placed)).toBe('APPLIED');
    // Aliment et autres coûts : 150 000 XAF, soit 200 000 XAF pour 100 têtes.
    await db.transaction().execute(async (trx) => {
      await recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: lotId,
          costType: 'ALIMENT',
          amountXaf: 150_000,
          direction: 'DEBIT',
          sourceType: 'MANUAL',
          sourceId: freshUuid(),
          occurredAt: new Date(at('07:00:00')),
          createdBy: productionManager.userId,
        },
      );
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('transformation : valeur répartie au poids au franc près, rendement, lot propre avec péremption', async () => {
    expect(await lotNet(lotId)).toBe(200_000);
    const { id, result } = await slaughter(slaughterPayload());
    expect(result).toMatchObject({
      status: 'APPLIED',
      server_refs: { docNumber: expect.stringMatching(/^ABT-.+-2026-\d{6}$/) },
    });
    const row = await db
      .selectFrom('production_slaughter_batches')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      heads_qty: 60,
      condemned_heads: 2,
      live_weight_g: 150_000,
      output_weight_g: 108_000,
      total_input_value_xaf: 120_000,
      yield_rate: '0.7200',
      status: 'RECORDED',
    });
    const outputs = await db
      .selectFrom('production_slaughter_outputs')
      .select(['product_id', 'allocated_value_xaf', 'unit_cost_xaf'])
      .where('slaughter_id', '=', toBin(id))
      .execute();
    const byProduct = new Map(
      outputs.map((o) => [fromBin(o.product_id), [o.allocated_value_xaf, o.unit_cost_xaf]]),
    );
    expect(byProduct.get(wholeId)).toEqual([100_000, 2_000]);
    expect(byProduct.get(thighId)).toEqual([13_333, 1_111]);
    expect(byProduct.get(offalId)).toEqual([6_667, 1_111]);
    const stockLot = await db
      .selectFrom('inventory_stock_lots')
      .select(['origin_type', 'lot_code', 'expiry_date', 'product_id'])
      .where('id', '=', row.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(stockLot).toMatchObject({
      origin_type: 'TRANSFORMATION',
      lot_code: row.doc_number,
      product_id: null,
    });
    const expiry = stockLot.expiry_date!;
    expect(
      `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`,
    ).toBe('2026-10-29');
    // Le lot garde 40 têtes et 80 000 XAF de coût restant.
    expect(await heads(lotId)).toBe(40);
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select(['move_type', 'value_xaf'])
      .where('source_doc_type', '=', 'SLAUGHTER')
      .where('source_doc_id', '=', toBin(id))
      .execute();
    expect(
      moves
        .filter((m) => m.move_type === 'PRODUCTION_OUTPUT')
        .reduce((s, m) => s + Number(m.value_xaf), 0),
    ).toBe(120_000);
  });

  it('refus : type de lot, abattoir, bilan de poids, produit, portée', async () => {
    expect(code((await slaughter(slaughterPayload({ productionLotId: layerLotId }))).result)).toBe(
      'LOT_NOT_SLAUGHTERABLE',
    );
    expect(
      code((await slaughter(slaughterPayload({ slaughterhouseLocationId: buildingId }))).result),
    ).toBe('LOCATION_INVALID');
    expect(code((await slaughter(slaughterPayload({ liveWeightG: 100_000 }))).result)).toBe(
      'SLAUGHTER_INVALID',
    );
    expect(
      code(
        (
          await slaughter(
            slaughterPayload({
              outputs: [
                { productId: chickId, toLocationId: coldStoreId, quantityBase: 5, weightG: 5_000 },
              ],
            }),
          )
        ).result,
      ),
    ).toBe('OUTPUT_PRODUCT_INVALID');
    expect(code((await slaughter(slaughterPayload(), otherFarmManager)).result)).toBe(
      'FORBIDDEN_SCOPE',
    );
  });

  it('annulation par le Responsable production ; produits sortis → STOCK_UNAVAILABLE ; dernier abattage et clôture', async () => {
    const small = slaughterPayload({
      heads: 10,
      condemnedHeads: 0,
      liveWeightG: 25_000,
      outputs: [
        { productId: wholeId, toLocationId: coldStoreId, quantityBase: 10, weightG: 18_000 },
      ],
    });
    const cancelled = await slaughter(small, farmManager, at('10:00:00'));
    expect(cancelled.result.status).toBe('APPLIED');
    const cancel = (id: string, actor: Actor = productionManager) =>
      run(actor, 'production.slaughter.cancel', 'SLAUGHTER', id, at('11:00:00'), {
        comment: 'Mauvais lot',
      });
    expect(code(await cancel(cancelled.id, farmManager))).toBe('FORBIDDEN');
    expect(code(await cancel(cancelled.id))).toBe('APPLIED');
    expect(await heads(lotId)).toBe(40);
    expect(await lotNet(lotId)).toBe(200_000);
    const closedLot = await db
      .selectFrom('production_slaughter_batches as s')
      .innerJoin('inventory_stock_lots as l', 'l.id', 's.stock_lot_id')
      .select(['s.status', 'l.status as lot_status'])
      .where('s.id', '=', toBin(cancelled.id))
      .executeTakeFirstOrThrow();
    expect(closedLot).toEqual({ status: 'CANCELLED', lot_status: 'CLOSED' });

    // Dernier abattage : les 40 têtes emportent les 80 000 XAF restants.
    const last = await slaughter(
      slaughterPayload({
        heads: 40,
        condemnedHeads: 0,
        liveWeightG: 100_000,
        outputs: [
          { productId: wholeId, toLocationId: coldStoreId, quantityBase: 40, weightG: 72_000 },
        ],
      }),
      farmManager,
      at('12:00:00'),
    );
    expect(last.result.status).toBe('APPLIED');
    const lastRow = await db
      .selectFrom('production_slaughter_batches')
      .select(['total_input_value_xaf', 'stock_lot_id'])
      .where('id', '=', toBin(last.id))
      .executeTakeFirstOrThrow();
    expect(lastRow.total_input_value_xaf).toBe(80_000);
    expect(await heads(lotId)).toBe(0);

    // Une pièce vendue : l'annulation du dernier abattage est refusée.
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: wholeId,
          lotId: fromBin(lastRow.stock_lot_id),
          quantityBase: 1,
          fromLocationId: coldStoreId,
          toLocationId: await virtualLocationId(trx, 'V_LOSS'),
          moveType: 'LOSS',
          occurredAt: new Date(at('13:00:00')),
          sourceDocType: 'LOSS',
          sourceDocId: freshUuid(),
          createdBy: farmManager.userId,
          allowNegative: false,
        },
      );
    });
    expect(code(await cancel(last.id))).toBe('STOCK_UNAVAILABLE');

    const close = await run(
      productionManager,
      'production.lot.close',
      'PRODUCTION_LOT',
      lotId,
      at('18:00:00'),
      {},
    );
    expect(close.status, JSON.stringify(close)).toBe('APPLIED');
    const summary = await db
      .selectFrom('production_production_lots')
      .select('closing_summary')
      .where('id', '=', toBin(lotId))
      .executeTakeFirstOrThrow();
    expect(summary.closing_summary).toMatchObject({ costNetXaf: 200_000, unrecoveredCostXaf: 0 });
  });
});

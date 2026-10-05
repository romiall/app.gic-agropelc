/**
 * P7-05 — lots de production, à travers le vrai pipeline :
 * - création (BR-PRD-001, BR-PRD-002) : numéro `LOT-…`, lot de traçabilité, contrôles de produit,
 *   d'emplacement, de lot lié et de portée ;
 * - mise en place depuis le stock d'un lot d'incubation (coût par tête, dernière sortie qui emporte
 *   le coût restant, ADR-027) et depuis une réception d'achat du même lot de commandes (AV-112) ;
 * - naissance au coût standard avec crédit du lot de truies (AV-098, AV-111), sevrage au coût
 *   restant (AV-097) ;
 * - statut (SM-PRODUCTION-LOT), annulation d'un lot planifié, entrée hors ligne sur un lot annulé
 *   (`LOT_CLOSED`), annulation d'entrée (contre-passation, `STOCK_UNAVAILABLE`, AV-120), clôture
 *   (`LOT_NOT_EMPTY`, `LOT_HAS_PENDING_LOSS`, résumé figé, INV-PRD-02).
 * - revue P7 : inverse à la valeur exacte d'origine, lot d'origine clos (`SOURCE_LOT_NOT_ACTIVE`),
 *   seconde mise en place depuis la même réception, animaux d'un lot refusés en mise en place,
 *   entrée hors ligne sur un lot clos annulable, emplacement désactivé accepté hors ligne, date
 *   de démarrage la plus ancienne, rejeu d'une création.
 *
 * Politiques de test bornées à la journée de test (`validTo`), pour ne pas peser sur les autres
 * jeux de tests de la base partagée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerReceiptCommands } from '../src/modules/procurement/application/commands/receipt-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import {
  biologicalLotRemainingCostXaf,
  costObjectBalance,
  createStockLot,
  deliverSoldGoods,
  ensureSupplierLot,
  findStockLot,
  lotHeadcount,
  recordCostEntry,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { ensureToDeliverLocation } from '../src/modules/organization/application/public/index.js';
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

const DAY = '2026-10-20';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-05 : lots de production', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let farmManager: Actor;
  let otherFarmManager: Actor;
  let productionManager: Actor;
  let farmId: string;
  let buildingId: string;
  let penId: string;
  let farmStoreId: string;
  let hatcherId: string;
  let sparePenId: string;
  let supplierId: string;
  const products = {
    chick: '',
    boughtChick: '',
    broiler: '',
    layer: '',
    sow: '',
    piglet: '',
    pig: '',
  };
  let incubationStockLotId: string;
  let sowSupplierLotId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly attachmentIds?: readonly string[]; readonly offline?: boolean } = {},
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
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [...(options.attachmentIds ?? [])],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
  }

  async function createLot(
    lotType: string,
    productId: string,
    extra: Record<string, unknown> = {},
    actor: Actor = productionManager,
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(actor, 'production.lot.create', 'PRODUCTION_LOT', id, at('06:00:00'), {
      lotType,
      productId,
      mainLocationId: buildingId,
      ...extra,
    });
    return { id, result };
  }

  async function entry(
    lotId: string,
    payload: Record<string, unknown>,
    occurredAt: string,
    options: { readonly actor?: Actor; readonly offline?: boolean } = {},
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(
      options.actor ?? farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      id,
      occurredAt,
      { productionLotId: lotId, ...payload },
      { offline: options.offline ?? false },
    );
    return { id, result };
  }

  async function lotRow(lotId: string) {
    return db
      .selectFrom('production_production_lots')
      .selectAll()
      .where('id', '=', toBin(lotId))
      .executeTakeFirstOrThrow();
  }

  async function entryRow(entryId: string) {
    return db
      .selectFrom('production_lot_entries')
      .selectAll()
      .where('id', '=', toBin(entryId))
      .executeTakeFirstOrThrow();
  }

  async function lotCost(lotId: string) {
    return costObjectBalance(db, { costObjectType: 'PRODUCTION_LOT', costObjectId: lotId });
  }

  async function remainingCost(lotId: string): Promise<number | null> {
    const lot = await lotRow(lotId);
    return db
      .transaction()
      .execute((trx) => biologicalLotRemainingCostXaf(trx, fromBin(lot.stock_lot_id)));
  }

  const ymd = (value: Date | null) =>
    value === null
      ? null
      : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

  async function heads(lotId: string, scope: 'REARING' | 'UNSOLD' = 'UNSOLD') {
    const lot = await lotRow(lotId);
    return lotHeadcount(db, { lotId: fromBin(lot.stock_lot_id), scope });
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
    registerLotCommands(registry, idGenerator, sequences);
    registerReceiptCommands(registry, decisions, idGenerator, sequences);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const otherFarmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      penId = await insertTestLocation(trx, adminId, farmId, {
        locationType: 'PEN',
        parentLocationId: buildingId,
      });
      farmStoreId = await insertTestLocation(trx, adminId, farmId);
      hatcherId = await insertTestLocation(trx, adminId, farmId, { locationType: 'HATCHER' });
      sparePenId = await insertTestLocation(trx, adminId, farmId, {
        locationType: 'PEN',
        parentLocationId: buildingId,
      });
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      otherFarmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: otherFarmId });
      productionManager = await actor(roles.rpr);

      if (
        !(await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', 'TETE')
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'TETE', name: 'Tête', is_count: 1 })
          .execute();
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
      const definitions = [
        ['chick', 'Poussin d’un jour (chair)', 'POULET_CHAIR'],
        ['boughtChick', 'Poussin d’un jour acheté', 'POULET_CHAIR'],
        ['broiler', 'Poulet de chair vif', 'POULET_CHAIR'],
        ['layer', 'Poule pondeuse', 'PONDEUSE'],
        ['sow', 'Truie', 'PORC'],
        ['piglet', 'Porcelet', 'PORC'],
        ['pig', 'Porc charcutier', 'PORC'],
      ] as const;
      for (const [key, name, species] of definitions) {
        const id = freshUuid();
        products[key] = id;
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `PRD-${id.slice(-8)}`,
            name,
            category_id: toBin(categoryId),
            stock_family: 'BIOLOGIQUE',
            species,
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
            is_purchasable: 1,
            created_by: toBin(adminId),
          })
          .execute();
      }
      await trx
        .insertInto('catalog_product_standard_costs')
        .values({
          id: toBin(freshUuid()),
          product_id: toBin(products.piglet),
          unit_cost_xaf: 15_000,
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          created_by: toBin(adminId),
        })
        .execute();
      supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Couvoir du Moungo',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();

      // Lot d'incubation (référence) : 400 000 XAF d'œufs engagés, 1 000 poussins à l'éclosoir.
      const batchId = freshUuid();
      incubationStockLotId = await createStockLot(
        trx,
        { idGenerator },
        {
          originType: 'INCUBATION_BATCH',
          originId: batchId,
          lotCode: `INC-${batchId.slice(-12)}`,
          productId: products.chick,
          fifoRankAt: new Date(at('05:00:00')),
          expiryDate: null,
          createdBy: adminId,
        },
      );
      await recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'INCUBATION_BATCH',
          costObjectId: batchId,
          costType: 'OEUFS',
          amountXaf: 400_000,
          direction: 'DEBIT',
          sourceType: 'PRODUCTION',
          sourceId: freshUuid(),
          occurredAt: new Date(at('05:00:00')),
          createdBy: adminId,
        },
      );
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: products.chick,
          lotId: incubationStockLotId,
          quantityBase: 1000,
          fromLocationId: await virtualLocationId(trx, 'V_PRODUCTION'),
          toLocationId: hatcherId,
          moveType: 'PRODUCTION_OUTPUT',
          declaredValueXaf: 400_000,
          occurredAt: new Date(at('05:00:00')),
          sourceDocType: 'INCUBATION_EVENT',
          sourceDocId: batchId,
          createdBy: adminId,
          allowNegative: false,
        },
      );
      // Dix truies en stock au magasin de la ferme, 200 000 XAF la tête.
      sowSupplierLotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId: products.sow,
          supplierId,
          supplierLotRef: `TR-${supplierId.slice(-6)}`,
          fallbackCode: `F:TR-${supplierId.slice(-6)}`,
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
          productId: products.sow,
          lotId: sowSupplierLotId,
          quantityBase: 10,
          fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
          toLocationId: farmStoreId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 200_000,
          occurredAt: new Date(at('05:00:00')),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: adminId,
          allowNegative: false,
        },
      );
      // Deux cents poussins achetés en stock au magasin (450 XAF), propres à ce fichier : aucun
      // test ne dépend du stock créé par un autre (revue P7).
      const boughtLotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId: products.boughtChick,
          supplierId,
          supplierLotRef: `PA-${supplierId.slice(-6)}`,
          fallbackCode: `F:PA-${supplierId.slice(-6)}`,
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
          productId: products.boughtChick,
          lotId: boughtLotId,
          quantityBase: 200,
          fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
          toLocationId: farmStoreId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 450,
          occurredAt: new Date(at('05:00:00')),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: adminId,
          allowNegative: false,
        },
      );
    });

    for (const [operationType, approverPermission, requiresPhoto, condition] of [
      ['RECEIPT_WITHOUT_PO', 'procurement.receipt_exception.approve', false, {}],
      ['MORTALITY', 'production.mortality.approve', true, { relativePct: 0, absoluteHeads: 0 }],
    ] as const) {
      const policyId = freshUuid();
      const policy = await run(
        admin,
        'approvals.policy.set',
        'CONTROL_POLICY',
        policyId,
        at('00:00:00'),
        {
          code: `${operationType}_${policyId.slice(-8)}`,
          operationType,
          validFrom: at('00:00:00'),
          validTo: at('23:59:59'),
          requiresApproval: true,
          requiresPhoto,
          approverPermission,
          approverScope: 'ALL',
          condition,
        },
      );
      expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('création : numéro LOT, lot de traçabilité, contrôles de produit, d’emplacement, de lien et de portée', async () => {
    expect(code((await createLot('POULET_CHAIR', products.broiler, {}, farmManager)).result)).toBe(
      'FORBIDDEN',
    );
    expect(code((await createLot('POULET_CHAIR', products.layer)).result)).toBe('PRODUCT_INVALID');
    expect(
      code(
        (await createLot('POULET_CHAIR', products.broiler, { mainLocationId: farmStoreId })).result,
      ),
    ).toBe('LOCATION_INVALID');
    const sows = await createLot('PORC_NAISSAGE', products.sow);
    expect(code(sows.result)).toBe('APPLIED');
    expect(
      code((await createLot('POULET_CHAIR', products.broiler, { parentLotId: sows.id })).result),
    ).toBe('PARENT_LOT_INVALID');

    const created = await createLot('POULET_CHAIR', products.broiler, {
      supplierId,
      strain: 'Cobb 500',
      plannedStartDate: DAY,
      plannedEndDate: '2026-11-30',
    });
    expect(created.result).toMatchObject({
      status: 'APPLIED',
      server_refs: { lotCode: expect.stringMatching(/^LOT-.+-2026-\d{6}$/) },
    });
    const lot = await lotRow(created.id);
    expect(lot).toMatchObject({
      status: 'PLANNED',
      lot_type: 'POULET_CHAIR',
      initial_quantity: null,
    });
    const stockLot = await db
      .selectFrom('inventory_stock_lots')
      .selectAll()
      .where('id', '=', lot.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(stockLot).toMatchObject({
      origin_type: 'PRODUCTION_LOT',
      lot_code: lot.lot_code,
      status: 'OPEN',
    });
    expect(fromBin(stockLot.origin_id!)).toBe(created.id);
    // Rejeu (même agrégat, nouvelle commande) : même numéro, aucun second lot.
    const replayed = await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      created.id,
      at('06:00:00'),
      { lotType: 'POULET_CHAIR', productId: products.broiler, mainLocationId: buildingId },
    );
    expect(replayed).toMatchObject({ status: 'APPLIED', server_refs: { lotCode: lot.lot_code } });
    const feed = await db
      .selectFrom('sync_change_feed')
      .select(['dataset', 'scope_type', 'change_type'])
      .where('entity_type', '=', 'PRODUCTION_LOT')
      .where('entity_id', '=', toBin(created.id))
      .execute();
    expect(feed).toContainEqual({
      dataset: 'production',
      scope_type: 'SITE',
      change_type: 'UPSERT',
    });
  });

  it('mise en place depuis un lot d’incubation : coût par tête, dernière sortie au coût restant exact (ADR-027)', async () => {
    const { id: lotId } = await createLot('POULET_CHAIR', products.broiler);
    const source = {
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: products.chick,
      sourceLocationId: hatcherId,
    };
    expect(
      code(
        (
          await entry(lotId, { ...source, quantity: 600 }, at('07:00:00'), {
            actor: otherFarmManager,
          })
        ).result,
      ),
    ).toBe('FORBIDDEN_SCOPE');
    const first = await entry(
      lotId,
      { ...source, sourceStockLotId: incubationStockLotId, quantity: 600, avgWeightG: 40 },
      at('07:00:00'),
    );
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    expect(await entryRow(first.id)).toMatchObject({
      entry_type: 'PLACEMENT',
      source_kind: 'INTERNAL_STOCK',
      value_xaf: 240_000,
      unit_cost_xaf: 400,
    });
    const lot = await lotRow(lotId);
    expect(lot.status).toBe('ACTIVE');
    expect(Number(lot.initial_quantity)).toBe(600);
    expect(await heads(lotId, 'REARING')).toBe(600);
    expect((await lotCost(lotId)).netXaf).toBe(240_000);

    // Seconde mise en place (FIFO) : les 400 derniers poussins emportent les 160 000 XAF restants.
    const second = await entry(lotId, { ...source, quantity: 400 }, at('07:30:00'));
    expect(second.result.status, JSON.stringify(second.result)).toBe('APPLIED');
    expect((await entryRow(second.id)).value_xaf).toBe(160_000);
    expect((await lotCost(lotId)).netXaf).toBe(400_000);
    expect(Number((await lotRow(lotId)).initial_quantity)).toBe(1000);
    // En ligne, plus aucun poussin : lot désigné épuisé, ou aucun lot en solde pour le FIFO.
    expect(
      code(
        (
          await entry(
            lotId,
            { ...source, sourceStockLotId: incubationStockLotId, quantity: 10 },
            at('07:45:00'),
          )
        ).result,
      ),
    ).toBe('INSUFFICIENT_STOCK');
    expect(code((await entry(lotId, { ...source, quantity: 10 }, at('07:45:00'))).result)).toBe(
      'INSUFFICIENT_STOCK',
    );
    expect(
      code(
        (
          await entry(
            lotId,
            { ...source, sourceProductId: products.sow, quantity: 1 },
            at('07:45:00'),
          )
        ).result,
      ),
    ).toBe('SOURCE_PRODUCT_INVALID');
    // Les animaux d'un lot de production n'entrent pas par une mise en place (revue P7) : ni par
    // le lot désigné, ni par le FIFO de l'emplacement (qui prendrait le lot lui-même).
    const own = {
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: products.broiler,
      sourceLocationId: buildingId,
    };
    expect(
      code(
        (
          await entry(
            lotId,
            { ...own, sourceStockLotId: fromBin(lot.stock_lot_id), quantity: 10 },
            at('07:50:00'),
          )
        ).result,
      ),
    ).toBe('LOT_ENTRY_INVALID');
    expect(code((await entry(lotId, { ...own, quantity: 10 }, at('07:50:00'))).result)).toBe(
      'LOT_ENTRY_INVALID',
    );
    expect(await heads(lotId)).toBe(1000);

    // Statut : en vente, puis retour en élevage.
    const status = (s: string) =>
      run(productionManager, 'production.lot.set_status', 'PRODUCTION_LOT', lotId, at('08:00:00'), {
        status: s,
      });
    // BR-PRD-010 : l'état « en vente » est porté par le lot de stock, lu par `sales`.
    const sellable = async () =>
      (await findStockLot(db, fromBin((await lotRow(lotId)).stock_lot_id)))?.sellableFromRearing;
    expect(await sellable()).toBe(false);
    expect(code(await status('SELLING'))).toBe('APPLIED');
    expect((await lotRow(lotId)).status).toBe('SELLING');
    expect(await sellable()).toBe(true);
    expect(code(await status('ACTIVE'))).toBe('APPLIED');
    expect(await sellable()).toBe(false);
    const planned = await createLot('POULET_CHAIR', products.broiler);
    expect(
      code(
        await run(
          productionManager,
          'production.lot.set_status',
          'PRODUCTION_LOT',
          planned.id,
          at('08:00:00'),
          {
            status: 'SELLING',
          },
        ),
      ),
    ).toBe('LOT_STATUS_INVALID');
  });

  it('AV-112 : réception et mise en place dans le même lot de commandes ; têtes restantes par lot fournisseur ; annulation', async () => {
    const lotA = (await createLot('POULET_CHAIR', products.broiler)).id;
    const lotB = (await createLot('POULET_CHAIR', products.broiler)).id;
    const receiptId = freshUuid();
    const line = (quantity: number, ref: string) => ({
      productId: products.boughtChick,
      unitCode: 'TETE',
      qtyDeliveredBase: quantity,
      unitCostXaf: 450,
      supplierLotRef: `${ref}-${receiptId.slice(-6)}`,
    });
    const receipt = await run(
      farmManager,
      'procurement.receipt.record',
      'GOODS_RECEIPT',
      receiptId,
      at('09:00:00'),
      { supplierId, locationId: farmStoreId, lines: [line(200, 'PX'), line(100, 'PY')] },
      { attachmentIds: [freshUuid()] },
    );
    expect(receipt.status, JSON.stringify(receipt)).toBe('APPLIED');
    const purchase = {
      sourceKind: 'PURCHASE',
      goodsReceiptId: receiptId,
      sourceProductId: products.boughtChick,
    };
    expect(code((await entry(lotA, { ...purchase, quantity: 301 }, at('09:05:00'))).result)).toBe(
      'PLACEMENT_EXCEEDS_RECEIPT',
    );
    const placedA = await entry(lotA, { ...purchase, quantity: 150 }, at('09:05:00'));
    expect(placedA.result.status, JSON.stringify(placedA.result)).toBe('APPLIED');
    const rowA = await entryRow(placedA.id);
    expect(rowA).toMatchObject({ source_kind: 'PURCHASE', value_xaf: 67_500, unit_cost_xaf: 450 });
    expect(fromBin(rowA.goods_receipt_id!)).toBe(receiptId);
    expect(rowA.source_stock_lot_id).not.toBeNull();

    // Seconde mise en place depuis la même réception (revue P7) : les portions suivent le solde
    // réel de chaque lot fournisseur, quel que soit l'ordre des lignes.
    const placedB = await entry(lotB, { ...purchase, quantity: 120 }, at('09:10:00'));
    expect(placedB.result.status, JSON.stringify(placedB.result)).toBe('APPLIED');
    const inputsB = await db
      .selectFrom('inventory_stock_moves')
      .select(['quantity', 'value_xaf'])
      .where('source_doc_type', '=', 'LOT_ENTRY')
      .where('source_doc_id', '=', toBin(placedB.id))
      .where('move_type', '=', 'PRODUCTION_INPUT')
      .execute();
    expect(inputsB.reduce((sum, move) => sum + Number(move.quantity), 0)).toBe(120);
    expect(inputsB.reduce((sum, move) => sum + Number(move.value_xaf), 0)).toBe(54_000);
    expect(code((await entry(lotB, { ...purchase, quantity: 31 }, at('09:15:00'))).result)).toBe(
      'PLACEMENT_EXCEEDS_RECEIPT',
    );
    expect(await heads(lotA)).toBe(150);
    expect((await lotCost(lotA)).netXaf).toBe(67_500);

    // Annulation (Responsable production seul, AV-123) : têtes rendues, coût contrepassé.
    const cancelEntry = (entryId: string, actor: Actor = productionManager) =>
      run(actor, 'production.lot.cancel_entry', 'LOT_ENTRY', entryId, at('10:00:00'), {
        comment: 'Erreur de saisie',
      });
    expect(code(await cancelEntry(placedA.id, farmManager))).toBe('FORBIDDEN');
    expect(code(await cancelEntry(placedA.id))).toBe('APPLIED');
    expect((await entryRow(placedA.id)).status).toBe('CANCELLED');
    expect(await heads(lotA)).toBe(0);
    expect(await lotCost(lotA)).toMatchObject({
      debitXaf: 67_500,
      creditXaf: 67_500,
      netXaf: 0,
    });
    expect(Number((await lotRow(lotA)).initial_quantity)).toBe(0);
    expect(code(await cancelEntry(placedA.id))).toBe('APPLIED');
  });

  it('AV-111 : naissances au coût standard (crédit du lot de truies), sevrage au coût restant exact ; annulations', async () => {
    const cancel = (entryId: string, time: string) =>
      run(productionManager, 'production.lot.cancel_entry', 'LOT_ENTRY', entryId, at(time), {
        comment: 'Correction',
      });
    const sows = await createLot('PORC_NAISSAGE', products.sow);
    const sowsIn = await entry(
      sows.id,
      {
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: products.sow,
        sourceLocationId: farmStoreId,
        sourceStockLotId: sowSupplierLotId,
        quantity: 10,
        toLocationId: penId,
      },
      at('11:00:00'),
    );
    expect(sowsIn.result.status, JSON.stringify(sowsIn.result)).toBe('APPLIED');
    expect((await lotCost(sows.id)).netXaf).toBe(2_000_000);

    const orphan = await createLot('PORC_NAISSAGE', products.piglet);
    expect(
      code(
        (
          await entry(
            orphan.id,
            { sourceKind: 'BIRTH', quantity: 5, toLocationId: penId },
            at('11:30:00'),
          )
        ).result,
      ),
    ).toBe('LOT_ENTRY_INVALID');

    const piglets = await createLot('PORC_NAISSAGE', products.piglet, { parentLotId: sows.id });
    const birth = await entry(
      piglets.id,
      { sourceKind: 'BIRTH', quantity: 45, stillbornQty: 3, toLocationId: penId },
      at('12:00:00'),
    );
    expect(birth.result.status, JSON.stringify(birth.result)).toBe('APPLIED');
    expect(await entryRow(birth.id)).toMatchObject({
      entry_type: 'BIRTH',
      stillborn_qty: 3,
      value_xaf: 675_000,
      unit_cost_xaf: 15_000,
    });
    expect(fromBin((await entryRow(birth.id)).source_production_lot_id!)).toBe(sows.id);
    expect(await lotCost(sows.id)).toMatchObject({ creditXaf: 675_000, netXaf: 1_325_000 });

    // Seconde portée annulée aussitôt : le crédit du lot de truies est contrepassé (revue P7).
    const litter = await entry(
      piglets.id,
      { sourceKind: 'BIRTH', quantity: 5, toLocationId: penId },
      at('12:10:00'),
    );
    expect(litter.result.status, JSON.stringify(litter.result)).toBe('APPLIED');
    expect((await lotCost(sows.id)).netXaf).toBe(1_250_000);
    expect(code(await cancel(litter.id, '12:15:00'))).toBe('APPLIED');
    expect(await lotCost(sows.id)).toMatchObject({
      debitXaf: 2_075_000,
      creditXaf: 750_000,
      netXaf: 1_325_000,
    });
    expect(await heads(piglets.id, 'REARING')).toBe(45);

    // Aliment : 10 001 XAF, soit un coût restant de 685 001 XAF, non multiple de 45 têtes.
    await db.transaction().execute((trx) =>
      recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: piglets.id,
          costType: 'ALIMENT',
          amountXaf: 10_001,
          direction: 'DEBIT',
          sourceType: 'MANUAL',
          sourceId: freshUuid(),
          occurredAt: new Date(at('12:30:00')),
          createdBy: productionManager.userId,
        },
      ),
    );
    expect(await remainingCost(piglets.id)).toBe(685_001);

    const fattening = await createLot('PORC_ENGRAISSEMENT', products.pig);
    expect(
      code(
        (
          await entry(
            fattening.id,
            {
              sourceKind: 'WEANING',
              sourceProductionLotId: fattening.id,
              sourceLocationId: penId,
              quantity: 2,
            },
            at('13:00:00'),
          )
        ).result,
      ),
    ).toBe('LOT_ENTRY_INVALID');
    const wean = (time: string) =>
      entry(
        fattening.id,
        {
          sourceKind: 'WEANING',
          sourceProductionLotId: piglets.id,
          sourceLocationId: penId,
          quantity: 45,
        },
        at(time),
      );
    const weaning = await wean('13:30:00');
    expect(weaning.result.status, JSON.stringify(weaning.result)).toBe('APPLIED');
    expect(await entryRow(weaning.id)).toMatchObject({
      entry_type: 'TRANSFER_IN',
      source_kind: 'WEANING',
      value_xaf: 685_001,
    });
    expect(await heads(piglets.id)).toBe(0);
    expect(await heads(fattening.id)).toBe(45);

    // AV-120 : les porcelets de la naissance sont sortis → annulation refusée.
    expect(code(await cancel(birth.id, '13:40:00'))).toBe('STOCK_UNAVAILABLE');
    // Annulation du sevrage : porcelets rendus à leur valeur exacte (revue P7 : 685 001 XAF,
    // pas 45 × 15 222 = 684 990).
    expect(code(await cancel(weaning.id, '13:45:00'))).toBe('APPLIED');
    expect(await heads(piglets.id)).toBe(45);
    expect(await heads(fattening.id)).toBe(0);
    expect((await lotCost(fattening.id)).netXaf).toBe(0);
    expect(await remainingCost(piglets.id)).toBe(685_001);

    // Sevrage définitif puis clôture du lot de porcelets : l'entrée ne s'annule plus, le coût
    // du lot d'origine étant figé (revue P7).
    const final = await wean('14:30:00');
    expect(final.result.status, JSON.stringify(final.result)).toBe('APPLIED');
    const closed = await run(
      productionManager,
      'production.lot.close',
      'PRODUCTION_LOT',
      piglets.id,
      at('15:00:00'),
      {},
    );
    expect(closed.status, JSON.stringify(closed)).toBe('APPLIED');
    expect((await lotRow(piglets.id)).closing_summary).toMatchObject({ unrecoveredCostXaf: 0 });
    expect(code(await cancel(final.id, '15:10:00'))).toBe('SOURCE_LOT_NOT_ACTIVE');

    // Hors ligne, un sevrage depuis le lot de porcelets clos est appliqué, avec un conflit
    // LOT_CLOSED sur ce lot d'origine (revue P7).
    const late = await entry(
      fattening.id,
      {
        sourceKind: 'WEANING',
        sourceProductionLotId: piglets.id,
        sourceLocationId: penId,
        quantity: 1,
      },
      at('14:45:00'),
      { offline: true },
    );
    expect(late.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['LOT_CLOSED'],
    });
    const conflicts = await db
      .selectFrom('sync_sync_conflicts')
      .select('conflict_type')
      .where('entity_id', '=', toBin(piglets.id))
      .execute();
    expect(conflicts).toEqual([{ conflict_type: 'LOT_CLOSED' }]);
  });

  it('annulation d’un lot planifié ; entrée hors ligne sur un lot annulé (LOT_CLOSED) ; clôture', async () => {
    const planned = await createLot('POULET_CHAIR', products.broiler);
    const cancelLot = (lotId: string) =>
      run(productionManager, 'production.lot.cancel', 'PRODUCTION_LOT', lotId, at('15:00:00'), {
        comment: 'Bande reportée',
      });
    expect(code(await cancelLot(planned.id))).toBe('APPLIED');
    const cancelled = await lotRow(planned.id);
    expect(cancelled.status).toBe('CANCELLED');
    const stockLot = await db
      .selectFrom('inventory_stock_lots')
      .select('status')
      .where('id', '=', cancelled.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(stockLot.status).toBe('CLOSED');
    const source = {
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: products.boughtChick,
      sourceLocationId: farmStoreId,
    };
    expect(code((await entry(planned.id, { ...source, quantity: 5 }, at('15:30:00'))).result)).toBe(
      'LOT_NOT_ACTIVE',
    );
    const late = await entry(planned.id, { ...source, quantity: 5 }, at('14:30:00'), {
      offline: true,
    });
    expect(late.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['LOT_CLOSED'],
    });
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'owner_role', 'applied'])
      .where('entity_id', '=', toBin(planned.id))
      .executeTakeFirstOrThrow();
    expect(conflict).toMatchObject({
      conflict_type: 'LOT_CLOSED',
      owner_role: 'RESP_PRODUCTION',
      applied: 1,
    });
    expect((await lotRow(planned.id)).status).toBe('CANCELLED');
    // Reçue hors ligne après l'annulation du lot, l'entrée s'annule, sinon ses animaux
    // resteraient bloqués dans un lot clos (revue P7).
    expect(
      code(
        await run(
          productionManager,
          'production.lot.cancel_entry',
          'LOT_ENTRY',
          late.id,
          at('15:40:00'),
          {
            comment: 'Saisie tardive sur un lot annulé',
          },
        ),
      ),
    ).toBe('APPLIED');
    expect(await heads(planned.id)).toBe(0);

    // Lot avec entrée : non annulable ; clôture refusée tant qu'il reste des animaux ou une
    // mortalité en attente de validation.
    const lot = await createLot('POULET_CHAIR', products.broiler);
    const placed = await entry(lot.id, { ...source, quantity: 5 }, at('16:00:00'));
    expect(placed.result.status, JSON.stringify(placed.result)).toBe('APPLIED');
    expect(code(await cancelLot(lot.id))).toBe('LOT_NOT_CANCELLABLE');
    const close = () =>
      run(productionManager, 'production.lot.close', 'PRODUCTION_LOT', lot.id, at('18:00:00'), {});
    expect(code(await close())).toBe('LOT_NOT_EMPTY');
    const stockLotId = fromBin((await lotRow(lot.id)).stock_lot_id);
    const mortality = await run(
      farmManager,
      'inventory.loss.declare',
      'STOCK_LOSS',
      freshUuid(),
      at('17:00:00'),
      {
        locationId: buildingId,
        productId: products.broiler,
        lotId: stockLotId,
        productionLotId: lot.id,
        quantityBase: 5,
        unitCode: 'TETE',
        quantity: 5,
        category: 'MORTALITE',
      },
      { attachmentIds: [freshUuid()] },
    );
    expect(mortality.status, JSON.stringify(mortality)).toBe('APPLIED');
    expect(await heads(lot.id)).toBe(0);
    expect(code(await close())).toBe('LOT_HAS_PENDING_LOSS');

    // Lot vidé par une annulation d'entrée : clôture, résumé figé, lot de traçabilité clos.
    const empty = await createLot('POULET_CHAIR', products.broiler);
    const temp = await entry(empty.id, { ...source, quantity: 3 }, at('16:30:00'));
    expect(
      code(
        await run(
          productionManager,
          'production.lot.cancel_entry',
          'LOT_ENTRY',
          temp.id,
          at('16:45:00'),
          {
            comment: 'Doublon',
          },
        ),
      ),
    ).toBe('APPLIED');
    const closeEmpty = () =>
      run(
        productionManager,
        'production.lot.close',
        'PRODUCTION_LOT',
        empty.id,
        at('18:30:00'),
        {},
      );
    expect(code(await closeEmpty())).toBe('APPLIED');
    const closed = await lotRow(empty.id);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closing_summary).toMatchObject({
      enteredQuantity: 0,
      mortalityQuantity: 0,
      costNetXaf: 0,
      unrecoveredCostXaf: 0,
    });
    const closedStockLot = await db
      .selectFrom('inventory_stock_lots')
      .select('status')
      .where('id', '=', closed.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(closedStockLot.status).toBe('CLOSED');
    expect(code(await closeEmpty())).toBe('APPLIED');
  });

  it('clôture : refusée tant que des têtes sont vendues non livrées (LOT_HAS_UNDELIVERED, ADR-029 §9)', async () => {
    const lot = await createLot('POULET_CHAIR', products.broiler);
    const source = {
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: products.boughtChick,
      sourceLocationId: farmStoreId,
    };
    const placed = await entry(lot.id, { ...source, quantity: 3 }, at('16:00:00'));
    expect(placed.result.status, JSON.stringify(placed.result)).toBe('APPLIED');
    const stockLotId = fromBin((await lotRow(lot.id)).stock_lot_id);
    const close = () =>
      run(productionManager, 'production.lot.close', 'PRODUCTION_LOT', lot.id, at('19:00:00'), {});

    // Les trois têtes sont vendues sur commande : mises de côté « à livrer », hors de l'effectif.
    const saleId = freshUuid();
    const saleLineId = freshUuid();
    await db.transaction().execute(async (trx) => {
      const toDeliver = await ensureToDeliverLocation(
        trx,
        { idGenerator },
        { siteId: farmId, createdBy: admin.userId },
      );
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: products.broiler,
          lotId: stockLotId,
          quantityBase: 3,
          fromLocationId: buildingId,
          toLocationId: toDeliver.locationId,
          moveType: 'SALE',
          occurredAt: new Date(at('17:00:00')),
          sourceDocType: 'SALE',
          sourceDocId: saleId,
          sourceLineId: saleLineId,
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
    expect(await heads(lot.id)).toBe(0);
    expect(code(await close())).toBe('LOT_HAS_UNDELIVERED');

    // Une fois livrées, la clôture est possible ; le lot n'est pas rouvert par la livraison.
    await db.transaction().execute((trx) =>
      deliverSoldGoods(
        trx,
        { idGenerator },
        {
          saleId,
          saleLineId,
          quantityBase: 3,
          sourceDocId: freshUuid(),
          occurredAt: new Date(at('17:30:00')),
          createdBy: admin.userId,
        },
      ),
    );
    expect(code(await close())).toBe('APPLIED');
    expect((await lotRow(lot.id)).status).toBe('CLOSED');
  });

  it('hors ligne : emplacement désactivé accepté ; date de démarrage = entrée la plus ancienne (revue P7)', async () => {
    const { id: lotId } = await createLot('POULET_CHAIR', products.broiler);
    const source = {
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: products.boughtChick,
      sourceLocationId: farmStoreId,
    };
    const online = await entry(lotId, { ...source, quantity: 2 }, at('17:00:00'));
    expect(online.result.status, JSON.stringify(online.result)).toBe('APPLIED');
    expect(ymd((await lotRow(lotId)).start_date)).toBe(DAY);
    await db
      .updateTable('organization_locations')
      .set({ status: 'INACTIVE' })
      .where('id', '=', toBin(sparePenId))
      .execute();
    expect(
      code(
        (await entry(lotId, { ...source, quantity: 1, toLocationId: sparePenId }, at('17:10:00')))
          .result,
      ),
    ).toBe('LOCATION_INVALID');
    // La veille à 23:30 (heure de Douala), dans la case désactivée depuis.
    const earlier = await entry(
      lotId,
      { ...source, quantity: 1, toLocationId: sparePenId },
      '2026-10-19T22:30:00.000Z',
      { offline: true },
    );
    expect(earlier.result.status, JSON.stringify(earlier.result)).toBe('APPLIED');
    expect(ymd((await lotRow(lotId)).start_date)).toBe('2026-10-19');
    expect(Number((await lotRow(lotId)).initial_quantity)).toBe(3);
  });
});

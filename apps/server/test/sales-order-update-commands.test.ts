/**
 * Modification d'une commande confirmée, `sales.order.update` (P4-06 ; D04 §7.1, BR-VEN-005, BR-VEN-009 ;
 * ADR-028 §5 et §6 ; ADR-029 ; AV-126 à AV-130, AV-146, AV-147) à travers le vrai pipeline :
 * baisse limitée à l'attente, contre-écriture du vendu non livré (document ANV, cause
 * `ORDER_ADJUSTMENT`), retrait total d'une ligne, hausse et lignes ajoutées (vente complémentaire au
 * prix convenu), argent payé libéré (crédit client ou remboursement), statuts, `base_version`
 * (quarantaine `VERSION_CONFLICT`), lieu, date et adresse, validations, portée, hors ligne, rejeu.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import {
  deliverSoldGoods,
  recordStockMove,
  verifyStockLedger,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  cashAccountBalance,
  verifyCashLedger,
} from '../src/modules/finance/application/public/index.js';
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
  shiftBusinessDay,
} from './helpers.js';

const DAY = '2026-10-10';
const NOW = `${DAY}T18:00:00.000Z`;
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

interface Sellable {
  readonly id: string;
  readonly ruleId: string;
  readonly price: number;
  readonly unit: string;
}

const num = (value: string | number): number => Number(value);

describe('sales.order.update (P4-06)', () => {
  vi.setConfig({ testTimeout: 90_000 });

  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let commercial: Actor;
  let otherCommercial: Actor;
  let zoneId: string;
  let siteId: string;
  let storeId: string;
  let store2Id: string;
  let posId: string;
  let incubatorId: string;
  let otherSiteStoreId: string;
  let categoryId: string;
  let stepId: string;
  let sourceCode: string;
  let cashAccountId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? (r.error?.code ?? r.status) : r.status);
  const refs = (r: Result) =>
    r.status === 'APPLIED' || r.status === 'APPLIED_WITH_WARNINGS' ? (r.server_refs ?? {}) : {};

  interface RunOptions {
    readonly offline?: boolean;
    readonly commandId?: string;
    readonly baseVersion?: number | null;
    readonly deviceSeq?: number;
  }

  async function run(
    actor: Actor,
    commandType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: RunOptions = {},
  ): Promise<Result> {
    return pipeline.handle(
      {
        command_id: options.commandId ?? freshUuid(),
        device_seq: options.deviceSeq ?? ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'SALES_ORDER',
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: options.baseVersion ?? null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
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

  // --- Fixtures ----------------------------------------------------------------------------------

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function sellable(
    price: number,
    options: { readonly mode?: 'PER_UNIT' | 'PER_WEIGHT' } = {},
  ): Promise<Sellable> {
    const id = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: 'Poulet de chair',
        category_id: toBin(categoryId),
        stock_family: 'MARCHANDISE',
        base_unit_code: 'PIECE',
        pricing_mode: options.mode ?? 'PER_UNIT',
        is_sellable: 1,
        created_by: toBin(admin.userId),
      })
      .execute();
    const ruleId = freshUuid();
    await db
      .insertInto('pricing_price_rules')
      .values({
        id: toBin(ruleId),
        code: `PR-${ruleId.slice(-12)}`,
        version: 1,
        product_id: toBin(id),
        unit_price_xaf: price,
        pricing_unit_code: options.mode === 'PER_WEIGHT' ? 'KG' : 'PIECE',
        status: 'ACTIVE',
        valid_from: new Date('2026-01-01T00:00:00.000Z'),
        approved_by: toBin(admin.userId),
        approved_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: toBin(admin.userId),
      })
      .execute();
    return { id, ruleId, price, unit: 'PIECE' };
  }

  /** Nouvelle règle de prix catalogue, plus récente : le prix du catalogue change à `validFrom`. */
  async function newerRule(product: Sellable, price: number, validFrom: string): Promise<void> {
    const ruleId = freshUuid();
    await db
      .insertInto('pricing_price_rules')
      .values({
        id: toBin(ruleId),
        code: `PR-${ruleId.slice(-12)}`,
        version: 1,
        product_id: toBin(product.id),
        unit_price_xaf: price,
        pricing_unit_code: 'PIECE',
        status: 'ACTIVE',
        valid_from: new Date(validFrom),
        approved_by: toBin(admin.userId),
        approved_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: toBin(admin.userId),
      })
      .execute();
  }

  /** Conditionnement de vente (ex. carton de 6 pièces) du produit. */
  async function addPackaging(product: Sellable, unitCode: string, factor: number): Promise<void> {
    const exists = await db
      .selectFrom('catalog_units')
      .select('code')
      .where('code', '=', unitCode)
      .executeTakeFirst();
    if (!exists) {
      await db
        .insertInto('catalog_units')
        .values({ code: unitCode, name: unitCode, is_count: 1 })
        .execute();
    }
    await db
      .insertInto('catalog_product_units')
      .values({
        id: toBin(freshUuid()),
        product_id: toBin(product.id),
        unit_code: unitCode,
        factor_to_base: String(factor),
        is_sales_unit: 1,
        is_count_unit: 1,
        created_by: toBin(admin.userId),
      })
      .execute();
  }

  async function stock(
    productId: string,
    quantity: number,
    unitCost: number,
    locationId: string = storeId,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: locationId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date(`${DAY}T06:00:00.000Z`),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
    });
  }

  async function newCustomer(options: { readonly credit?: boolean } = {}): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('crm_customers')
      .values({
        id: toBin(id),
        stage: 'PROSPECT',
        pipeline_step_id: toBin(stepId),
        display_name: 'Restaurant du port',
        phone_primary: `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        zone_id: toBin(zoneId),
        source_code: sourceCode,
        acquired_by_user_id: toBin(admin.userId),
        acquired_at: new Date('2026-01-01T00:00:00.000Z'),
        occurred_at: new Date('2026-01-01T00:00:00.000Z'),
        credit_allowed: options.credit ? 1 : 0,
        ...(options.credit ? { credit_limit_xaf: 1_000_000 } : {}),
        created_by: toBin(admin.userId),
      })
      .execute();
    return id;
  }

  const line = (product: Sellable, quantity: number, extra: Record<string, unknown> = {}) => ({
    productId: product.id,
    quantity,
    unitCode: product.unit,
    quantityBase: quantity,
    listUnitPriceXaf: product.price,
    priceRuleId: product.ruleId,
    unitPriceXaf: product.price,
    ...extra,
  });

  /** Nouvelle quantité commandée totale d'une ligne existante (unité de base), charge utile de `update`. */
  const adjust = (row: { readonly id: Buffer }, quantity: number, quantityBase = quantity) => ({
    orderLineId: fromBin(row.id),
    quantity,
    quantityBase,
  });

  const place = (
    body: Record<string, unknown>,
    occurredAt: string,
    options: { readonly id?: string; readonly offline?: boolean; readonly actor?: Actor } = {},
  ) => {
    const id = options.id ?? freshUuid();
    return run(
      options.actor ?? commercial,
      'sales.order.place',
      id,
      occurredAt,
      { fulfilmentLocationId: storeId, ...body },
      options.offline !== undefined ? { offline: options.offline } : {},
    ).then((result) => ({ id, result }));
  };

  /** Commande enregistrée : échoue tout de suite si elle n'est pas appliquée. */
  async function placed(
    body: Record<string, unknown>,
    occurredAt: string,
    options: { readonly offline?: boolean; readonly actor?: Actor } = {},
  ): Promise<string> {
    const { id, result } = await place(body, occurredAt, options);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return id;
  }

  const update = (
    orderId: string,
    occurredAt: string,
    body: Record<string, unknown>,
    options: RunOptions & { readonly actor?: Actor } = {},
  ) => run(options.actor ?? commercial, 'sales.order.update', orderId, occurredAt, body, options);

  /**
   * Livraison simulée (la commande `sales.delivery.record` viendra avec P4-07) : mouvement
   * `DELIVERY` de l'emplacement « à livrer » au client, puis compteurs « livré » de la ligne de vente et
   * de la ligne de commande, et statut dérivé de la commande.
   */
  async function simulateDelivery(orderId: string, quantity: number): Promise<void> {
    const [sale] = await ordersSales(orderId);
    const [saleLine] = await saleLines(fromBin(sale!.id));
    await db.transaction().execute((trx) =>
      deliverSoldGoods(
        trx,
        { idGenerator },
        {
          saleId: fromBin(sale!.id),
          saleLineId: fromBin(saleLine!.id),
          quantityBase: quantity,
          sourceDocId: freshUuid(),
          occurredAt: new Date(at('11:00:00')),
          createdBy: admin.userId,
        },
      ),
    );
    await db
      .updateTable('sales_sale_lines')
      .set({ delivered_quantity_base: String(num(saleLine!.delivered_quantity_base) + quantity) })
      .where('id', '=', saleLine!.id)
      .execute();
    const orderLine = (await orderLines(orderId)).find(
      (candidate) => fromBin(candidate.id) === fromBin(saleLine!.order_line_id!),
    )!;
    await db
      .updateTable('sales_sales_order_lines')
      .set({ delivered_quantity_base: String(num(orderLine.delivered_quantity_base) + quantity) })
      .where('id', '=', orderLine.id)
      .execute();
    const complete = (await orderLines(orderId)).every(
      (candidate) => num(candidate.delivered_quantity_base) === num(candidate.quantity_base),
    );
    await db
      .updateTable('sales_sales_orders')
      .set({ status: complete ? 'FULFILLED' : 'PARTIALLY_FULFILLED' })
      .where('id', '=', toBin(orderId))
      .execute();
  }

  // --- Lectures ----------------------------------------------------------------------------------

  const orderRow = (id: string) =>
    db
      .selectFrom('sales_sales_orders')
      .selectAll()
      .select(
        sql<string | null>`DATE_FORMAT(requested_delivery_date, '%Y-%m-%d')`.as('delivery_day'),
      )
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  const orderLines = (id: string) =>
    db
      .selectFrom('sales_sales_order_lines')
      .selectAll()
      .where('order_id', '=', toBin(id))
      .orderBy('line_no')
      .execute();
  const ordersSales = (orderId: string) =>
    db
      .selectFrom('sales_sales')
      .selectAll()
      .select(sql<string | null>`DATE_FORMAT(due_date, '%Y-%m-%d')`.as('due'))
      .where('order_id', '=', toBin(orderId))
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
  const saleRow = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirstOrThrow();
  const saleLines = (saleId: string) =>
    db
      .selectFrom('sales_sale_lines')
      .selectAll()
      .where('sale_id', '=', toBin(saleId))
      .orderBy('line_no')
      .execute();
  const cancellations = (orderId: string) =>
    db
      .selectFrom('sales_sale_cancellations')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .orderBy('applied_at')
      .orderBy('doc_number')
      .execute();
  const cancellationByNumber = (docNumber: string) =>
    db
      .selectFrom('sales_sale_cancellations')
      .selectAll()
      .where('doc_number', '=', docNumber)
      .executeTakeFirstOrThrow();
  const cancellationLines = (cancellationId: Buffer) =>
    db
      .selectFrom('sales_sale_cancellation_lines')
      .selectAll()
      .where('cancellation_id', '=', cancellationId)
      .execute();
  const returnMoves = (cancellationId: string) =>
    db
      .selectFrom('inventory_stock_moves')
      .selectAll()
      .where('source_doc_type', '=', 'SALE_CANCELLATION')
      .where('source_doc_id', '=', toBin(cancellationId))
      .execute();
  const saleAllocations = (saleId: string) =>
    db
      .selectFrom('sales_payment_allocations')
      .selectAll()
      .where('sale_id', '=', toBin(saleId))
      .orderBy('allocated_at')
      .orderBy('id')
      .execute();
  const orderAllocations = (orderId: string) =>
    db
      .selectFrom('sales_payment_allocations')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .execute();
  const paymentsOf = (customerId: string) =>
    db
      .selectFrom('sales_customer_payments')
      .selectAll()
      .where('customer_id', '=', toBin(customerId))
      .execute();
  const refundMovements = (documentId: string) =>
    db
      .selectFrom('finance_cash_movements')
      .selectAll()
      .where('source_doc_type', '=', 'SALE_REFUND')
      .where('source_doc_id', '=', toBin(documentId))
      .execute();
  const onHandAt = async (productId: string, location: string): Promise<number> => {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select(sql<string>`COALESCE(SUM(qty_on_hand), 0)`.as('qty'))
      .where('location_id', '=', toBin(location))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    return Number(row.qty);
  };
  const moveCount = async (productId: string): Promise<number> => {
    const row = await db
      .selectFrom('inventory_stock_moves')
      .select(sql<string>`COUNT(*)`.as('n'))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  };
  const toDeliverOf = async (): Promise<string | undefined> => {
    const row = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('site_id', '=', toBin(siteId))
      .where('location_type', '=', 'V_TO_DELIVER')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return row ? fromBin(row.id) : undefined;
  };

  /** État observable d'une commande et de ses effets : sert à prouver qu'un rejet n'écrit rien. */
  async function snapshotOf(orderId: string, productIds: readonly string[]) {
    const order = await orderRow(orderId);
    const toDeliver = await toDeliverOf();
    const sales = await ordersSales(orderId);
    const allocations = [
      ...(await orderAllocations(orderId)),
      ...(await Promise.all(sales.map((sale) => saleAllocations(fromBin(sale.id))))).flat(),
    ];
    return {
      order: [
        order.status,
        order.version,
        order.total_estimated_xaf,
        order.advance_paid_xaf,
        fromBin(order.fulfilment_location_id),
        order.delivery_day,
        order.delivery_address,
      ],
      lines: (await orderLines(orderId)).map((l) => [
        l.line_no,
        num(l.quantity),
        num(l.quantity_base),
        num(l.sold_quantity_base),
        num(l.withdrawn_quantity_base),
        l.line_total_xaf,
      ]),
      sales: sales.map((s) => [fromBin(s.id), s.status, s.cancelled_xaf, s.amount_paid_xaf]),
      allocations: allocations
        .map((a) => [fromBin(a.id), a.status, a.reversal_cause, a.amount_xaf])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      cancellations: (await cancellations(orderId)).length,
      stock: await Promise.all(
        productIds.map(async (productId) => [
          await moveCount(productId),
          await onHandAt(productId, storeId),
          toDeliver ? await onHandAt(productId, toDeliver) : 0,
        ]),
      ),
    };
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerOrderCommands(registry, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    for (const unit of ['PIECE', 'KG']) {
      const exists = await db
        .selectFrom('catalog_units')
        .select('code')
        .where('code', '=', unit)
        .executeTakeFirst();
      if (!exists) {
        await db
          .insertInto('catalog_units')
          .values({ code: unit, name: unit, is_count: unit === 'PIECE' ? 1 : 0 })
          .execute();
      }
    }
    for (const channel of ['DIRECT', 'SEDENTAIRE', 'TERRAIN']) {
      const exists = await db
        .selectFrom('catalog_sales_channels')
        .select('code')
        .where('code', '=', channel)
        .executeTakeFirst();
      if (!exists) {
        await db
          .insertInto('catalog_sales_channels')
          .values({ code: channel, name: channel })
          .execute();
      }
    }
    const method = await db
      .selectFrom('finance_payment_methods')
      .select('code')
      .where('code', '=', 'ESPECES')
      .executeTakeFirst();
    if (!method) {
      await db
        .insertInto('finance_payment_methods')
        .values({
          code: 'ESPECES',
          label: 'Espèces',
          requires_reference: 0,
          default_account_type: 'CAISSE_UTILISATEUR',
        })
        .execute();
    }

    const sedentary = await roleId('COMMERCIAL_SEDENTAIRE');
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      zoneId = await insertTestZone(trx, adminId);
      siteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      storeId = await insertTestLocation(trx, adminId, siteId, { locationType: 'STORE' });
      store2Id = await insertTestLocation(trx, adminId, siteId, { locationType: 'STORE' });
      posId = await insertTestLocation(trx, adminId, siteId, { locationType: 'POS' });
      incubatorId = await insertTestLocation(trx, adminId, siteId, { locationType: 'INCUBATOR' });
      const otherSiteId = await insertTestSite(trx, adminId, zoneId, { siteType: 'MAGASIN' });
      otherSiteStoreId = await insertTestLocation(trx, adminId, otherSiteId, {
        locationType: 'STORE',
      });
      const actor = async () => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, sedentary, adminId, { scopeType: 'GLOBAL' });
        return { userId, deviceId };
      };
      commercial = await actor();
      otherCommercial = await actor();
      categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Divers',
          created_by: toBin(adminId),
        })
        .execute();
      stepId = freshUuid();
      await trx
        .insertInto('crm_pipeline_steps')
        .values({
          id: toBin(stepId),
          code: `STEP_${stepId.slice(-8)}`,
          label: 'Nouveau',
          sort_order: 10,
          created_by: toBin(adminId),
        })
        .execute();
      sourceCode = `SRC_${freshUuid().slice(-8)}`;
      await trx
        .insertInto('crm_lead_sources')
        .values({
          id: toBin(freshUuid()),
          code: sourceCode,
          label: 'Kommo',
          created_by: toBin(adminId),
        })
        .execute();
      cashAccountId = freshUuid();
      await trx
        .insertInto('finance_cash_accounts')
        .values({
          id: toBin(cashAccountId),
          code: `CPT-${cashAccountId.slice(-10)}`,
          name: 'Caisse du commercial',
          account_type: 'CAISSE_UTILISATEUR',
          holder_user_id: toBin(commercial.userId),
          responsible_user_id: toBin(adminId),
          created_by: toBin(adminId),
        })
        .execute();
    });
    for (const [operationType, approverPermission] of [
      ['PRICE_OVERRIDE', 'sales.price_override.approve'],
      ['PAYMENT_DUPLICATE', 'sales.payment.cancel'],
    ] as const) {
      const policyId = freshUuid();
      const policy = await run(admin, 'approvals.policy.set', policyId, at('00:00:00'), {
        code: `${operationType}_${policyId.slice(-8)}`,
        operationType,
        requiresApproval: true,
        approverPermission,
        approverScope: 'ALL',
      });
      expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // --- 1. Baisse limitée à l'attente --------------------------------------------------------------------------

  it('1. baisse limitée à la part en attente : aucune contre-écriture, aucun mouvement, compteurs de la ligne', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 5)] }, at('09:00:00'));
    const [before] = await orderLines(id);
    expect(num(before!.sold_quantity_base)).toBe(3);
    expect(num(before!.quantity_base)).toBe(5);
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 1,
      total_estimated_xaf: 5000,
    });
    const toDeliver = (await toDeliverOf())!;
    const moves = await moveCount(product.id);

    const result = await update(id, at('10:00:00'), { lines: [adjust(before!, 4)] });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['docNumber']).toMatch(/^CMD-/);
    expect(refs(result)['saleDocNumber']).toBeUndefined();
    expect(refs(result)['cancellation1']).toBeUndefined();

    const [after] = await orderLines(id);
    expect([
      num(after!.quantity),
      num(after!.quantity_base),
      num(after!.sold_quantity_base),
      num(after!.withdrawn_quantity_base),
    ]).toEqual([4, 4, 3, 1]);
    expect(after).toMatchObject({ line_total_xaf: 4000, quoted_unit_price_xaf: 1000 });
    const order = await orderRow(id);
    expect(order).toMatchObject({ status: 'CONFIRMED', version: 2, total_estimated_xaf: 4000 });
    expect(fromBin(order.updated_by!)).toBe(commercial.userId);
    // Ni document d'annulation, ni toucher à la vente, ni mouvement de stock.
    expect(await cancellations(id)).toHaveLength(0);
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ status: 'CONFIRMED', total_xaf: 3000, cancelled_xaf: 0 });
    expect(await moveCount(product.id)).toBe(moves);
    expect(await onHandAt(product.id, storeId)).toBe(0);
    expect(await onHandAt(product.id, toDeliver)).toBe(3);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 2. Baisse qui mord le vendu non livré ---------------------------------------------------------------------

  it('2a. baisse qui mord le vendu non livré : ANV ORDER_ADJUSTMENT, stock rendu, chiffre d’affaires au prorata, vente intacte', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 600);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 5)] }, at('09:00:00'));
    const [sale] = await ordersSales(id);
    const [saleLine] = await saleLines(fromBin(sale!.id));
    const toDeliver = (await toDeliverOf())!;
    expect(await onHandAt(product.id, storeId)).toBe(5);
    expect(await onHandAt(product.id, toDeliver)).toBe(5);
    const [orderLine] = await orderLines(id);
    expect(num(orderLine!.sold_quantity_base)).toBe(5);

    const commandId = freshUuid();
    const result = await update(
      id,
      at('10:00:00'),
      { lines: [adjust(orderLine!, 2)] },
      { commandId },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['cancellation1']).toMatch(/^ANV-/);
    expect(refs(result)['cancellation2']).toBeUndefined();
    expect(refs(result)['saleDocNumber']).toBeUndefined();

    // Audit avant / après : quantités par ligne, lieu de préparation et version.
    const audit = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'before', 'after', 'result'])
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ action: 'sales.order.update', result: 'SUCCESS' });
    expect(audit.before).toMatchObject({
      lines: [{ orderLineId: fromBin(orderLine!.id), quantityBase: 5 }],
      fulfilmentLocationId: storeId,
      version: 1,
    });
    expect(audit.after).toMatchObject({
      lines: [{ orderLineId: fromBin(orderLine!.id), quantityBase: 2 }],
      fulfilmentLocationId: storeId,
      version: 2,
    });

    // Document d'annulation : cause, statut, heure métier de l'effet, rattachement à la commande.
    const docs = await cancellations(id);
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc).toMatchObject({
      doc_number: refs(result)['cancellation1'],
      cause: 'ORDER_ADJUSTMENT',
      status: 'APPLIED',
      cancelled_total_xaf: 3000,
      released_payment_treatment: null,
      captured_offline: 0,
    });
    expect(doc.applied_at?.toISOString()).toBe(at('10:00:00'));
    expect(doc.occurred_at.toISOString()).toBe(at('10:00:00'));
    expect(fromBin(doc.order_id!)).toBe(id);
    expect(fromBin(doc.sale_id)).toBe(fromBin(sale!.id));
    expect(fromBin(doc.requested_by)).toBe(commercial.userId);
    const docLines = await cancellationLines(doc.id);
    expect(docLines).toHaveLength(1);
    expect(docLines[0]).toMatchObject({ amount_xaf: 3000 });
    expect(fromBin(docLines[0]!.sale_line_id)).toBe(fromBin(saleLine!.id));
    expect(num(docLines[0]!.quantity_base)).toBe(3);

    // Vente : seuls les compteurs d'annulation bougent (au prorata), le total ne change jamais.
    const [saleLineAfter] = await saleLines(fromBin(sale!.id));
    expect(saleLineAfter).toMatchObject({ cancelled_xaf: 3000, line_total_xaf: 5000 });
    expect(num(saleLineAfter!.cancelled_quantity_base)).toBe(3);
    expect(num(saleLineAfter!.quantity_base)).toBe(5);
    expect(await saleRow(fromBin(sale!.id))).toMatchObject({
      status: 'CONFIRMED',
      total_xaf: 5000,
      subtotal_xaf: 5000,
      cancelled_xaf: 3000,
      net_total_xaf: 2000,
    });

    // Ligne de commande : commandé et vendu net à 2, cumul retiré 3.
    const [orderLineAfter] = await orderLines(id);
    expect([
      num(orderLineAfter!.quantity),
      num(orderLineAfter!.quantity_base),
      num(orderLineAfter!.sold_quantity_base),
      num(orderLineAfter!.withdrawn_quantity_base),
    ]).toEqual([2, 2, 2, 3]);
    expect(orderLineAfter).toMatchObject({ line_total_xaf: 2000 });
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 2,
      total_estimated_xaf: 2000,
    });

    // Stock : 3 pièces reviennent au magasin par un retour rattaché, 2 restent « à livrer ».
    expect(await onHandAt(product.id, storeId)).toBe(8);
    expect(await onHandAt(product.id, toDeliver)).toBe(2);
    const returns = await returnMoves(fromBin(doc.id));
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ move_type: 'CUSTOMER_RETURN' });
    expect(num(returns[0]!.quantity)).toBe(3);
    expect(Number(returns[0]!.value_xaf)).toBe(1800);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('2b. cas mixte : 5 commandés, 3 vendus, baisse à 1 — 2 en attente retirés puis 2 vendus annulés', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 5)] }, at('09:05:00'));
    const [orderLine] = await orderLines(id);
    expect(num(orderLine!.sold_quantity_base)).toBe(3);
    const [sale] = await ordersSales(id);
    const toDeliver = (await toDeliverOf())!;

    const result = await update(id, at('10:05:00'), { lines: [adjust(orderLine!, 1)] });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['cancellation1']).toMatch(/^ANV-/);
    expect(refs(result)['cancellation2']).toBeUndefined();

    const [doc] = await cancellations(id);
    expect(doc).toMatchObject({ cause: 'ORDER_ADJUSTMENT', cancelled_total_xaf: 2000 });
    expect(num((await cancellationLines(doc!.id))[0]!.quantity_base)).toBe(2);
    const [orderLineAfter] = await orderLines(id);
    expect([
      num(orderLineAfter!.quantity_base),
      num(orderLineAfter!.sold_quantity_base),
      num(orderLineAfter!.withdrawn_quantity_base),
    ]).toEqual([1, 1, 4]);
    expect(orderLineAfter).toMatchObject({ line_total_xaf: 1000 });
    const [saleLineAfter] = await saleLines(fromBin(sale!.id));
    expect(num(saleLineAfter!.cancelled_quantity_base)).toBe(2);
    expect(saleLineAfter).toMatchObject({ cancelled_xaf: 2000 });
    expect(await saleRow(fromBin(sale!.id))).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 2000,
    });
    expect(await onHandAt(product.id, storeId)).toBe(2);
    expect(await onHandAt(product.id, toDeliver)).toBe(1);
    expect(await orderRow(id)).toMatchObject({ status: 'CONFIRMED', total_estimated_xaf: 1000 });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 3. La vente la plus récente d'abord --------------------------------------------------------------------

  it('3. deux ventes : la baisse retire d’abord la plus récente ; plus forte, elle annule la 2e en entier puis une part de la 1re', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 5)] }, at('09:00:00'));
    await stock(product.id, 4, 700);
    const later = await run(commercial, 'sales.order.confirm_remaining', id, at('09:30:00'), {});
    expect(later.status, JSON.stringify(later)).toBe('APPLIED');
    expect(refs(later)['saleDocNumber']).toMatch(/^VTE-/);
    const [saleA, saleB] = await ordersSales(id);
    expect([saleA!.total_xaf, saleB!.total_xaf]).toEqual([3000, 2000]);
    const toDeliver = (await toDeliverOf())!;
    expect(await onHandAt(product.id, storeId)).toBe(2);
    expect(await onHandAt(product.id, toDeliver)).toBe(5);
    const [orderLine] = await orderLines(id);
    expect(num(orderLine!.sold_quantity_base)).toBe(5);

    // Baisse de 1 : seule la 2e vente (la plus récente) est touchée.
    const first = await update(id, at('10:00:00'), { lines: [adjust(orderLine!, 4)] });
    expect(first.status, JSON.stringify(first)).toBe('APPLIED');
    expect(refs(first)['cancellation1']).toMatch(/^ANV-/);
    expect(refs(first)['cancellation2']).toBeUndefined();
    const docsAfterFirst = await cancellations(id);
    expect(docsAfterFirst).toHaveLength(1);
    expect(fromBin(docsAfterFirst[0]!.sale_id)).toBe(fromBin(saleB!.id));
    expect(docsAfterFirst[0]).toMatchObject({ cancelled_total_xaf: 1000 });
    expect(await saleRow(fromBin(saleA!.id))).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 0,
    });
    expect(num((await saleLines(fromBin(saleA!.id)))[0]!.cancelled_quantity_base)).toBe(0);
    expect(await saleRow(fromBin(saleB!.id))).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 1000,
    });
    expect(num((await saleLines(fromBin(saleB!.id)))[0]!.cancelled_quantity_base)).toBe(1);
    expect(await onHandAt(product.id, storeId)).toBe(3);
    expect(await onHandAt(product.id, toDeliver)).toBe(4);

    // Baisse de 3 : le reste de la 2e vente (1) puis 2 de la 1re (3) — deux documents.
    const [orderLineMid] = await orderLines(id);
    expect([num(orderLineMid!.quantity_base), num(orderLineMid!.sold_quantity_base)]).toEqual([
      4, 4,
    ]);
    const second = await update(id, at('10:30:00'), { lines: [adjust(orderLineMid!, 1)] });
    expect(second.status, JSON.stringify(second)).toBe('APPLIED');
    expect(refs(second)['cancellation1']).toMatch(/^ANV-/);
    expect(refs(second)['cancellation2']).toMatch(/^ANV-/);
    expect(refs(second)['cancellation3']).toBeUndefined();
    expect(await cancellations(id)).toHaveLength(3);
    const secondDocs = await Promise.all(
      [refs(second)['cancellation1']!, refs(second)['cancellation2']!].map(cancellationByNumber),
    );
    expect(secondDocs.map((doc) => fromBin(doc.sale_id)).sort()).toEqual(
      [fromBin(saleA!.id), fromBin(saleB!.id)].sort(),
    );
    expect(secondDocs.every((doc) => doc.cause === 'ORDER_ADJUSTMENT')).toBe(true);
    expect(secondDocs.every((doc) => doc.applied_at?.toISOString() === at('10:30:00'))).toBe(true);
    expect(secondDocs.reduce((sum, doc) => sum + doc.cancelled_total_xaf, 0)).toBe(3000);

    // 2e vente annulée en entier (montant exact), 1re vente annulée de 2 sur 3.
    expect(await saleRow(fromBin(saleB!.id))).toMatchObject({
      status: 'CANCELLED',
      cancelled_xaf: 2000,
    });
    expect(num((await saleLines(fromBin(saleB!.id)))[0]!.cancelled_quantity_base)).toBe(2);
    expect(await saleRow(fromBin(saleA!.id))).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 2000,
    });
    expect(num((await saleLines(fromBin(saleA!.id)))[0]!.cancelled_quantity_base)).toBe(2);
    const [orderLineAfter] = await orderLines(id);
    expect([
      num(orderLineAfter!.quantity_base),
      num(orderLineAfter!.sold_quantity_base),
      num(orderLineAfter!.withdrawn_quantity_base),
    ]).toEqual([1, 1, 4]);
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 3,
      total_estimated_xaf: 1000,
    });
    expect(await onHandAt(product.id, storeId)).toBe(6);
    expect(await onHandAt(product.id, toDeliver)).toBe(1);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 4. Retrait total d'une ligne ------------------------------------------------------------------------------

  it('4a. retrait total d’une ligne (0) pendant qu’une autre reste : commandé nul, cumul retiré, vente annulée pour cette ligne', async () => {
    const a = await sellable(1000);
    const b = await sellable(2500);
    await stock(a.id, 10, 400);
    await stock(b.id, 10, 1500);
    const customer = await newCustomer({ credit: true });
    const id = await placed(
      { customerId: customer, lines: [line(a, 2), line(b, 3)] },
      at('09:00:00'),
    );
    const [lineA, lineB] = await orderLines(id);
    const [sale] = await ordersSales(id);
    expect(sale!.total_xaf).toBe(9500);
    const toDeliver = (await toDeliverOf())!;
    expect(await onHandAt(b.id, toDeliver)).toBe(3);

    const result = await update(id, at('10:00:00'), { lines: [adjust(lineB!, 0)] });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['cancellation1']).toMatch(/^ANV-/);
    expect(refs(result)['cancellation2']).toBeUndefined();

    const [afterA, afterB] = await orderLines(id);
    expect(afterB).toMatchObject({ line_total_xaf: 0, line_no: 2 });
    expect([
      num(afterB!.quantity),
      num(afterB!.quantity_base),
      num(afterB!.sold_quantity_base),
      num(afterB!.withdrawn_quantity_base),
    ]).toEqual([0, 0, 0, 3]);
    // La ligne conservée n'est pas touchée.
    expect([
      num(afterA!.quantity_base),
      num(afterA!.sold_quantity_base),
      num(afterA!.withdrawn_quantity_base),
      afterA!.line_total_xaf,
    ]).toEqual([num(lineA!.quantity_base), 2, 0, 2000]);
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 2,
      total_estimated_xaf: 2000,
    });

    const [doc] = await cancellations(id);
    expect(doc).toMatchObject({ cause: 'ORDER_ADJUSTMENT', cancelled_total_xaf: 7500 });
    expect(await cancellationLines(doc!.id)).toHaveLength(1);
    const saleLinesAfter = await saleLines(fromBin(sale!.id));
    expect(saleLinesAfter.map((l) => [num(l.cancelled_quantity_base), l.cancelled_xaf])).toEqual([
      [0, 0],
      [3, 7500],
    ]);
    expect(await saleRow(fromBin(sale!.id))).toMatchObject({
      status: 'CONFIRMED',
      total_xaf: 9500,
      cancelled_xaf: 7500,
      net_total_xaf: 2000,
    });
    expect(await onHandAt(b.id, storeId)).toBe(10);
    expect(await onHandAt(b.id, toDeliver)).toBe(0);
    expect(await onHandAt(a.id, storeId)).toBe(8);
    expect(await onHandAt(a.id, toDeliver)).toBe(2);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('4b. retirer toutes les lignes : ORDER_EMPTY, aucune écriture ; retirer une ligne en ajoutant une autre passe', async () => {
    const a = await sellable(1000);
    const b = await sellable(2500);
    await stock(a.id, 10, 400);
    await stock(b.id, 5, 1500);
    const customer = await newCustomer({ credit: true });
    const id = await placed(
      { customerId: customer, lines: [line(a, 2), line(b, 1)] },
      at('09:10:00'),
    );
    const [lineA, lineB] = await orderLines(id);
    const before = await snapshotOf(id, [a.id, b.id]);

    const empty = await update(id, at('10:00:00'), {
      lines: [adjust(lineA!, 0), adjust(lineB!, 0)],
    });
    expect(code(empty)).toBe('ORDER_EMPTY');
    expect(await snapshotOf(id, [a.id, b.id])).toEqual(before);

    // Remplacer une ligne par un autre produit : le total commandé reste positif.
    const c = await sellable(800);
    await stock(c.id, 4, 300);
    const replaced = await update(id, at('10:10:00'), {
      lines: [adjust(lineA!, 0)],
      addedLines: [line(c, 3)],
    });
    expect(replaced.status, JSON.stringify(replaced)).toBe('APPLIED');
    expect(refs(replaced)['cancellation1']).toMatch(/^ANV-/);
    expect(refs(replaced)['saleDocNumber']).toMatch(/^VTE-/);
    const lines = await orderLines(id);
    expect(lines.map((l) => [l.line_no, num(l.quantity_base), num(l.sold_quantity_base)])).toEqual([
      [1, 0, 0],
      [2, 1, 1],
      [3, 3, 3],
    ]);
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 2,
      total_estimated_xaf: 0 + 2500 + 2400,
    });
    // Seule la ligne retirée est annulée dans la 1re vente (qui garde l'autre ligne) ; la vente
    // complémentaire porte le nouveau produit.
    const [first, second] = await ordersSales(id);
    expect(first).toMatchObject({ status: 'CONFIRMED', total_xaf: 4500, cancelled_xaf: 2000 });
    expect(second).toMatchObject({ total_xaf: 2400, status: 'CONFIRMED' });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 5. Hausse et lignes ajoutées --------------------------------------------------------------------------

  it('5a. hausse avec stock : la quantité supplémentaire est vendue au prix convenu, pas au prix catalogue actuel', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 400);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 3)] }, at('09:00:00'));
    // Le catalogue passe à 1 500 avant la hausse : le prix convenu (1 000) ne bouge pas.
    await newerRule(product, 1500, at('09:30:00'));
    const [orderLine] = await orderLines(id);

    const result = await update(id, at('10:00:00'), { lines: [adjust(orderLine!, 5)] });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['saleDocNumber']).toMatch(/^VTE-/);
    expect(refs(result)['cancellation1']).toBeUndefined();

    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    expect(sales.map((sale) => sale.total_xaf)).toEqual([3000, 2000]);
    const complementary = sales[1]!;
    expect(complementary).toMatchObject({
      sale_type: 'ORDER',
      status: 'CONFIRMED',
      doc_number: refs(result)['saleDocNumber'],
      amount_paid_xaf: 0,
      payment_status: 'UNPAID',
    });
    expect(complementary.occurred_at.toISOString()).toBe(at('10:00:00'));
    // Échéance depuis l'heure de la modification (AV-129).
    expect(complementary.due).toBe(shiftBusinessDay(DAY, 30));
    const [complementaryLine] = await saleLines(fromBin(complementary.id));
    expect(complementaryLine).toMatchObject({
      price_source: 'ORDER_QUOTE',
      unit_price_xaf: 1000,
      list_unit_price_xaf: 1000,
      line_total_xaf: 2000,
    });
    expect(num(complementaryLine!.quantity_base)).toBe(2);
    expect(fromBin(complementaryLine!.order_line_id!)).toBe(fromBin(orderLine!.id));

    const [after] = await orderLines(id);
    expect([
      num(after!.quantity),
      num(after!.quantity_base),
      num(after!.sold_quantity_base),
      num(after!.withdrawn_quantity_base),
    ]).toEqual([5, 5, 5, 0]);
    expect(after).toMatchObject({ quoted_unit_price_xaf: 1000, line_total_xaf: 5000 });
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 2,
      total_estimated_xaf: 5000,
    });
    expect(await cancellations(id)).toHaveLength(0);
    expect(await onHandAt(product.id, storeId)).toBe(5);
    expect(await onHandAt(product.id, (await toDeliverOf())!)).toBe(5);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('5b. hausse sans stock : le supplément reste en attente, aucune vente ; confirmé plus tard au prix convenu', async () => {
    const product = await sellable(1000);
    await stock(product.id, 2, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 2)] }, at('09:00:00'));
    const [orderLine] = await orderLines(id);
    expect(num(orderLine!.sold_quantity_base)).toBe(2);
    expect(await onHandAt(product.id, storeId)).toBe(0);

    const result = await update(id, at('10:00:00'), { lines: [adjust(orderLine!, 6)] });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['saleDocNumber']).toBeUndefined();
    expect(await ordersSales(id)).toHaveLength(1);
    const [after] = await orderLines(id);
    expect([
      num(after!.quantity),
      num(after!.quantity_base),
      num(after!.sold_quantity_base),
      num(after!.withdrawn_quantity_base),
    ]).toEqual([6, 6, 2, 0]);
    expect(after).toMatchObject({ line_total_xaf: 6000 });
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 2,
      total_estimated_xaf: 6000,
    });

    // Le stock arrive : le reste se vend au prix convenu ; la progression des ventes ne change pas la version.
    await stock(product.id, 3, 700);
    const later = await run(commercial, 'sales.order.confirm_remaining', id, at('11:00:00'), {});
    expect(later.status, JSON.stringify(later)).toBe('APPLIED');
    expect(refs(later)['saleDocNumber']).toMatch(/^VTE-/);
    const sales = await ordersSales(id);
    expect(sales.map((sale) => sale.total_xaf)).toEqual([2000, 3000]);
    const [soldLater] = await orderLines(id);
    expect(num(soldLater!.sold_quantity_base)).toBe(5);
    expect(await orderRow(id)).toMatchObject({ status: 'CONFIRMED', version: 2 });
  });

  it('5c. lignes ajoutées : numéro suivant, prix résolu par la règle, vendue si stock, en attente sinon', async () => {
    const a = await sellable(1000);
    const b = await sellable(2500);
    const c = await sellable(800);
    await stock(a.id, 5, 400);
    await stock(b.id, 4, 1500);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(a, 2)] }, at('09:00:00'));

    const result = await update(id, at('10:00:00'), { addedLines: [line(b, 2), line(c, 1)] });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['saleDocNumber']).toMatch(/^VTE-/);
    expect(refs(result)['cancellation1']).toBeUndefined();

    const lines = await orderLines(id);
    expect(lines.map((l) => [l.line_no, fromBin(l.product_id)])).toEqual([
      [1, a.id],
      [2, b.id],
      [3, c.id],
    ]);
    expect(lines[1]).toMatchObject({
      price_source: 'RULE',
      quoted_unit_price_xaf: 2500,
      list_unit_price_xaf: 2500,
      line_total_xaf: 5000,
    });
    expect(fromBin(lines[1]!.price_rule_id!)).toBe(b.ruleId);
    expect(lines[2]).toMatchObject({ quoted_unit_price_xaf: 800, line_total_xaf: 800 });
    // b est vendu (stock), c reste en attente (aucun stock).
    expect(lines.map((l) => [num(l.quantity_base), num(l.sold_quantity_base)])).toEqual([
      [2, 2],
      [2, 2],
      [1, 0],
    ]);
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    expect(sales[1]).toMatchObject({ total_xaf: 5000, status: 'CONFIRMED' });
    const complementaryLines = await saleLines(fromBin(sales[1]!.id));
    expect(complementaryLines).toHaveLength(1);
    expect(complementaryLines[0]).toMatchObject({
      price_source: 'ORDER_QUOTE',
      unit_price_xaf: 2500,
    });
    expect(fromBin(complementaryLines[0]!.order_line_id!)).toBe(fromBin(lines[1]!.id));
    expect(await orderRow(id)).toMatchObject({
      status: 'CONFIRMED',
      version: 2,
      total_estimated_xaf: 2000 + 5000 + 800,
    });
    expect(await onHandAt(b.id, storeId)).toBe(2);
    expect(await onHandAt(b.id, (await toDeliverOf())!)).toBe(2);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('5d. lignes ajoutées : produit au poids PRODUCT_NOT_ORDERABLE, remise DISCOUNT_NOT_SUPPORTED_ON_ORDER, aucune écriture', async () => {
    const a = await sellable(1000);
    const weighed = await sellable(2000, { mode: 'PER_WEIGHT' });
    const other = await sellable(1500);
    await stock(a.id, 5, 400);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(a, 2)] }, at('09:00:00'));
    const before = await snapshotOf(id, [a.id]);

    const heavy = await update(id, at('10:00:00'), {
      addedLines: [line(weighed, 1, { weightKg: 30 })],
    });
    expect(code(heavy)).toBe('PRODUCT_NOT_ORDERABLE');
    const discounted = await update(id, at('10:01:00'), {
      addedLines: [line(other, 1, { discountXaf: 100 })],
    });
    expect(code(discounted)).toBe('DISCOUNT_NOT_SUPPORTED_ON_ORDER');
    expect(await snapshotOf(id, [a.id])).toEqual(before);
    expect(await orderLines(id)).toHaveLength(1);
  });

  // --- 6. Argent payé libéré ----------------------------------------------------------------------------------

  /** Commande de 4 à 1 000, payée en entier par un acompte joint, vendue à la confirmation. */
  async function paidOrder(amountXaf: number) {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed(
      {
        customerId: customer,
        lines: [line(product, 4)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf, cashAccountId }],
      },
      at('09:00:00'),
    );
    const [sale] = await ordersSales(id);
    expect(sale).toMatchObject({ amount_paid_xaf: amountXaf, total_xaf: 4000 });
    const [orderLine] = await orderLines(id);
    return { product, customer, id, sale: sale!, orderLine: orderLine! };
  }

  it('6a. une baisse qui ramène le net sous le payé sans sort de l’argent : PAYMENT_TREATMENT_REQUIRED et aucune écriture', async () => {
    const { product, id, orderLine, sale } = await paidOrder(4000);
    const before = await snapshotOf(id, [product.id]);
    const cashBefore = await cashAccountBalance(db, cashAccountId);

    const result = await update(id, at('10:00:00'), { lines: [adjust(orderLine, 2)] });
    expect(code(result)).toBe('PAYMENT_TREATMENT_REQUIRED');
    expect(await snapshotOf(id, [product.id])).toEqual(before);
    expect(await cancellations(id)).toHaveLength(0);
    expect(await saleRow(fromBin(sale.id))).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 0,
      amount_paid_xaf: 4000,
    });
    expect(await orderRow(id)).toMatchObject({ version: 1, total_estimated_xaf: 4000 });
    expect(await onHandAt(product.id, storeId)).toBe(6);
    expect(await onHandAt(product.id, (await toDeliverOf())!)).toBe(4);
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore);
  });

  it('6b. avec CUSTOMER_CREDIT : la part libérée devient du crédit client, affectations renversées, part conservée recréée', async () => {
    const { product, customer, id, orderLine, sale } = await paidOrder(4000);
    const [payment] = await paymentsOf(customer);
    expect(payment).toMatchObject({ unallocated_xaf: 0, refunded_xaf: 0, amount_xaf: 4000 });
    const cashBefore = (await cashAccountBalance(db, cashAccountId)) ?? 0;

    const result = await update(id, at('10:00:00'), {
      lines: [adjust(orderLine, 2)],
      paymentTreatment: 'CUSTOMER_CREDIT',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellations(id);
    expect(doc).toMatchObject({
      cause: 'ORDER_ADJUSTMENT',
      status: 'APPLIED',
      cancelled_total_xaf: 2000,
      released_payment_treatment: 'CUSTOMER_CREDIT',
    });

    const [paymentAfter] = await paymentsOf(customer);
    expect(paymentAfter).toMatchObject({
      unallocated_xaf: 2000,
      refunded_xaf: 0,
      status: 'RECORDED',
    });
    const allocations = await saleAllocations(fromBin(sale.id));
    const reversed = allocations.filter((a) => a.status === 'REVERSED');
    const active = allocations.filter((a) => a.status === 'ACTIVE');
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ reversal_cause: 'SALE_CANCELLED', amount_xaf: 4000 });
    expect(reversed[0]!.reversed_at?.toISOString()).toBe(at('10:00:00'));
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ amount_xaf: 2000, reversal_cause: null });
    expect(await saleRow(fromBin(sale.id))).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 2000,
      amount_paid_xaf: 2000,
      net_total_xaf: 2000,
      payment_status: 'PAID',
    });
    // Crédit client : aucun mouvement de trésorerie, l'argent reste en caisse.
    expect(await refundMovements(fromBin(doc!.id))).toHaveLength(0);
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore);
    expect(await orderRow(id)).toMatchObject({ version: 2, total_estimated_xaf: 2000 });
    expect(await onHandAt(product.id, storeId)).toBe(8);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('6c. avec REFUND : mouvement de trésorerie sortant REFUND (SALE_REFUND), refunded_xaf et solde de caisse', async () => {
    const { product, customer, id, orderLine, sale } = await paidOrder(4000);
    const cashBefore = (await cashAccountBalance(db, cashAccountId)) ?? 0;

    const result = await update(id, at('10:00:00'), {
      lines: [adjust(orderLine, 2)],
      paymentTreatment: 'REFUND',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellations(id);
    expect(doc).toMatchObject({
      cause: 'ORDER_ADJUSTMENT',
      cancelled_total_xaf: 2000,
      released_payment_treatment: 'REFUND',
    });
    const [payment] = await paymentsOf(customer);
    expect(payment).toMatchObject({ refunded_xaf: 2000, unallocated_xaf: 0 });
    const movements = await refundMovements(fromBin(doc!.id));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      direction: 'OUT',
      movement_type: 'REFUND',
      source_doc_type: 'SALE_REFUND',
      amount_xaf: 2000,
    });
    expect(fromBin(movements[0]!.cash_account_id)).toBe(cashAccountId);
    expect(movements[0]!.occurred_at.toISOString()).toBe(at('10:00:00'));
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore - 2000);
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
    const allocations = await saleAllocations(fromBin(sale.id));
    expect(allocations.filter((a) => a.status === 'ACTIVE').map((a) => a.amount_xaf)).toEqual([
      2000,
    ]);
    expect(await saleRow(fromBin(sale.id))).toMatchObject({
      amount_paid_xaf: 2000,
      cancelled_xaf: 2000,
    });
    expect(await onHandAt(product.id, storeId)).toBe(8);
  });

  it('6d. net encore supérieur au payé : aucune part libérée, le sort de l’argent n’est pas exigé', async () => {
    const { customer, id, orderLine, sale } = await paidOrder(1500);
    const result = await update(id, at('10:00:00'), { lines: [adjust(orderLine, 2)] });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellations(id);
    expect(doc).toMatchObject({ cancelled_total_xaf: 2000, released_payment_treatment: null });
    const [payment] = await paymentsOf(customer);
    expect(payment).toMatchObject({ unallocated_xaf: 0, refunded_xaf: 0 });
    const allocations = await saleAllocations(fromBin(sale.id));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ status: 'ACTIVE', amount_xaf: 1500 });
    expect(await saleRow(fromBin(sale.id))).toMatchObject({
      amount_paid_xaf: 1500,
      cancelled_xaf: 2000,
      net_total_xaf: 2000,
    });
  });

  // --- 7. Statuts ---------------------------------------------------------------------------------------------

  it('7. commande brouillon, annulée, en partie livrée, livrée ou inconnue : ORDER_NOT_MODIFIABLE ou NOT_FOUND', async () => {
    const product = await sellable(1000);
    await stock(product.id, 20, 300);
    const customer = await newCustomer({ credit: true });

    // Brouillon : jamais confirmé.
    const draftId = freshUuid();
    const draft = await run(commercial, 'sales.order.save_draft', draftId, at('09:00:00'), {
      customerId: customer,
      fulfilmentLocationId: storeId,
      lines: [line(product, 3)],
    });
    expect(draft.status, JSON.stringify(draft)).toBe('APPLIED');
    const [draftLine] = await orderLines(draftId);
    const draftBefore = await snapshotOf(draftId, [product.id]);
    expect(code(await update(draftId, at('09:10:00'), { lines: [adjust(draftLine!, 2)] }))).toBe(
      'ORDER_NOT_MODIFIABLE',
    );
    expect(await snapshotOf(draftId, [product.id])).toEqual(draftBefore);

    // Annulée : état terminal ; une version périmée n'y change rien (rejet, pas de quarantaine).
    const cancelledId = await placed(
      { customerId: customer, lines: [line(product, 2)] },
      at('09:20:00'),
    );
    const [cancelledLine] = await orderLines(cancelledId);
    const cancelled = await run(commercial, 'sales.order.cancel', cancelledId, at('09:30:00'), {
      comment: 'Client absent',
    });
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    expect((await orderRow(cancelledId)).status).toBe('CANCELLED');
    const cancelledBefore = await snapshotOf(cancelledId, [product.id]);
    expect(
      code(await update(cancelledId, at('09:40:00'), { lines: [adjust(cancelledLine!, 5)] })),
    ).toBe('ORDER_NOT_MODIFIABLE');
    expect(
      code(
        await update(
          cancelledId,
          at('09:41:00'),
          { lines: [adjust(cancelledLine!, 5)] },
          { baseVersion: 0 },
        ),
      ),
    ).toBe('ORDER_NOT_MODIFIABLE');
    expect(await snapshotOf(cancelledId, [product.id])).toEqual(cancelledBefore);

    // En partie livrée : une livraison a eu lieu.
    const partialId = await placed(
      { customerId: customer, lines: [line(product, 4)] },
      at('10:00:00'),
    );
    const [partialLine] = await orderLines(partialId);
    await simulateDelivery(partialId, 1);
    expect((await orderRow(partialId)).status).toBe('PARTIALLY_FULFILLED');
    const partialBefore = await snapshotOf(partialId, [product.id]);
    expect(
      code(await update(partialId, at('10:30:00'), { lines: [adjust(partialLine!, 2)] })),
    ).toBe('ORDER_NOT_MODIFIABLE');
    expect(await snapshotOf(partialId, [product.id])).toEqual(partialBefore);

    // Livrée en entier.
    const fulfilledId = await placed(
      { customerId: customer, lines: [line(product, 3)] },
      at('10:40:00'),
    );
    const [fulfilledLine] = await orderLines(fulfilledId);
    await simulateDelivery(fulfilledId, 3);
    expect((await orderRow(fulfilledId)).status).toBe('FULFILLED');
    expect(
      code(await update(fulfilledId, at('11:00:00'), { lines: [adjust(fulfilledLine!, 5)] })),
    ).toBe('ORDER_NOT_MODIFIABLE');

    // Commande inconnue.
    expect(
      code(await update(freshUuid(), at('11:10:00'), { lines: [adjust(draftLine!, 1)] })),
    ).toBe('NOT_FOUND');
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 8. base_version et version ----------------------------------------------------------------------------

  it('8a. base_version : null ou égale à la version courante appliquée ; la version ne monte que par update', async () => {
    const product = await sellable(1000);
    await stock(product.id, 2, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 4)] }, at('09:00:00'));
    // place ne fait pas monter la version.
    expect((await orderRow(id)).version).toBe(1);
    expect(num((await orderLines(id))[0]!.sold_quantity_base)).toBe(2);

    // confirm_remaining qui vend le reste : la progression des ventes ne monte pas la version.
    await stock(product.id, 2, 400);
    const confirmed = await run(
      commercial,
      'sales.order.confirm_remaining',
      id,
      at('09:30:00'),
      {},
    );
    expect(confirmed.status, JSON.stringify(confirmed)).toBe('APPLIED');
    expect(refs(confirmed)['saleDocNumber']).toMatch(/^VTE-/);
    expect(num((await orderLines(id))[0]!.sold_quantity_base)).toBe(4);
    expect((await orderRow(id)).version).toBe(1);

    // base_version égale à la version courante : appliquée, version 2.
    const [ol1] = await orderLines(id);
    const equal = await update(
      id,
      at('10:00:00'),
      { lines: [adjust(ol1!, 3)] },
      { baseVersion: 1 },
    );
    expect(equal.status, JSON.stringify(equal)).toBe('APPLIED');
    expect((await orderRow(id)).version).toBe(2);
    // base_version null : aucun contrôle, version 3.
    const [ol2] = await orderLines(id);
    const unchecked = await update(id, at('10:10:00'), { lines: [adjust(ol2!, 2)] });
    expect(unchecked.status, JSON.stringify(unchecked)).toBe('APPLIED');
    expect((await orderRow(id)).version).toBe(3);
    // La version courante (3) est aussi acceptée.
    const [ol3] = await orderLines(id);
    const current = await update(
      id,
      at('10:20:00'),
      { lines: [adjust(ol3!, 1)] },
      { baseVersion: 3 },
    );
    expect(current.status, JSON.stringify(current)).toBe('APPLIED');
    expect(await orderRow(id)).toMatchObject({ version: 4, total_estimated_xaf: 1000 });
    expect(await cancellations(id)).toHaveLength(3);
  });

  it('8b. base_version périmée : quarantaine VERSION_CONFLICT, commande inchangée', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 5)] }, at('09:00:00'));
    const [ol] = await orderLines(id);
    // Premier update : la version passe à 2.
    const first = await update(id, at('09:30:00'), { lines: [adjust(ol!, 4)] });
    expect(first.status, JSON.stringify(first)).toBe('APPLIED');
    expect((await orderRow(id)).version).toBe(2);
    const before = await snapshotOf(id, [product.id]);

    // Deuxième modification saisie sur la version 1 : périmée.
    const commandId = freshUuid();
    const stale = await update(
      id,
      at('10:00:00'),
      { lines: [adjust(ol!, 2)] },
      { baseVersion: 1, commandId },
    );
    expect(stale.status, JSON.stringify(stale)).toBe('CONFLICT');
    expect(stale.conflict_id).toBeDefined();
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .selectAll()
      .where('id', '=', toBin(stale.conflict_id!))
      .executeTakeFirstOrThrow();
    expect(conflict).toMatchObject({
      conflict_type: 'VERSION_CONFLICT',
      entity_type: 'SALES_ORDER',
      owner_role: 'RESP_COMMERCIAL',
      applied: 0,
      status: 'OPEN',
    });
    expect(fromBin(conflict.entity_id)).toBe(id);
    expect(fromBin(conflict.command_id!)).toBe(commandId);
    expect(fromBin(conflict.site_id!)).toBe(siteId);
    expect(conflict.details as Record<string, unknown>).toMatchObject({
      commandType: 'sales.order.update',
      baseVersion: 1,
      serverVersion: 2,
    });
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select('status')
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    expect(inbox.status).toBe('CONFLICT');

    // Commande inchangée : quantités, version, contre-écritures.
    expect(await snapshotOf(id, [product.id])).toEqual(before);
    expect(await orderRow(id)).toMatchObject({ version: 2, total_estimated_xaf: 4000 });
    expect(await cancellations(id)).toHaveLength(1);
    // L'intention rejouée sur la version courante est appliquée.
    const retried = await update(
      id,
      at('10:10:00'),
      { lines: [adjust(ol!, 2)] },
      { baseVersion: 2 },
    );
    expect(retried.status, JSON.stringify(retried)).toBe('APPLIED');
    expect((await orderRow(id)).version).toBe(3);
  });

  // --- 9. Lieu, date, adresse ---------------------------------------------------------------------------------

  it('9a. lieu de préparation : autre emplacement du même site accepté ; autre site, virtuel, inconnu ou non commandable refusés', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 2)] }, at('09:00:00'));
    expect(fromBin((await orderRow(id)).fulfilment_location_id)).toBe(storeId);

    const toStore2 = await update(id, at('10:00:00'), { fulfilmentLocationId: store2Id });
    expect(toStore2.status, JSON.stringify(toStore2)).toBe('APPLIED');
    expect(await orderRow(id)).toMatchObject({ version: 2, status: 'CONFIRMED' });
    expect(fromBin((await orderRow(id)).fulfilment_location_id)).toBe(store2Id);
    const toPos = await update(id, at('10:10:00'), { fulfilmentLocationId: posId });
    expect(toPos.status, JSON.stringify(toPos)).toBe('APPLIED');
    expect(fromBin((await orderRow(id)).fulfilment_location_id)).toBe(posId);
    expect((await orderRow(id)).version).toBe(3);
    // Un changement de lieu seul n'écrit ni contre-écriture ni vente.
    expect(await cancellations(id)).toHaveLength(0);
    expect(await ordersSales(id)).toHaveLength(1);

    const before = await snapshotOf(id, [product.id]);
    const virtual = await db.transaction().execute((trx) => virtualLocationId(trx, 'V_CUSTOMER'));
    expect(code(await update(id, at('10:20:00'), { fulfilmentLocationId: otherSiteStoreId }))).toBe(
      'REFERENCE_INVALID',
    );
    expect(code(await update(id, at('10:21:00'), { fulfilmentLocationId: virtual }))).toBe(
      'REFERENCE_INVALID',
    );
    expect(code(await update(id, at('10:22:00'), { fulfilmentLocationId: freshUuid() }))).toBe(
      'REFERENCE_INVALID',
    );
    expect(code(await update(id, at('10:23:00'), { fulfilmentLocationId: incubatorId }))).toBe(
      'LOCATION_NOT_SELLABLE',
    );
    expect(await snapshotOf(id, [product.id])).toEqual(before);
  });

  it('9b. un changement de lieu avec une hausse : la vente complémentaire sort du nouvel emplacement', async () => {
    const product = await sellable(1000);
    await stock(product.id, 4, 300, store2Id);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 2)] }, at('09:00:00'));
    // Rien en magasin : la commande est confirmée sans vente.
    expect(await ordersSales(id)).toHaveLength(0);
    const [ol] = await orderLines(id);

    const result = await update(id, at('10:00:00'), {
      fulfilmentLocationId: store2Id,
      lines: [adjust(ol!, 3)],
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['saleDocNumber']).toMatch(/^VTE-/);
    const [sale] = await ordersSales(id);
    expect(fromBin(sale!.from_location_id)).toBe(store2Id);
    expect(sale).toMatchObject({ total_xaf: 3000, sale_type: 'ORDER' });
    expect(fromBin((await orderRow(id)).fulfilment_location_id)).toBe(store2Id);
    expect(num((await orderLines(id))[0]!.sold_quantity_base)).toBe(3);
    expect(await onHandAt(product.id, store2Id)).toBe(1);
    expect(await onHandAt(product.id, storeId)).toBe(0);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('9c. date de livraison souhaitée et adresse : posées, remplacées puis effacées (null)', async () => {
    const product = await sellable(1000);
    const customer = await newCustomer({ credit: true });
    const id = await placed(
      {
        customerId: customer,
        lines: [line(product, 2)],
        requestedDeliveryDate: '2026-10-15',
        deliveryAddress: 'Marché central',
      },
      at('09:00:00'),
    );
    expect(await orderRow(id)).toMatchObject({
      delivery_day: '2026-10-15',
      delivery_address: 'Marché central',
      version: 1,
    });

    const changed = await update(id, at('10:00:00'), {
      requestedDeliveryDate: '2026-10-20',
      deliveryAddress: 'Rue du port',
    });
    expect(changed.status, JSON.stringify(changed)).toBe('APPLIED');
    expect(await orderRow(id)).toMatchObject({
      delivery_day: '2026-10-20',
      delivery_address: 'Rue du port',
      version: 2,
    });

    const cleared = await update(id, at('10:10:00'), {
      requestedDeliveryDate: null,
      deliveryAddress: null,
    });
    expect(cleared.status, JSON.stringify(cleared)).toBe('APPLIED');
    expect(await orderRow(id)).toMatchObject({
      delivery_day: null,
      delivery_address: null,
      version: 3,
      status: 'CONFIRMED',
    });
    // Quantités et ventes inchangées par un simple changement de date ou d'adresse.
    expect(await cancellations(id)).toHaveLength(0);
    expect(await ordersSales(id)).toHaveLength(0);
    expect((await orderLines(id))[0]).toMatchObject({ line_total_xaf: 2000 });
  });

  it('9d. rien à modifier : charge vide, même lieu ou mêmes quantités — NOTHING_TO_UPDATE, version intacte', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 3)] }, at('09:00:00'));
    const [ol] = await orderLines(id);
    const before = await snapshotOf(id, [product.id]);

    expect(code(await update(id, at('10:00:00'), {}))).toBe('NOTHING_TO_UPDATE');
    expect(code(await update(id, at('10:01:00'), { fulfilmentLocationId: storeId }))).toBe(
      'NOTHING_TO_UPDATE',
    );
    expect(code(await update(id, at('10:02:00'), { lines: [adjust(ol!, 3)] }))).toBe(
      'NOTHING_TO_UPDATE',
    );
    expect(code(await update(id, at('10:03:00'), { lines: [], addedLines: [] }))).toBe(
      'NOTHING_TO_UPDATE',
    );
    expect(
      code(
        await update(id, at('10:04:00'), {
          fulfilmentLocationId: storeId,
          lines: [adjust(ol!, 3)],
        }),
      ),
    ).toBe('NOTHING_TO_UPDATE');
    expect(await snapshotOf(id, [product.id])).toEqual(before);
  });

  it('9e. mêmes valeurs de date et d’adresse que l’existant : NOTHING_TO_UPDATE, version intacte', async () => {
    const product = await sellable(1000);
    const customer = await newCustomer({ credit: true });
    const id = await placed(
      {
        customerId: customer,
        lines: [line(product, 2)],
        requestedDeliveryDate: '2026-10-15',
        deliveryAddress: 'Marché central',
      },
      at('09:00:00'),
    );
    const before = await snapshotOf(id, [product.id]);
    const same = await update(id, at('10:00:00'), {
      requestedDeliveryDate: '2026-10-15',
      deliveryAddress: 'Marché central',
    });
    expect(code(same)).toBe('NOTHING_TO_UPDATE');
    expect(await snapshotOf(id, [product.id])).toEqual(before);
    expect((await orderRow(id)).version).toBe(1);
  });

  // --- 10. Validations ------------------------------------------------------------------------------------------

  it('10a. validations des lignes : ligne inconnue, ligne citée deux fois, unité incohérente, quantité non entière — aucune écriture', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 5)] }, at('09:00:00'));
    const [ol] = await orderLines(id);
    const before = await snapshotOf(id, [product.id]);

    expect(
      code(
        await update(id, at('10:00:00'), {
          lines: [{ orderLineId: freshUuid(), quantity: 3, quantityBase: 3 }],
        }),
      ),
    ).toBe('ORDER_LINE_UNKNOWN');
    expect(
      code(await update(id, at('10:01:00'), { lines: [adjust(ol!, 4), adjust(ol!, 3)] })),
    ).toBe('LINE_INVALID');
    expect(code(await update(id, at('10:02:00'), { lines: [adjust(ol!, 3, 4)] }))).toBe(
      'QUANTITY_BASE_MISMATCH',
    );
    expect(code(await update(id, at('10:03:00'), { lines: [adjust(ol!, 3.5)] }))).toBe(
      'LINE_INVALID',
    );
    expect(code(await update(id, at('10:04:00'), { lines: [adjust(ol!, 3.0005)] }))).toBe(
      'TOO_MANY_DECIMALS',
    );
    expect(await snapshotOf(id, [product.id])).toEqual(before);
    expect((await orderRow(id)).version).toBe(1);
  });

  it('10b. produit devenu non vendable : la hausse est refusée en ligne, la baisse du même produit passe', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 3)] }, at('09:00:00'));
    const [ol] = await orderLines(id);
    await db
      .updateTable('catalog_products')
      .set({ is_sellable: 0 })
      .where('id', '=', toBin(product.id))
      .execute();

    const before = await snapshotOf(id, [product.id]);
    expect(code(await update(id, at('10:00:00'), { lines: [adjust(ol!, 5)] }))).toBe(
      'PRODUCT_NOT_SELLABLE',
    );
    expect(await snapshotOf(id, [product.id])).toEqual(before);

    // Une baisse du même produit passe : on peut toujours réduire une commande.
    const lower = await update(id, at('10:10:00'), { lines: [adjust(ol!, 2)] });
    expect(lower.status, JSON.stringify(lower)).toBe('APPLIED');
    expect(num((await orderLines(id))[0]!.quantity_base)).toBe(2);
    expect(refs(lower)['cancellation1']).toMatch(/^ANV-/);

    // Hors ligne, un produit retiré reste commandable : fait accompli (BR-VEN-030).
    const [olLower] = await orderLines(id);
    const offline = await update(
      id,
      at('10:20:00'),
      { lines: [adjust(olLower!, 3)] },
      { offline: true },
    );
    expect(offline.status, JSON.stringify(offline)).toBe('APPLIED');
    expect(num((await orderLines(id))[0]!.quantity_base)).toBe(3);
  });

  it('10c. conditionnement de vente : quantité en unité de saisie et en unité de base, prorata de la ligne', async () => {
    const product = await sellable(1000);
    await addPackaging(product, 'CARTON', 6);
    await stock(product.id, 30, 100);
    const customer = await newCustomer({ credit: true });
    const carton = (quantity: number) =>
      line(product, quantity, { unitCode: 'CARTON', quantityBase: quantity * 6 });
    const id = await placed({ customerId: customer, lines: [carton(2)] }, at('09:00:00'));
    const [ol] = await orderLines(id);
    expect(ol).toMatchObject({ unit_code: 'CARTON', line_total_xaf: 12000 });
    expect([num(ol!.quantity), num(ol!.quantity_base), num(ol!.sold_quantity_base)]).toEqual([
      2, 12, 12,
    ]);

    // Quantité en cartons incohérente avec la quantité en pièces.
    expect(code(await update(id, at('10:00:00'), { lines: [adjust(ol!, 3, 17)] }))).toBe(
      'QUANTITY_BASE_MISMATCH',
    );
    // 2 cartons → 1 carton : 6 pièces retirées, la quantité de saisie suit au prorata.
    const lower = await update(id, at('10:10:00'), { lines: [adjust(ol!, 1, 6)] });
    expect(lower.status, JSON.stringify(lower)).toBe('APPLIED');
    const [afterLower] = await orderLines(id);
    expect([
      num(afterLower!.quantity),
      num(afterLower!.quantity_base),
      num(afterLower!.sold_quantity_base),
      num(afterLower!.withdrawn_quantity_base),
    ]).toEqual([1, 6, 6, 6]);
    expect(afterLower).toMatchObject({ line_total_xaf: 6000 });
    const [doc] = await cancellations(id);
    expect(doc).toMatchObject({ cancelled_total_xaf: 6000 });
    // 1 carton → 3 cartons : 12 pièces de plus, vendues au prix convenu.
    const raise = await update(id, at('10:20:00'), { lines: [adjust(afterLower!, 3, 18)] });
    expect(raise.status, JSON.stringify(raise)).toBe('APPLIED');
    const [afterRaise] = await orderLines(id);
    expect([
      num(afterRaise!.quantity),
      num(afterRaise!.quantity_base),
      num(afterRaise!.sold_quantity_base),
    ]).toEqual([3, 18, 18]);
    expect(afterRaise).toMatchObject({ line_total_xaf: 18000 });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('10d. vente sur commande en conditionnement : la ligne de vente exprime sa quantité dans son unité (carton), pas en pièces', async () => {
    const product = await sellable(1000);
    await addPackaging(product, 'CARTON', 6);
    await stock(product.id, 30, 100);
    const customer = await newCustomer({ credit: true });
    const id = await placed(
      {
        customerId: customer,
        lines: [line(product, 2, { unitCode: 'CARTON', quantityBase: 12 })],
      },
      at('09:00:00'),
    );
    const [sale] = await ordersSales(id);
    const [saleLine] = await saleLines(fromBin(sale!.id));
    expect(saleLine).toMatchObject({ unit_code: 'CARTON', line_total_xaf: 12000 });
    expect(num(saleLine!.quantity_base)).toBe(12);
    // Dictionnaire 05-sales : `quantity` est dans l'unité de saisie (`unit_code`).
    expect(num(saleLine!.quantity)).toBe(2);
  });

  // --- 11. Portée ----------------------------------------------------------------------------------------------

  it('11. portée évaluée sur l’auteur de la commande : un autre commercial est refusé, l’auteur passe', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 4)] }, at('09:00:00'));
    const [ol] = await orderLines(id);
    expect(fromBin((await orderRow(id)).created_by)).toBe(commercial.userId);
    const before = await snapshotOf(id, [product.id]);

    const refused = await update(
      id,
      at('10:00:00'),
      { lines: [adjust(ol!, 2)] },
      { actor: otherCommercial },
    );
    expect(code(refused)).toBe('FORBIDDEN_SCOPE');
    expect(await snapshotOf(id, [product.id])).toEqual(before);

    const allowed = await update(id, at('10:10:00'), { lines: [adjust(ol!, 2)] });
    expect(allowed.status, JSON.stringify(allowed)).toBe('APPLIED');
    expect(num((await orderLines(id))[0]!.quantity_base)).toBe(2);
  });

  // --- 12. Hors ligne ----------------------------------------------------------------------------------------------

  it('12a. baisse saisie hors ligne : le document ANV est daté de la saisie, le stock revient à cette heure', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 4)] }, at('07:00:00'));
    const [ol] = await orderLines(id);

    const result = await update(id, at('08:15:00'), { lines: [adjust(ol!, 1)] }, { offline: true });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellations(id);
    expect(doc).toMatchObject({
      cause: 'ORDER_ADJUSTMENT',
      status: 'APPLIED',
      captured_offline: 1,
      cancelled_total_xaf: 3000,
    });
    expect(doc!.applied_at?.toISOString()).toBe(at('08:15:00'));
    expect(doc!.occurred_at.toISOString()).toBe(at('08:15:00'));
    const returns = await returnMoves(fromBin(doc!.id));
    expect(returns).toHaveLength(1);
    expect(returns[0]!.occurred_at.toISOString()).toBe(at('08:15:00'));
    expect(num(returns[0]!.quantity)).toBe(3);
    expect(await onHandAt(product.id, storeId)).toBe(4);
    expect(await orderRow(id)).toMatchObject({ version: 2, total_estimated_xaf: 1000 });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('12b. hausse saisie hors ligne : la vente complémentaire ne rend jamais le solde de stock négatif', async () => {
    const product = await sellable(1000);
    await stock(product.id, 2, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 1)] }, at('07:00:00'));
    expect(await onHandAt(product.id, storeId)).toBe(1);
    const [ol] = await orderLines(id);

    const result = await update(id, at('08:30:00'), { lines: [adjust(ol!, 5)] }, { offline: true });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    // Seule la pièce restante est vendue ; le reste demeure en attente, le solde reste à zéro.
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    expect(sales[1]).toMatchObject({ total_xaf: 1000, captured_offline: 1 });
    expect(sales[1]!.occurred_at.toISOString()).toBe(at('08:30:00'));
    const [after] = await orderLines(id);
    expect([num(after!.quantity_base), num(after!.sold_quantity_base)]).toEqual([5, 2]);
    expect(await onHandAt(product.id, storeId)).toBe(0);
    // Aucun solde négatif dans un emplacement physique (les emplacements virtuels, eux, sont
    // des contreparties : fournisseur et client portent le signe inverse des mouvements).
    const negative = await db
      .selectFrom('inventory_stock_balances as b')
      .innerJoin('organization_locations as l', 'l.id', 'b.location_id')
      .select(['l.location_type', 'b.qty_on_hand'])
      .where('b.product_id', '=', toBin(product.id))
      .where('b.qty_on_hand', '<', '0')
      .where('l.location_type', 'not like', 'V\\_%')
      .execute();
    expect(negative).toHaveLength(0);
    expect(await onHandAt(product.id, (await toDeliverOf())!)).toBe(2);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 13. Idempotence -----------------------------------------------------------------------------------------------

  it('13a. rejeu de la même commande de baisse : même résultat, un seul document ANV, un seul retour de stock', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 4)] }, at('09:00:00'));
    const [ol] = await orderLines(id);

    const options = { commandId: freshUuid(), deviceSeq: ++deviceSeq };
    const body = { lines: [adjust(ol!, 2)] };
    const first = await update(id, at('10:00:00'), body, options);
    expect(first.status, JSON.stringify(first)).toBe('APPLIED');
    expect(refs(first)['cancellation1']).toMatch(/^ANV-/);
    const stockAfterFirst = await onHandAt(product.id, storeId);
    const again = await update(id, at('10:00:00'), body, options);
    expect(again).toEqual(first);

    const docs = await cancellations(id);
    expect(docs).toHaveLength(1);
    expect(await returnMoves(fromBin(docs[0]!.id))).toHaveLength(1);
    expect(await onHandAt(product.id, storeId)).toBe(stockAfterFirst);
    expect(await onHandAt(product.id, storeId)).toBe(3);
    expect(await orderRow(id)).toMatchObject({ version: 2, total_estimated_xaf: 2000 });
    // Même intention, autre commande : l'état cible est déjà atteint, rien à modifier.
    const resent = await update(id, at('10:05:00'), body);
    expect(code(resent)).toBe('NOTHING_TO_UPDATE');
    expect(await cancellations(id)).toHaveLength(1);
    // Une autre enveloppe sous le même identifiant est refusée.
    const reused = await update(id, at('10:00:00'), { lines: [adjust(ol!, 1)] }, options);
    expect(code(reused)).toBe('COMMAND_ID_REUSED');
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('13b. rejeu de la même commande de hausse : même résultat, une seule vente complémentaire', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 2)] }, at('09:00:00'));
    const [ol] = await orderLines(id);

    const options = { commandId: freshUuid(), deviceSeq: ++deviceSeq };
    const body = { lines: [adjust(ol!, 4)] };
    const first = await update(id, at('10:00:00'), body, options);
    expect(first.status, JSON.stringify(first)).toBe('APPLIED');
    expect(refs(first)['saleDocNumber']).toMatch(/^VTE-/);
    const again = await update(id, at('10:00:00'), body, options);
    expect(again).toEqual(first);

    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    expect(sales.map((sale) => sale.total_xaf)).toEqual([2000, 2000]);
    expect(num((await orderLines(id))[0]!.sold_quantity_base)).toBe(4);
    expect(await onHandAt(product.id, storeId)).toBe(1);
    expect(await orderRow(id)).toMatchObject({ version: 2, total_estimated_xaf: 4000 });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 14. Autres refus de la modification --------------------------------------------------------------------

  it('14a. vente de la commande en demande d’annulation : une baisse qui l’entamerait est refusée, celle qui ne touche que l’attente passe', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const id = await placed({ customerId: customer, lines: [line(product, 5)] }, at('09:00:00'));
    const [ol] = await orderLines(id);
    const [sale] = await ordersSales(id);
    await db
      .updateTable('sales_sales')
      .set({ status: 'CANCELLATION_REQUESTED' })
      .where('id', '=', sale!.id)
      .execute();
    const before = await snapshotOf(id, [product.id]);

    // 5 → 1 entamerait le vendu : la demande en cours doit d'abord être décidée.
    expect(code(await update(id, at('10:00:00'), { lines: [adjust(ol!, 1)] }))).toBe(
      'SALE_CANCELLATION_PENDING',
    );
    expect(await snapshotOf(id, [product.id])).toEqual(before);

    // 5 → 4 ne retire que l'attente : aucune vente touchée.
    const pendingOnly = await update(id, at('10:10:00'), { lines: [adjust(ol!, 4)] });
    expect(pendingOnly.status, JSON.stringify(pendingOnly)).toBe('APPLIED');
    expect(await cancellations(id)).toHaveLength(0);
    expect(num((await orderLines(id))[0]!.quantity_base)).toBe(4);
  });

  it('14b. hausse d’un client sans crédit, déjà payé : la vente complémentaire est refusée (CREDIT_NOT_ALLOWED), commande inchangée', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: false });
    const id = await placed(
      {
        customerId: customer,
        lines: [line(product, 4)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 4000, cashAccountId }],
      },
      at('09:00:00'),
    );
    const [ol] = await orderLines(id);
    const before = await snapshotOf(id, [product.id]);

    expect(code(await update(id, at('10:00:00'), { lines: [adjust(ol!, 6)] }))).toBe(
      'CREDIT_NOT_ALLOWED',
    );
    expect(await snapshotOf(id, [product.id])).toEqual(before);
    expect(await ordersSales(id)).toHaveLength(1);
  });
});

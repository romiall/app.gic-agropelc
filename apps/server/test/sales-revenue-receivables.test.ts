/**
 * Créances, chiffre d'affaires et marges (P4-09 ; D09 BR-FIN-007, BR-FIN-042, BR-FIN-043 ; stratégie
 * finance §6.2-6.3) : CA et coût des ventes d'un lot (partage des lignes entre lots, annulations au
 * mois du retour), CA, coût et marge d'une période, quantité vendue d'un produit (objectif
 * `QTE_PRODUIT`), créances par ancienneté et tâche quotidienne des retards (`ReceivableOverdue`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  businessDayEndUtc,
  businessDayStartUtc,
  type IdGenerator,
} from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerOrderCommands } from '../src/modules/sales/application/commands/order-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerDeliveryCommands } from '../src/modules/sales/application/commands/delivery-commands.js';
import { registerPaymentCommands } from '../src/modules/sales/application/commands/payment-commands.js';
import {
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  listReceivables,
  lotRevenue,
  periodProductQuantity,
  periodRevenue,
  summarizeReceivables,
} from '../src/modules/sales/application/public/index.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  RECEIVABLES_OVERDUE_JOB_TYPE,
  ReceivablesOverdueJob,
} from '../src/modules/sales/application/jobs/receivables-overdue-job.js';
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

const NOW = '2026-10-12T18:00:00.000Z';
const DAY = '2026-10-12';
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

interface RunOptions {
  readonly offline?: boolean;
  readonly commandId?: string;
  readonly baseVersion?: number | null;
  readonly deviceSeq?: number;
}

describe('créances, CA et marges (P4-09)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let commercial: Actor;
  let zoneId: string;
  let siteId: string;
  let storeId: string;
  let categoryId: string;
  let stepId: string;
  let sourceCode: string;
  let cashAccountId: string;
  let momoAccountId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
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
        aggregate_type: aggregateType,
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
    options: { readonly service?: boolean } = {},
  ): Promise<Sellable> {
    const unit = options.service ? 'FORFAIT' : 'PIECE';
    const id = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: options.service ? 'Frais de livraison' : 'Poulet de chair',
        category_id: toBin(categoryId),
        stock_family: options.service ? 'SERVICE' : 'MARCHANDISE',
        base_unit_code: unit,
        pricing_mode: 'PER_UNIT',
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
        pricing_unit_code: unit,
        status: 'ACTIVE',
        valid_from: new Date('2026-01-01T00:00:00.000Z'),
        approved_by: toBin(admin.userId),
        approved_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: toBin(admin.userId),
      })
      .execute();
    return { id, ruleId, price, unit };
  }

  async function stock(productId: string, quantity: number, unitCost: number): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: storeId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date('2026-10-12T06:00:00.000Z'),
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

  const line = (product: Sellable, quantity: number) => ({
    productId: product.id,
    quantity,
    unitCode: product.unit,
    quantityBase: quantity,
    listUnitPriceXaf: product.price,
    priceRuleId: product.ruleId,
    unitPriceXaf: product.price,
  });

  // --- Commandes ----------------------------------------------------------------------------------

  const place = (
    body: Record<string, unknown>,
    occurredAt: string,
    options: { readonly id?: string; readonly offline?: boolean; readonly actor?: Actor } = {},
  ) => {
    const id = options.id ?? freshUuid();
    return run(
      options.actor ?? commercial,
      'sales.order.place',
      'SALES_ORDER',
      id,
      occurredAt,
      { fulfilmentLocationId: storeId, ...body },
      options.offline !== undefined ? { offline: options.offline } : {},
    ).then((result) => ({ id, result }));
  };

  /** Commande confirmée par le commercial ; la saisie doit réussir. */
  async function placed(
    body: Record<string, unknown>,
    occurredAt: string,
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const placedOrder = await place(body, occurredAt);
    expect(placedOrder.result.status, JSON.stringify(placedOrder.result)).toMatch(/^APPLIED/);
    return placedOrder;
  }

  // --- Lectures ----------------------------------------------------------------------------------

  const ordersSales = (orderId: string) =>
    db
      .selectFrom('sales_sales')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerOrderCommands(registry, idGenerator, sequences);
    registerCancelCommands(registry, decisions, idGenerator, sequences);
    registerDeliveryCommands(registry, idGenerator, sequences);
    registerPaymentCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    for (const unit of ['PIECE', 'KG', 'FORFAIT']) {
      const exists = await db
        .selectFrom('catalog_units')
        .select('code')
        .where('code', '=', unit)
        .executeTakeFirst();
      if (!exists) {
        await db
          .insertInto('catalog_units')
          .values({ code: unit, name: unit, is_count: unit === 'KG' ? 0 : 1 })
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
      const actor = async (role: string) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, { scopeType: 'GLOBAL' });
        return { userId, deviceId };
      };
      commercial = await actor(sedentary);
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
      momoAccountId = freshUuid();
      await trx
        .insertInto('finance_cash_accounts')
        .values({
          id: toBin(momoAccountId),
          code: `MOMO-${momoAccountId.slice(-10)}`,
          name: 'Orange Money entreprise',
          account_type: 'MOBILE_MONEY',
          responsible_user_id: toBin(adminId),
          created_by: toBin(adminId),
        })
        .execute();
    });
    const policyId = freshUuid();
    const policy = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      at('00:00:00'),
      {
        code: `SALE_CANCELLATION_${policyId.slice(-8)}`,
        operationType: 'SALE_CANCELLATION',
        requiresApproval: true,
        approverPermission: 'sales.sale_cancel.approve',
        approverScope: 'ALL',
      },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
    for (const operationType of ['PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE']) {
      const id = freshUuid();
      const set = await run(admin, 'approvals.policy.set', 'CONTROL_POLICY', id, at('00:00:00'), {
        code: `${operationType}_${id.slice(-8)}`,
        operationType,
        requiresApproval: true,
        approverPermission: 'sales.payment.cancel',
        approverScope: 'ALL',
      });
      expect(set.status, JSON.stringify(set)).toBe('APPLIED');
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const pay = (body: Record<string, unknown>, occurredAt: string) => {
    const id = freshUuid();
    return run(commercial, 'sales.payment.record', 'CUSTOMER_PAYMENT', id, occurredAt, {
      methodCode: 'ESPECES',
      cashAccountId,
      ...body,
    }).then((result) => ({ id, result }));
  };
  const saleRow = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirstOrThrow();

  // --- Outils ------------------------------------------------------------------------------------

  /** Produit suivi par lot (BR-STK-050). */
  async function lotProduct(price: number): Promise<Sellable> {
    const product = await sellable(price);
    await db
      .updateTable('catalog_products')
      .set({ lot_tracking: 'REQUIRED' })
      .where('id', '=', toBin(product.id))
      .execute();
    return product;
  }

  /** Lot fournisseur et réception de `quantity` pièces au coût `unitCost` (FIFO par `rankAt`). */
  async function stockInLot(
    productId: string,
    quantity: number,
    unitCost: number,
    rankAt: string,
  ): Promise<string> {
    return db.transaction().execute(async (trx) => {
      const supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Fournisseur',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(admin.userId),
        })
        .execute();
      const lotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId,
          supplierId,
          supplierLotRef: `REF-${freshUuid().slice(-8)}`,
          fallbackCode: `LOT-${freshUuid().slice(-8)}`,
          expiryDate: null,
          originId: freshUuid(),
          fifoRankAt: new Date(rankAt),
          createdBy: admin.userId,
        },
      );
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          lotId,
          quantityBase: quantity,
          fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
          toLocationId: storeId,
          moveType: 'PURCHASE_RECEIPT',
          declaredUnitCostXaf: unitCost,
          occurredAt: new Date(rankAt),
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: freshUuid(),
          createdBy: admin.userId,
          allowNegative: false,
        },
      );
      return lotId;
    });
  }
  async function orderSale(
    customerId: string,
    product: Sellable,
    quantity: number,
    hhmmss: string,
  ) {
    const { id } = await placed({ customerId, lines: [line(product, quantity)] }, at(hhmmss));
    const [sale] = await ordersSales(id);
    return fromBin(sale!.id);
  }
  const cancelSale = (saleId: string, hhmmss: string) =>
    run(commercial, 'sales.sale.cancel', 'SALE_CANCELLATION', freshUuid(), at(hhmmss), {
      saleId,
      comment: 'Erreur de saisie',
    });
  const period = {
    fromUtc: businessDayStartUtc(DAY),
    toUtc: businessDayEndUtc(DAY),
  };

  // --- 1. CA et marge d'un lot (stratégie finance §6.2) --------------------------------------------

  it('CA d’un lot : chaque ligne partagée entre ses lots au prorata, annulation retirée au mois du retour', async () => {
    const product = await lotProduct(1000);
    const l1 = await stockInLot(product.id, 4, 500, '2026-10-12T05:00:00.000Z');
    const l2 = await stockInLot(product.id, 6, 700, '2026-10-12T05:30:00.000Z');
    const customer = await newCustomer({ credit: true });
    await orderSale(customer, product, 6, '09:00:00');
    const second = await orderSale(customer, product, 3, '09:30:00');
    expect((await cancelSale(second, '09:40:00')).status).toBe('APPLIED');

    // Le coût des ventes est la valeur figée des mouvements : CMUP du produit (stratégie stock
    // §9), (4 × 500 + 6 × 700) / 10 = 620 la pièce, les lots ne servant qu'à la traçabilité.
    const revenue = await lotRevenue(db, [l1, l2]);
    expect(revenue.get(l1)).toMatchObject({
      grossRevenueXaf: 4000,
      cancelledXaf: 0,
      netRevenueXaf: 4000,
      costOfSalesXaf: 2480,
      soldQuantity: 4,
      months: [{ period: '2026-10', revenueXaf: 4000, costOfSalesXaf: 2480 }],
    });
    expect(revenue.get(l2)).toMatchObject({
      grossRevenueXaf: 5000,
      cancelledXaf: 3000,
      netRevenueXaf: 2000,
      costOfSalesXaf: 1240,
      soldQuantity: 2,
    });
    const empty = freshUuid();
    expect((await lotRevenue(db, [empty])).get(empty)).toMatchObject({
      netRevenueXaf: 0,
      months: [],
    });
  });

  // --- 2. CA, coût des ventes et marge d'une période (BR-FIN-042, 043) -----------------------------

  it('CA d’une période net des annulations de la période ; coût des ventes et marge brute', async () => {
    const product = await lotProduct(1000);
    await stockInLot(product.id, 4, 500, '2026-10-12T05:00:00.000Z');
    await stockInLot(product.id, 6, 700, '2026-10-12T05:30:00.000Z');
    const customer = await newCustomer({ credit: true });
    await orderSale(customer, product, 6, '09:00:00');
    const second = await orderSale(customer, product, 3, '09:30:00');
    expect((await cancelSale(second, '09:40:00')).status).toBe('APPLIED');

    const result = await periodRevenue(db, { ...period, customerIds: [customer] });
    expect(result).toEqual({
      grossRevenueXaf: 9000,
      cancelledXaf: 3000,
      netRevenueXaf: 6000,
      costOfSalesXaf: 3720,
      grossMarginXaf: 2280,
      saleCount: 2,
    });
    // Une période antérieure ne voit ni la vente ni l'annulation.
    expect(
      await periodRevenue(db, {
        fromUtc: businessDayStartUtc('2026-10-11'),
        toUtc: businessDayEndUtc('2026-10-11'),
        customerIds: [customer],
      }),
    ).toMatchObject({ netRevenueXaf: 0, costOfSalesXaf: 0 });
    expect(
      await periodProductQuantity(db, {
        ...period,
        productId: product.id,
        commercialUserId: commercial.userId,
      }),
    ).toBe(6);
  });

  // --- 3. Créances par ancienneté et tâche des retards (BR-FIN-007) --------------------------------

  it('créances : échéance, jours de retard et tranches ; la tâche publie un événement par vente et par jour', async () => {
    const customer = await newCustomer({ credit: true });
    const product = await sellable(1000);
    await stock(product.id, 5, 600);
    const first = await orderSale(customer, product, 2, '09:00:00');
    const second = await orderSale(customer, product, 3, '10:00:00');
    expect(
      (await pay({ customerId: customer, amountXaf: 500 }, at('11:00:00'))).result.status,
    ).toBe('APPLIED');
    const due = (await saleRow(first)).due_date as unknown as Date | string;
    expect(due).not.toBeNull();

    const today = await listReceivables(db, { today: DAY, customerIds: [customer] });
    expect(today.map((line) => [line.saleId, line.balanceDueXaf, line.overdue])).toEqual([
      [first, 1500, false],
      [second, 3000, false],
    ]);
    // 45 jours plus tard (échéance par défaut à 30 jours) : 15 jours de retard, tranche 0-30.
    const later = await listReceivables(db, {
      today: '2026-11-26',
      customerIds: [customer],
      overdueOnly: true,
    });
    expect(later.map((line) => [line.daysOverdue, line.bucket])).toEqual([
      [15, '0-30'],
      [15, '0-30'],
    ]);
    expect(summarizeReceivables(later)).toEqual({
      totalXaf: 4500,
      overdueXaf: 4500,
      count: 2,
      buckets: { '0-30': 4500, '31-60': 0, '61-90': 0, '>90': 0 },
    });

    const registry = new JobHandlerRegistry();
    const job = new ReceivablesOverdueJob(
      new FixedClock(new Date('2026-11-26T07:00:00.000Z')),
      idGenerator,
      registry,
    );
    job.onModuleInit();
    const handler = registry.resolve(RECEIVABLES_OVERDUE_JOB_TYPE)!;
    await db.transaction().execute((trx) => handler(trx, {}));
    await db.transaction().execute((trx) => handler(trx, {}));
    const events = await db
      .selectFrom('platform_domain_events')
      .select(['aggregate_id', 'payload'])
      .where('event_type', '=', 'ReceivableOverdue')
      .where('aggregate_id', 'in', [toBin(first), toBin(second)])
      .execute();
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { days_overdue: number }).days_overdue)).toEqual([
      15, 15,
    ]);
  });
});

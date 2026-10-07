/**
 * Commandes clients (P4-06, D04 §7.1, ADR-028 §4, AV-126 à AV-130) à travers le vrai pipeline :
 * confirmation par la vente du disponible, reste en attente confirmé plus tard au prix convenu,
 * acomptes, brouillon, hors ligne (intention confirmée par le serveur), refus de crédit, rejeu.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  recordStockMove,
  verifyStockLedger,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
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

const NOW = '2026-10-08T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-08T${hhmmss}.000Z`;
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

describe('sales.order.* — confirmation (P4-06)', () => {
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

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);
  const refs = (r: Result) =>
    r.status === 'APPLIED' || r.status === 'APPLIED_WITH_WARNINGS' ? (r.server_refs ?? {}) : {};

  async function run(
    actor: Actor,
    commandType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean; readonly commandId?: string } = {},
  ): Promise<Result> {
    return pipeline.handle(
      {
        command_id: options.commandId ?? freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'SALES_ORDER',
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
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
          occurredAt: new Date('2026-10-08T06:00:00.000Z'),
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

  // --- Lectures ----------------------------------------------------------------------------------

  const orderRow = (id: string) =>
    db
      .selectFrom('sales_sales_orders')
      .selectAll()
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
  const saleLines = (saleId: string) =>
    db
      .selectFrom('sales_sale_lines')
      .selectAll()
      .where('sale_id', '=', toBin(saleId))
      .orderBy('line_no')
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
      const actor = async () => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, sedentary, adminId, { scopeType: 'GLOBAL' });
        return { userId, deviceId };
      };
      commercial = await actor();
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

  // --- Vente du disponible --------------------------------------------------------------------------------

  it('commande couverte par le stock : une vente sur commande, la marchandise passe « à livrer » au coût figé', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 600);
    const customer = await newCustomer({ credit: true });
    const { id, result } = await place(
      { customerId: customer, lines: [line(product, 4)] },
      at('09:00:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['docNumber']).toMatch(/^CMD-/);
    expect(refs(result)['saleDocNumber']).toMatch(/^VTE-/);

    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CONFIRMED',
      total_estimated_xaf: 4000,
      advance_paid_xaf: 0,
      channel_code: 'SEDENTAIRE',
      captured_offline: 0,
    });
    expect(fromBin(order.commercial_user_id)).toBe(commercial.userId);
    expect(order.confirmed_at?.toISOString()).toBe(at('09:00:00'));
    const [orderLine] = await orderLines(id);
    expect(orderLine).toMatchObject({
      quoted_unit_price_xaf: 1000,
      price_source: 'RULE',
      line_total_xaf: 4000,
    });
    expect(Number(orderLine!.sold_quantity_base)).toBe(4);

    const [sale] = await ordersSales(id);
    expect(sale).toMatchObject({
      sale_type: 'ORDER',
      status: 'CONFIRMED',
      total_xaf: 4000,
      amount_paid_xaf: 0,
      balance_due_xaf: 4000,
      payment_status: 'UNPAID',
    });
    expect(sale?.occurred_at.toISOString()).toBe(at('09:00:00'));
    // Échéance depuis la confirmation : jour métier de la vente + délai du client (AV-129).
    expect(sale?.due).toBe('2026-11-07');
    const [saleLine] = await saleLines(fromBin(sale!.id));
    expect(saleLine).toMatchObject({
      price_source: 'ORDER_QUOTE',
      unit_price_xaf: 1000,
      line_total_xaf: 4000,
      cost_xaf: 2400,
      unit_cost_xaf: 600,
    });
    expect(fromBin(saleLine!.order_line_id!)).toBe(fromBin(orderLine!.id));

    // Stock : sorti du magasin, mis de côté dans l'emplacement « à livrer » du site.
    expect(await onHandAt(product.id, storeId)).toBe(6);
    const toDeliver = await toDeliverOf();
    expect(toDeliver).toBeDefined();
    expect(await onHandAt(product.id, toDeliver!)).toBe(4);
    // Le prospect est converti à la première vente confirmée.
    const customerRow = await db
      .selectFrom('crm_customers')
      .select(['stage', 'first_sale_id'])
      .where('id', '=', toBin(customer))
      .executeTakeFirstOrThrow();
    expect(customerRow.stage).toBe('CUSTOMER');
    expect(fromBin(customerRow.first_sale_id!)).toBe(fromBin(sale!.id));
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('AV-127 : stock insuffisant — vente du disponible, le reste en attente, confirmé plus tard au prix convenu', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const { id, result } = await place(
      { customerId: customer, lines: [line(product, 5)] },
      at('09:10:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    let [orderLine] = await orderLines(id);
    expect(Number(orderLine!.sold_quantity_base)).toBe(3);
    expect(Number(orderLine!.quantity_base)).toBe(5);
    expect((await orderRow(id)).status).toBe('CONFIRMED');
    expect(await onHandAt(product.id, storeId)).toBe(0);

    // Rien de nouveau en stock : la confirmation ne vend rien et n'échoue pas.
    const idle = await run(commercial, 'sales.order.confirm_remaining', id, at('10:00:00'), {});
    expect(idle.status, JSON.stringify(idle)).toBe('APPLIED');
    expect(refs(idle)['saleDocNumber']).toBeUndefined();
    expect(await ordersSales(id)).toHaveLength(1);

    // Le stock arrive : le reste se vend au prix convenu à la commande (AV-087).
    await stock(product.id, 4, 700);
    const later = await run(commercial, 'sales.order.confirm_remaining', id, at('11:00:00'), {});
    expect(later.status, JSON.stringify(later)).toBe('APPLIED');
    expect(refs(later)['saleDocNumber']).toMatch(/^VTE-/);
    [orderLine] = await orderLines(id);
    expect(Number(orderLine!.sold_quantity_base)).toBe(5);
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    expect(sales.map((sale) => Number(sale.total_xaf))).toEqual([3000, 2000]);
    expect(sales[1]!.occurred_at.toISOString()).toBe(at('11:00:00'));
    expect(await onHandAt(product.id, storeId)).toBe(2);
    // Tout est vendu : plus rien à confirmer.
    const done = await run(commercial, 'sales.order.confirm_remaining', id, at('12:00:00'), {});
    expect(refs(done)['saleDocNumber']).toBeUndefined();
    expect(await ordersSales(id)).toHaveLength(2);
  });

  it('aucun stock : la commande est confirmée sans vente (jamais refusée pour manque de stock, BR-VEN-004)', async () => {
    const product = await sellable(1000);
    const customer = await newCustomer();
    const { id, result } = await place(
      { customerId: customer, lines: [line(product, 5)] },
      at('09:20:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['saleDocNumber']).toBeUndefined();
    expect(await ordersSales(id)).toHaveLength(0);
    expect(await orderRow(id)).toMatchObject({ status: 'CONFIRMED', total_estimated_xaf: 5000 });
    // Sans vente, le prospect n'est pas converti (BR-CRM-010, ADR-028).
    const row = await db
      .selectFrom('crm_customers')
      .select('stage')
      .where('id', '=', toBin(customer))
      .executeTakeFirstOrThrow();
    expect(row.stage).toBe('PROSPECT');
  });

  it('plusieurs produits : le disponible de chacun est vendu, un mouvement et un coût par ligne', async () => {
    const a = await sellable(1000);
    const b = await sellable(2500);
    await stock(a.id, 10, 400);
    await stock(b.id, 1, 1500);
    const customer = await newCustomer({ credit: true });
    const { id, result } = await place(
      { customerId: customer, lines: [line(b, 3), line(a, 2)] },
      at('09:30:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [sale] = await ordersSales(id);
    expect(Number(sale!.total_xaf)).toBe(2500 + 2000);
    const lines = await saleLines(fromBin(sale!.id));
    expect(lines.map((l) => [Number(l.quantity_base), l.cost_xaf])).toEqual([
      [1, 1500],
      [2, 800],
    ]);
    const orderLinesRows = await orderLines(id);
    expect(
      orderLinesRows.map((l) => [Number(l.quantity_base), Number(l.sold_quantity_base)]),
    ).toEqual([
      [3, 1],
      [2, 2],
    ]);
  });

  // --- Hors ligne, brouillon, acomptes ---------------------------------------------------------------------

  it('AV-126 : commande saisie hors ligne — intention confirmée par le serveur, vente datée de la saisie, jamais de solde négatif', async () => {
    const product = await sellable(1000);
    await stock(product.id, 2, 300);
    const customer = await newCustomer({ credit: true });
    const { id, result } = await place(
      { customerId: customer, lines: [line(product, 5)] },
      at('08:15:00'),
      { offline: true },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const order = await orderRow(id);
    expect(order.captured_offline).toBe(1);
    expect(order.occurred_at.toISOString()).toBe(at('08:15:00'));
    const [sale] = await ordersSales(id);
    expect(sale?.occurred_at.toISOString()).toBe(at('08:15:00'));
    expect(sale?.captured_offline).toBe(1);
    // Seuls les 2 en stock sont vendus : le stock réel n'est jamais dépassé.
    expect(Number(sale!.total_xaf)).toBe(2000);
    expect(await onHandAt(product.id, storeId)).toBe(0);
  });

  it('brouillon : aucun effet de stock ni de chiffre d’affaires ; la confirmation reprend ses lignes et ses prix', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const draftId = freshUuid();
    const draft = await run(commercial, 'sales.order.save_draft', draftId, at('09:40:00'), {
      customerId: customer,
      fulfilmentLocationId: storeId,
      lines: [line(product, 3)],
    });
    expect(draft.status, JSON.stringify(draft)).toBe('APPLIED');
    expect(await orderRow(draftId)).toMatchObject({ status: 'DRAFT', confirmed_at: null });
    expect(await ordersSales(draftId)).toHaveLength(0);
    expect(await onHandAt(product.id, storeId)).toBe(5);

    const confirmed = await run(commercial, 'sales.order.place', draftId, at('09:50:00'), {
      customerId: customer,
      fulfilmentLocationId: storeId,
    });
    expect(confirmed.status, JSON.stringify(confirmed)).toBe('APPLIED');
    expect(await orderRow(draftId)).toMatchObject({
      status: 'CONFIRMED',
      total_estimated_xaf: 3000,
    });
    expect(await ordersSales(draftId)).toHaveLength(1);
    expect(await onHandAt(product.id, storeId)).toBe(2);
    // Un brouillon confirmé ne se reconfirme pas : rejeu = même document.
    const again = await run(commercial, 'sales.order.place', draftId, at('09:51:00'), {
      customerId: customer,
      fulfilmentLocationId: storeId,
    });
    expect(again.status).toBe('APPLIED');
    expect(await ordersSales(draftId)).toHaveLength(1);
  });

  it('acompte : affecté à la commande, passé à la vente à sa confirmation (ORDER_CONFIRMED) ; sans stock il reste sur la commande', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: true });
    const withStock = await place(
      {
        customerId: customer,
        lines: [line(product, 4)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 1500, cashAccountId }],
      },
      at('10:00:00'),
    );
    expect(withStock.result.status, JSON.stringify(withStock.result)).toBe('APPLIED');
    expect(refs(withStock.result)['payment1']).toMatch(/^ENC-/);
    const [sale] = await ordersSales(withStock.id);
    expect(sale).toMatchObject({
      amount_paid_xaf: 1500,
      balance_due_xaf: 2500,
      payment_status: 'PARTIALLY_PAID',
    });
    expect((await orderRow(withStock.id)).advance_paid_xaf).toBe(0);
    const allocations = await db
      .selectFrom('sales_payment_allocations')
      .select(['status', 'reversal_cause', 'amount_xaf', 'sale_id', 'order_id'])
      .where((eb) =>
        eb.or([eb('order_id', '=', toBin(withStock.id)), eb('sale_id', '=', sale!.id)]),
      )
      .orderBy('allocated_at')
      .orderBy('id')
      .execute();
    expect(
      allocations.map((a) => [
        a.status,
        a.reversal_cause,
        a.amount_xaf,
        a.sale_id ? 'vente' : 'commande',
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['REVERSED', 'ORDER_CONFIRMED', 1500, 'commande'],
        ['ACTIVE', null, 1500, 'vente'],
      ]),
    );

    // Sans aucun stock : pas de vente, l'acompte reste affecté à la commande.
    const empty = await sellable(1000);
    const noStock = await place(
      {
        customerId: customer,
        lines: [line(empty, 2)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 700, cashAccountId }],
      },
      at('10:10:00'),
    );
    expect(noStock.result.status, JSON.stringify(noStock.result)).toBe('APPLIED');
    expect(await ordersSales(noStock.id)).toHaveLength(0);
    expect((await orderRow(noStock.id)).advance_paid_xaf).toBe(700);
  });

  // --- Refus et rejeu ----------------------------------------------------------------------------------------

  it('crédit : client non autorisé ou plafond dépassé — la commande n’est pas créée', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const noCredit = await newCustomer({ credit: false });
    const refused = await place(
      { customerId: noCredit, lines: [line(product, 2)] },
      at('10:20:00'),
    );
    expect(code(refused.result)).toBe('CREDIT_NOT_ALLOWED');
    await expect(orderRow(refused.id)).rejects.toThrow();
    expect(await onHandAt(product.id, storeId)).toBe(10);
    // Payée par un acompte intégral : aucun crédit à contrôler.
    const paid = await place(
      {
        customerId: noCredit,
        lines: [line(product, 2)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 2000, cashAccountId }],
      },
      at('10:25:00'),
    );
    expect(paid.result.status, JSON.stringify(paid.result)).toBe('APPLIED');
    expect((await ordersSales(paid.id))[0]).toMatchObject({ payment_status: 'PAID' });
  });

  it('validations : client inconnu, produit au poids, remise, emplacement, portée, rejeu', async () => {
    const product = await sellable(1000);
    const weighed = await sellable(2000, { mode: 'PER_WEIGHT' });
    await stock(product.id, 10, 300);
    const customer = await newCustomer({ credit: true });
    expect(
      code(
        (await place({ customerId: freshUuid(), lines: [line(product, 1)] }, at('11:00:00')))
          .result,
      ),
    ).toBe('CUSTOMER_UNKNOWN');
    expect(
      code(
        (
          await place(
            { customerId: customer, lines: [line(weighed, 1, { weightKg: 30 })] },
            at('11:01:00'),
          )
        ).result,
      ),
    ).toBe('PRODUCT_NOT_ORDERABLE');
    expect(
      code(
        (
          await place(
            { customerId: customer, lines: [line(product, 1, { discountXaf: 100 })] },
            at('11:02:00'),
          )
        ).result,
      ),
    ).toBe('DISCOUNT_NOT_SUPPORTED_ON_ORDER');
    const virtual = await db.transaction().execute((trx) => virtualLocationId(trx, 'V_CUSTOMER'));
    expect(
      code(
        (
          await place(
            { customerId: customer, lines: [line(product, 1)], fulfilmentLocationId: virtual },
            at('11:03:00'),
          )
        ).result,
      ),
    ).toBe('REFERENCE_INVALID');
    const first = await place({ customerId: customer, lines: [line(product, 1)] }, at('11:05:00'));
    expect(first.result.status).toBe('APPLIED');
    const again = await place({ customerId: customer, lines: [line(product, 1)] }, at('11:05:00'), {
      id: first.id,
    });
    expect(again.result.status).toBe('APPLIED');
    expect(await ordersSales(first.id)).toHaveLength(1);
    expect(await onHandAt(product.id, storeId)).toBe(9);
  });

  it('dérogation de prix au-delà du plafond : commande enregistrée, validation demandée sur la commande', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const reasonId = freshUuid();
    await db
      .insertInto('catalog_reason_codes')
      .values({
        id: toBin(reasonId),
        code: `OVR-${reasonId.slice(-8)}`,
        category: 'PRICE_OVERRIDE',
        label: 'Gros volume',
        created_by: toBin(admin.userId),
      })
      .execute();
    // Le commercial sédentaire a un plafond de 5 % : 20 % de remise passe par une validation.
    const { id, result } = await place(
      {
        customerId: customer,
        lines: [line(product, 2, { unitPriceXaf: 800, overrideReasonCodeId: reasonId })],
      },
      at('11:30:00'),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED_WITH_WARNINGS');
    const [orderLine] = await orderLines(id);
    expect(orderLine).toMatchObject({
      price_source: 'MANUAL_OVERRIDE',
      quoted_unit_price_xaf: 800,
      list_unit_price_xaf: 1000,
    });
    expect(orderLine!.override_approval_request_id).not.toBeNull();
    const approval = await db
      .selectFrom('approvals_approval_requests')
      .select(['operation_type', 'status', 'amount_xaf', 'subject_type'])
      .where('subject_id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(approval).toMatchObject({
      operation_type: 'PRICE_OVERRIDE',
      status: 'PENDING',
      amount_xaf: 400,
      subject_type: 'SALES_ORDER',
    });
    // La vente reprend le prix convenu de la dérogation.
    const [sale] = await ordersSales(id);
    expect(Number(sale!.total_xaf)).toBe(1600);
    expect((await saleLines(fromBin(sale!.id)))[0]).toMatchObject({
      price_source: 'ORDER_QUOTE',
      unit_price_xaf: 800,
    });
  });

  // --- Revue adverse de P4-06 ------------------------------------------------------------------------

  it('place sur une commande annulée ou déjà confirmée : rejet, aucun acompte encaissé', async () => {
    const product = await sellable(1000);
    const customer = await newCustomer({ credit: true });
    const { id } = await place({ customerId: customer, lines: [line(product, 2)] }, at('09:00:00'));
    const again = await place(
      {
        customerId: customer,
        lines: [line(product, 2)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 500, cashAccountId }],
      },
      at('09:05:00'),
      { id },
    );
    expect(code(again.result)).toBe('ORDER_STATUS_INVALID');
    // Sans acompte, la même intention reste sans effet (idempotence par identifiant).
    expect(
      (await place({ customerId: customer, lines: [line(product, 2)] }, at('09:06:00'), { id }))
        .result.status,
    ).toBe('APPLIED');

    const draftId = freshUuid();
    expect(
      (
        await run(commercial, 'sales.order.save_draft', draftId, at('09:10:00'), {
          customerId: customer,
          fulfilmentLocationId: storeId,
          lines: [line(product, 1)],
        })
      ).status,
    ).toBe('APPLIED');
    const cancelled = await run(commercial, 'sales.order.cancel', draftId, at('09:11:00'), {
      comment: 'Plus besoin',
    });
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    const replaced = await place(
      {
        customerId: customer,
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 500, cashAccountId }],
      },
      at('09:12:00'),
      { id: draftId },
    );
    expect(code(replaced.result)).toBe('ORDER_ALREADY_CANCELLED');
    const payments = await db
      .selectFrom('sales_customer_payments')
      .select('id')
      .where('intended_order_id', 'in', [toBin(id), toBin(draftId)])
      .execute();
    expect(payments).toHaveLength(0);
  });

  it('brouillon saisi hors ligne : ONLINE_REQUIRED', async () => {
    const product = await sellable(1000);
    const customer = await newCustomer({ credit: true });
    const result = await run(
      commercial,
      'sales.order.save_draft',
      freshUuid(),
      at('09:20:00'),
      { customerId: customer, fulfilmentLocationId: storeId, lines: [line(product, 1)] },
      { offline: true },
    );
    expect(code(result)).toBe('ONLINE_REQUIRED');
  });

  it('stock mobile d’un autre détenteur : FORBIDDEN_SCOPE, aucun stock déplacé', async () => {
    const product = await sellable(1000);
    const customer = await newCustomer({ credit: true });
    const mobileId = freshUuid();
    await db
      .insertInto('organization_locations')
      .values({
        id: toBin(mobileId),
        site_id: toBin(siteId),
        code: mobileId.replace(/-/g, '').slice(-8).toUpperCase(),
        name: 'Stock mobile d’un autre commercial',
        location_type: 'MOBILE',
        custody_mode: 'EXCLUSIVE_USER',
        custodian_user_id: toBin(admin.userId),
        created_by: toBin(admin.userId),
      })
      .execute();
    const refused = await place(
      { customerId: customer, fulfilmentLocationId: mobileId, lines: [line(product, 1)] },
      at('09:30:00'),
    );
    expect(code(refused.result)).toBe('FORBIDDEN_SCOPE');
  });

  it('deux confirmations simultanées sur le même stock : toutes deux appliquées, le disponible n’est vendu qu’une fois', async () => {
    const product = await sellable(1000);
    await stock(product.id, 10, 300);
    const customers = [await newCustomer({ credit: true }), await newCustomer({ credit: true })];
    const results = await Promise.all(
      customers.map((customer) =>
        place({ customerId: customer, lines: [line(product, 10)] }, at('09:40:00')),
      ),
    );
    for (const { result } of results) {
      expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    }
    const sold = (await Promise.all(results.map(({ id }) => orderLines(id)))).map((lines) =>
      Number(lines[0]!.sold_quantity_base),
    );
    expect(sold.reduce((sum, value) => sum + value, 0)).toBe(10);
    expect(sold.sort()).toEqual([0, 10]);
  });
});

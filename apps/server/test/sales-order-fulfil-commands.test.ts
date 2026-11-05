/**
 * Livraison d'une commande (P4-07, UC-VEN-06, ADR-028 §7, ADR-029, AV-034, AV-133, AV-134, D04 §14,
 * SM-ORDER) à travers le vrai pipeline : `sales.order.fulfil` crée un bon de livraison `LIV` (même
 * partiel), un mouvement `DELIVERY` (« à livrer » → client) par mouvement `SALE` servi, monte les
 * compteurs « livré » et recalcule le statut de la commande, sans nouvelle vente ni chiffre
 * d'affaires. Au-delà du vendu non livré : refus en ligne ; hors ligne, vente directe de
 * régularisation et conflit `ORDER_OVER_FULFILMENT`. Paiement avant livraison (AV-511, BR-VEN-034) : une
 * commande se reçoit sans argent, elle se livre payée — refus `ORDER_NOT_PAID` en ligne, avertissement et
 * conflit `DELIVERY_UNPAID` hors ligne, paramètre `sales.delivery_requires_full_payment`.
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
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerDeliveryCommands } from '../src/modules/sales/application/commands/delivery-commands.js';
import { registerPaymentCommands } from '../src/modules/sales/application/commands/payment-commands.js';
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
  freshPhone,
} from './helpers.js';
import { customerCreditExposureXaf } from '../src/modules/sales/application/public/index.js';
import { allowDeliveryWithoutPayment, setDeliveryOnCredit } from './delivery-payment-fixtures.js';

const NOW = '2026-10-10T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-10T${hhmmss}.000Z`;
/**
 * AV-511 : le paiement avant livraison est levé sur le site d'essai (les essais livrent des commandes sans
 * les payer, pour éprouver autre chose) jusqu'à cette heure, puis rétabli : les essais de la garde
 * n'emploient que des heures postérieures.
 */
const PAYMENT_GUARD_FROM = at('16:00:00');
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

describe('sales.order.fulfil (P4-07)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let commercial: Actor;
  let otherCommercial: Actor;
  let zoneId: string;
  let siteId: string;
  let storeId: string;
  let categoryId: string;
  let stepId: string;
  let sourceCode: string;
  let cashAccountId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? (r.error?.code ?? r.status) : r.status);
  const refs = (r: Result): Record<string, string> =>
    r.status === 'APPLIED' || r.status === 'APPLIED_WITH_WARNINGS' ? (r.server_refs ?? {}) : {};
  const warningsOf = (r: Result) => (r.status === 'APPLIED_WITH_WARNINGS' ? r.warnings : []);

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
          occurredAt: new Date('2026-10-10T06:00:00.000Z'),
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
        phone_primary: await freshPhone(),
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

  const cancelOrder = (
    orderId: string,
    occurredAt: string,
    body: Record<string, unknown> = {},
    options: RunOptions & { readonly actor?: Actor } = {},
  ) =>
    run(
      options.actor ?? commercial,
      'sales.order.cancel',
      'SALES_ORDER',
      orderId,
      occurredAt,
      body,
      options,
    );

  const closeRemaining = (
    orderId: string,
    occurredAt: string,
    body: Record<string, unknown> = {},
    options: RunOptions & { readonly actor?: Actor } = {},
  ) =>
    run(
      options.actor ?? commercial,
      'sales.order.close_remaining',
      'SALES_ORDER',
      orderId,
      occurredAt,
      body,
      options,
    );

  const updateOrder = (
    orderId: string,
    occurredAt: string,
    body: Record<string, unknown>,
    options: RunOptions & { readonly actor?: Actor } = {},
  ) =>
    run(
      options.actor ?? commercial,
      'sales.order.update',
      'SALES_ORDER',
      orderId,
      occurredAt,
      body,
      options,
    );

  const confirmRemaining = (orderId: string, occurredAt: string) =>
    run(commercial, 'sales.order.confirm_remaining', 'SALES_ORDER', orderId, occurredAt, {});

  /** Annulation d'une vente (directe, ou demande si `commandType` le dit). */
  async function cancelSale(
    saleId: string,
    occurredAt: string,
    body: Record<string, unknown> = {},
    commandType = 'sales.sale.cancel',
    actor: Actor = commercial,
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(actor, commandType, 'SALE_CANCELLATION', id, occurredAt, {
      saleId,
      ...body,
    });
    return { id, result };
  }

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
  /** Documents d'annulation des ventes de la commande, toutes causes confondues. */
  const cancellationsOfOrder = (orderId: string) =>
    db
      .selectFrom('sales_sale_cancellations')
      .selectAll()
      .where(
        'sale_id',
        'in',
        db.selectFrom('sales_sales').select('id').where('order_id', '=', toBin(orderId)),
      )
      .orderBy('doc_number')
      .execute();
  async function paymentsOfOrder(orderId: string) {
    const order = await orderRow(orderId);
    return db
      .selectFrom('sales_customer_payments')
      .selectAll()
      .where('command_id', '=', order.command_id!)
      .execute();
  }
  const allocationsOf = (orderId: string, saleIds: readonly Buffer[]) =>
    db
      .selectFrom('sales_payment_allocations')
      .selectAll()
      .where((eb) =>
        saleIds.length > 0
          ? eb.or([eb('order_id', '=', toBin(orderId)), eb('sale_id', 'in', saleIds)])
          : eb('order_id', '=', toBin(orderId)),
      )
      .orderBy('allocated_at')
      .orderBy('id')
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
  const toDeliverOf = async (): Promise<string> => {
    const row = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('site_id', '=', toBin(siteId))
      .where('location_type', '=', 'V_TO_DELIVER')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  };
  const customerLocationOf = (): Promise<string> =>
    db.transaction().execute((trx) => virtualLocationId(trx, 'V_CUSTOMER'));

  /** Instantané des tables touchées : un rejet doit le laisser strictement identique. */
  async function stateOf(orderId: string) {
    const order = await orderRow(orderId);
    const lines = await orderLines(orderId);
    const sales = await ordersSales(orderId);
    const docs = await cancellationsOfOrder(orderId);
    const payments = order.command_id === null ? [] : await paymentsOfOrder(orderId);
    const allocations = await allocationsOf(
      orderId,
      sales.map((sale) => sale.id),
    );
    return {
      order: [
        order.status,
        order.version,
        Number(order.advance_paid_xaf),
        Number(order.total_estimated_xaf),
        order.released_payment_treatment,
        order.cancelled_at?.toISOString() ?? null,
        order.closed_at?.toISOString() ?? null,
      ],
      lines: lines.map((l) => [
        Number(l.quantity),
        Number(l.quantity_base),
        Number(l.sold_quantity_base),
        Number(l.withdrawn_quantity_base),
        Number(l.delivered_quantity_base),
        Number(l.line_total_xaf),
      ]),
      sales: sales.map((s) => [s.status, Number(s.cancelled_xaf), Number(s.amount_paid_xaf)]),
      docs: docs.map((d) => [d.doc_number, d.status]),
      payments: payments.map((p) => [p.status, Number(p.unallocated_xaf), Number(p.refunded_xaf)]),
      allocations: allocations.map((a) => [
        a.status,
        a.reversal_cause,
        Number(a.amount_xaf),
        a.order_id ? 'commande' : 'vente',
      ]),
    };
  }

  /** Commande de `quantity` pièces d'un produit en stock ; renvoie aussi la vente créée. */
  async function soldOrder(options: {
    readonly quantity: number;
    readonly stockQuantity?: number;
    readonly unitCost?: number;
    readonly price?: number;
    readonly credit?: boolean;
    readonly at?: string;
    readonly advanceXaf?: number;
  }) {
    const product = await sellable(options.price ?? 1000);
    await stock(product.id, options.stockQuantity ?? options.quantity, options.unitCost ?? 600);
    const customer = await newCustomer({ credit: options.credit ?? true });
    const { id } = await placed(
      {
        customerId: customer,
        lines: [line(product, options.quantity)],
        ...(options.advanceXaf !== undefined
          ? {
              advancePayments: [
                { methodCode: 'ESPECES', amountXaf: options.advanceXaf, cashAccountId },
              ],
            }
          : {}),
      },
      options.at ?? at('09:00:00'),
    );
    const [sale] = await ordersSales(id);
    return { product, customer, id, sale: sale!, saleId: fromBin(sale!.id) };
  }

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
      otherCommercial = await actor(sedentary);
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
    // Paiement avant livraison (AV-511) : levé sur le site d'essai, rétabli à partir de 16 h.
    await allowDeliveryWithoutPayment(siteId, admin.userId);
    await allowDeliveryWithoutPayment(siteId, admin.userId, true, PAYMENT_GUARD_FROM);
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
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // --- Livraison ----------------------------------------------------------------------------------

  const fulfil = (
    orderId: string,
    occurredAt: string,
    lines: readonly { readonly orderLineId: string; readonly quantityBase: number }[],
    extra: Record<string, unknown> = {},
    options: RunOptions & { readonly actor?: Actor; readonly id?: string } = {},
  ) => {
    const id = options.id ?? freshUuid();
    return run(
      options.actor ?? commercial,
      'sales.order.fulfil',
      'DELIVERY_NOTE',
      id,
      occurredAt,
      { orderId, lines, ...extra },
      options,
    ).then((result) => ({ id, result }));
  };
  const lineOf = async (orderId: string, lineNo = 1) =>
    fromBin((await orderLines(orderId)).find((l) => l.line_no === lineNo)!.id);
  const notesOf = (orderId: string) =>
    db
      .selectFrom('sales_delivery_notes')
      .selectAll()
      .where('order_id', '=', toBin(orderId))
      .orderBy('occurred_at')
      .orderBy('doc_number')
      .execute();
  const noteLines = (noteId: string) =>
    db
      .selectFrom('sales_delivery_note_lines')
      .selectAll()
      .where('delivery_note_id', '=', toBin(noteId))
      .execute();
  const deliveryMovesOf = (noteId: string) =>
    db
      .selectFrom('inventory_stock_moves')
      .selectAll()
      .where('move_type', '=', 'DELIVERY')
      .where('source_doc_id', '=', toBin(noteId))
      .execute();
  const conflictsOf = (orderId: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .selectAll()
      .where('entity_id', '=', toBin(orderId))
      .where('conflict_type', '=', 'ORDER_OVER_FULFILMENT')
      .execute();
  const deliveredOf = async (orderId: string) =>
    (await orderLines(orderId)).map((l) => [
      Number(l.quantity_base),
      Number(l.sold_quantity_base),
      Number(l.delivered_quantity_base),
    ]);

  // --- 1. Livraisons partielles puis complète ---------------------------------------------------------

  it('livraison partielle puis du reste : bons LIV, mouvements DELIVERY à la valeur figée, statut, aucun CA', async () => {
    const { product, id, saleId } = await soldOrder({ quantity: 10, unitCost: 600 });
    const orderLineId = await lineOf(id);
    const toDeliver = await toDeliverOf();
    const client = await customerLocationOf();
    const clientBefore = await onHandAt(product.id, client);

    const first = await fulfil(id, at('10:00:00'), [{ orderLineId, quantityBase: 4 }], {
      recipientName: 'Mme Ngo',
      notes: 'Remis au comptoir',
    });
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    expect(refs(first.result)['docNumber']).toMatch(/^LIV-/);
    const [note] = await notesOf(id);
    expect(fromBin(note!.id)).toBe(first.id);
    expect(note).toMatchObject({ recipient_name: 'Mme Ngo', notes: 'Remis au comptoir' });
    expect(fromBin(note!.delivered_by_user_id)).toBe(commercial.userId);
    const [noteLine] = await noteLines(first.id);
    expect(Number(noteLine!.quantity_base)).toBe(4);
    expect(fromBin(noteLine!.order_line_id)).toBe(orderLineId);
    const moves = await deliveryMovesOf(first.id);
    expect(moves).toHaveLength(1);
    expect(Number(moves[0]!.quantity)).toBe(4);
    expect(Number(moves[0]!.value_xaf)).toBe(2400);

    expect(await deliveredOf(id)).toEqual([[10, 10, 4]]);
    expect((await orderRow(id)).status).toBe('PARTIALLY_FULFILLED');
    expect((await orderRow(id)).version).toBe(1);
    const [saleLine] = await saleLines(saleId);
    expect(Number(saleLine!.delivered_quantity_base)).toBe(4);
    expect(await onHandAt(product.id, toDeliver)).toBe(6);
    expect(await onHandAt(product.id, client)).toBe(clientBefore + 4);

    const second = await fulfil(id, at('11:00:00'), [{ orderLineId, quantityBase: 6 }]);
    expect(second.result.status, JSON.stringify(second.result)).toBe('APPLIED');
    expect(refs(second.result)['docNumber']).not.toBe(refs(first.result)['docNumber']);
    expect(await deliveredOf(id)).toEqual([[10, 10, 10]]);
    expect((await orderRow(id)).status).toBe('FULFILLED');
    expect(await onHandAt(product.id, toDeliver)).toBe(0);
    // Aucune vente nouvelle, aucun chiffre d'affaires de plus : la vente date de la confirmation.
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ status: 'CONFIRMED', total_xaf: 10000, cancelled_xaf: 0 });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 2. Dépassement en ligne -------------------------------------------------------------------------

  it('en ligne, au-delà du vendu non livré : ORDER_OVER_FULFILMENT sans aucune écriture', async () => {
    const { id } = await soldOrder({ quantity: 10, stockQuantity: 6 });
    const orderLineId = await lineOf(id);
    expect(await deliveredOf(id)).toEqual([[10, 6, 0]]);
    const before = await stateOf(id);

    const over = await fulfil(id, at('10:00:00'), [{ orderLineId, quantityBase: 7 }]);
    expect(code(over.result)).toBe('ORDER_OVER_FULFILMENT');
    expect(await stateOf(id)).toEqual(before);
    expect(await notesOf(id)).toHaveLength(0);

    // Le vendu (6) se livre ; le reste en attente garde la commande ouverte.
    const ok = await fulfil(id, at('10:05:00'), [{ orderLineId, quantityBase: 6 }]);
    expect(ok.result.status, JSON.stringify(ok.result)).toBe('APPLIED');
    expect(await deliveredOf(id)).toEqual([[10, 6, 6]]);
    expect((await orderRow(id)).status).toBe('PARTIALLY_FULFILLED');
  });

  // --- 3. Plusieurs ventes sur une même ligne ---------------------------------------------------------

  it('deux ventes sur une ligne (confirmation du reste) : la plus ancienne est livrée d’abord', async () => {
    const { product, id, saleId } = await soldOrder({ quantity: 10, stockQuantity: 6 });
    await stock(product.id, 4, 700);
    const remaining = await confirmRemaining(id, at('09:30:00'));
    expect(remaining.status, JSON.stringify(remaining)).toBe('APPLIED');
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    const orderLineId = await lineOf(id);

    const delivered = await fulfil(id, at('10:00:00'), [{ orderLineId, quantityBase: 8 }]);
    expect(delivered.result.status, JSON.stringify(delivered.result)).toBe('APPLIED');
    const [oldLine] = await saleLines(saleId);
    const [newLine] = await saleLines(fromBin(sales[1]!.id));
    expect(Number(oldLine!.delivered_quantity_base)).toBe(6);
    expect(Number(newLine!.delivered_quantity_base)).toBe(2);
    expect(await noteLines(delivered.id)).toHaveLength(2);
    const moves = await deliveryMovesOf(delivered.id);
    // Valeur figée de chaque vente (coût moyen à sa date) : 6 de la première, 2 sur 4 de la seconde.
    const expectedValue = Number(oldLine!.cost_xaf) + (Number(newLine!.cost_xaf) * 2) / 4;
    expect(moves.reduce((sum, move) => sum + Number(move.value_xaf), 0)).toBe(expectedValue);
    expect(await deliveredOf(id)).toEqual([[10, 10, 8]]);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 4. Effets sur les autres commandes --------------------------------------------------------------

  it('après une livraison : modification refusée, annulation refusée, clôture du reste possible', async () => {
    const { product, id } = await soldOrder({ quantity: 10 });
    const orderLineId = await lineOf(id);
    expect(
      (await fulfil(id, at('10:00:00'), [{ orderLineId, quantityBase: 3 }])).result.status,
    ).toBe('APPLIED');
    expect(
      code(
        await updateOrder(id, at('10:10:00'), {
          lines: [{ orderLineId, quantity: 5, quantityBase: 5 }],
        }),
      ),
    ).toBe('ORDER_NOT_MODIFIABLE');
    expect(code(await cancelOrder(id, at('10:15:00'), { comment: 'Annulation' }))).toBe(
      'CANCELLATION_EXCEEDS_UNDELIVERED',
    );
    const closed = await closeRemaining(id, at('10:20:00'), { comment: 'Le client renonce' });
    expect(closed.status, JSON.stringify(closed)).toBe('APPLIED');
    expect(await deliveredOf(id)).toEqual([[3, 3, 3]]);
    expect((await orderRow(id)).status).toBe('CLOSED');
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(0);
    // Plus rien à livrer : une nouvelle livraison en ligne est refusée.
    expect(
      code((await fulfil(id, at('10:30:00'), [{ orderLineId, quantityBase: 1 }])).result),
    ).toBe('ORDER_STATUS_INVALID');
  });

  // --- 5. Hors ligne : dépassement régularisé (AV-133) ------------------------------------------------

  it('hors ligne après l’annulation du reste : vente directe de régularisation et conflit, sans bon', async () => {
    const { product, customer, id } = await soldOrder({ quantity: 6, stockQuantity: 6 });
    const orderLineId = await lineOf(id);
    const cancelled = await cancelOrder(id, at('10:00:00'), { comment: 'Annulée au bureau' });
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    expect(await onHandAt(product.id, storeId)).toBe(6);

    // Le livreur avait remis 6 pièces à 9 h 30, hors ligne ; il se synchronise à 11 h.
    const late = await fulfil(
      id,
      at('09:30:00'),
      [{ orderLineId, quantityBase: 6 }],
      {},
      { offline: true },
    );
    expect(late.result.status, JSON.stringify(late.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(late.result)).toContain('ORDER_OVER_FULFILMENT');
    expect(refs(late.result)['docNumber']).toBeUndefined();
    const saleNumber = refs(late.result)['regularisationSaleDocNumber'];
    expect(saleNumber).toMatch(/^VTE-/);
    expect(await notesOf(id)).toHaveLength(0);
    const regularisation = await db
      .selectFrom('sales_sales')
      .selectAll()
      .where('doc_number', '=', saleNumber!)
      .executeTakeFirstOrThrow();
    expect(regularisation).toMatchObject({
      sale_type: 'DIRECT',
      order_id: null,
      total_xaf: 6000,
      captured_offline: 1,
    });
    expect(fromBin(regularisation.customer_id)).toBe(customer);
    expect(regularisation.flags).toEqual(['ORDER_OVER_FULFILMENT']);
    const [regLine] = await saleLines(fromBin(regularisation.id));
    expect(regLine).toMatchObject({ unit_price_xaf: 1000, line_total_xaf: 6000, cost_xaf: 3600 });
    expect(await onHandAt(product.id, storeId)).toBe(0);
    const [conflict] = await conflictsOf(id);
    expect(conflict).toMatchObject({ owner_role: 'RESP_COMMERCIAL' });
    // La commande reste annulée : la régularisation ne la rouvre pas (AV-133, défaut (a)).
    expect((await orderRow(id)).status).toBe('CANCELLED');
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('hors ligne au-delà du reste à livrer : la part rattachable l’est, le surplus est régularisé', async () => {
    const { product, id } = await soldOrder({ quantity: 10, stockQuantity: 14 });
    const orderLineId = await lineOf(id);
    const lowered = await updateOrder(id, at('10:00:00'), {
      lines: [{ orderLineId, quantity: 4, quantityBase: 4 }],
    });
    expect(lowered.status, JSON.stringify(lowered)).toBe('APPLIED');
    expect(await onHandAt(product.id, storeId)).toBe(10);

    const late = await fulfil(
      id,
      at('09:45:00'),
      [{ orderLineId, quantityBase: 6 }],
      {},
      { offline: true },
    );
    expect(late.result.status, JSON.stringify(late.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(refs(late.result)['docNumber']).toMatch(/^LIV-/);
    expect(refs(late.result)['regularisationSaleDocNumber']).toMatch(/^VTE-/);
    expect(await deliveredOf(id)).toEqual([[4, 4, 4]]);
    expect((await orderRow(id)).status).toBe('FULFILLED');
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(0);
    expect(await onHandAt(product.id, storeId)).toBe(8);
    expect(await conflictsOf(id)).toHaveLength(1);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('hors ligne sans stock au magasin : la régularisation est appliquée en stock négatif', async () => {
    const { product, id } = await soldOrder({ quantity: 2, stockQuantity: 2 });
    const orderLineId = await lineOf(id);
    const late = await fulfil(
      id,
      at('10:00:00'),
      [{ orderLineId, quantityBase: 5 }],
      {},
      { offline: true },
    );
    expect(late.result.status, JSON.stringify(late.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(late.result)).toEqual(
      expect.arrayContaining(['ORDER_OVER_FULFILMENT', 'STOCK_NEGATIVE']),
    );
    expect(await onHandAt(product.id, storeId)).toBe(-3);
    expect(await deliveredOf(id)).toEqual([[2, 2, 2]]);
  });

  // --- 6. Rejeu et identifiant ----------------------------------------------------------------------

  it('rejeu : même command_id ou même bon → même numéro, aucun doublon', async () => {
    const { id } = await soldOrder({ quantity: 5 });
    const orderLineId = await lineOf(id);
    const commandId = freshUuid();
    const noteId = freshUuid();
    const seq = ++deviceSeq;
    const first = await fulfil(
      id,
      at('10:00:00'),
      [{ orderLineId, quantityBase: 2 }],
      {},
      { commandId, id: noteId, deviceSeq: seq },
    );
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    const replay = await fulfil(
      id,
      at('10:00:00'),
      [{ orderLineId, quantityBase: 2 }],
      {},
      { commandId, id: noteId, deviceSeq: seq },
    );
    expect(refs(replay.result)['docNumber'], JSON.stringify(replay.result)).toBe(
      refs(first.result)['docNumber'],
    );
    const again = await fulfil(
      id,
      at('10:01:00'),
      [{ orderLineId, quantityBase: 2 }],
      {},
      { id: noteId },
    );
    expect(refs(again.result)['docNumber']).toBe(refs(first.result)['docNumber']);
    expect(await notesOf(id)).toHaveLength(1);
    expect(await deliveredOf(id)).toEqual([[5, 5, 2]]);
  });

  // --- 7. Validations et portée -----------------------------------------------------------------------

  it('validations : ligne inconnue ou citée deux fois, livreur inconnu, brouillon, portée — aucune écriture', async () => {
    const { id } = await soldOrder({ quantity: 5 });
    const orderLineId = await lineOf(id);
    const before = await stateOf(id);
    expect(
      code(
        (await fulfil(id, at('10:00:00'), [{ orderLineId: freshUuid(), quantityBase: 1 }])).result,
      ),
    ).toBe('ORDER_LINE_UNKNOWN');
    expect(
      code(
        (
          await fulfil(id, at('10:00:00'), [
            { orderLineId, quantityBase: 1 },
            { orderLineId, quantityBase: 1 },
          ])
        ).result,
      ),
    ).toBe('LINE_INVALID');
    expect(
      code(
        (
          await fulfil(id, at('10:00:00'), [{ orderLineId, quantityBase: 1 }], {
            deliveredByUserId: freshUuid(),
          })
        ).result,
      ),
    ).toBe('REFERENCE_INVALID');
    expect(
      code(
        (
          await fulfil(
            id,
            at('10:00:00'),
            [{ orderLineId, quantityBase: 1 }],
            {},
            {
              actor: otherCommercial,
            },
          )
        ).result,
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      code((await fulfil(freshUuid(), at('10:00:00'), [{ orderLineId, quantityBase: 1 }])).result),
    ).toBe('ORDER_NOT_FOUND');
    expect(await stateOf(id)).toEqual(before);
    expect(await notesOf(id)).toHaveLength(0);

    const product = await sellable(1000);
    const customer = await newCustomer({ credit: true });
    const draftId = freshUuid();
    const draft = await run(
      commercial,
      'sales.order.save_draft',
      'SALES_ORDER',
      draftId,
      at('09:00:00'),
      {
        customerId: customer,
        fulfilmentLocationId: storeId,
        lines: [line(product, 2)],
      },
    );
    expect(draft.status, JSON.stringify(draft)).toBe('APPLIED');
    expect(
      code(
        (
          await fulfil(draftId, at('10:00:00'), [
            { orderLineId: await lineOf(draftId), quantityBase: 1 },
          ])
        ).result,
      ),
    ).toBe('ORDER_STATUS_INVALID');
  });

  it('une demande d’annulation en cours sur la vente : livraison refusée en ligne', async () => {
    const { id, saleId } = await soldOrder({ quantity: 4 });
    const requested = await cancelSale(
      saleId,
      at('09:10:00'),
      { comment: 'Demande' },
      'sales.sale.request_cancellation',
    );
    expect(requested.result.status, JSON.stringify(requested.result)).toBe('APPLIED');
    expect(
      code(
        (await fulfil(id, at('10:00:00'), [{ orderLineId: await lineOf(id), quantityBase: 1 }]))
          .result,
      ),
    ).toBe('SALE_CANCELLATION_PENDING');
  });

  // --- 8. Ligne de service ----------------------------------------------------------------------------

  it('ligne de service (frais de livraison) : livrée sans mouvement de stock', async () => {
    const goods = await sellable(1000);
    const service = await sellable(2000, { service: true });
    await stock(goods.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const { id } = await placed(
      { customerId: customer, lines: [line(goods, 3), line(service, 1)] },
      at('09:00:00'),
    );
    const delivered = await fulfil(id, at('10:00:00'), [
      { orderLineId: await lineOf(id, 1), quantityBase: 3 },
      { orderLineId: await lineOf(id, 2), quantityBase: 1 },
    ]);
    expect(delivered.result.status, JSON.stringify(delivered.result)).toBe('APPLIED');
    expect(await noteLines(delivered.id)).toHaveLength(2);
    expect(await deliveryMovesOf(delivered.id)).toHaveLength(1);
    expect((await orderRow(id)).status).toBe('FULFILLED');
  });

  // --- 9. Paiement avant livraison (AV-511, BR-VEN-034) -----------------------------------------------
  // Le paiement avant livraison est levé sur le site d'essai jusqu'à 16 h puis rétabli : ces essais
  // n'emploient que des heures de l'après-midi.

  const reason = (r: Result) => (r.status === 'REJECTED' ? (r.error?.message_fr ?? '') : '');
  const conflictsOfType = (orderId: string, type: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .selectAll()
      .where('entity_id', '=', toBin(orderId))
      .where('conflict_type', '=', type)
      .execute();

  it('AV-511 : en ligne, une vente non payée ou payée en partie n’est pas livrée à un client sans crédit (ORDER_NOT_PAID), sans aucune écriture', async () => {
    const unpaid = await soldOrder({ quantity: 4, credit: false, at: at('16:10:00') });
    const unpaidLine = await lineOf(unpaid.id);
    const before = await stateOf(unpaid.id);
    const refused = await fulfil(unpaid.id, at('16:20:00'), [
      { orderLineId: unpaidLine, quantityBase: 4 },
    ]);
    expect(code(refused.result)).toBe('ORDER_NOT_PAID');
    expect(reason(refused.result)).toContain('4 000 F CFA');
    expect(reason(refused.result)).toContain(unpaid.sale.doc_number);
    // Le client n'a pas droit au crédit (AV-512) : le message le dit.
    expect(reason(refused.result)).toContain('Ce client n’a pas droit au crédit');
    expect(await stateOf(unpaid.id)).toEqual(before);
    expect(await notesOf(unpaid.id)).toHaveLength(0);
    expect(await deliveredOf(unpaid.id)).toEqual([[4, 4, 0]]);

    // Payée en partie : le reste dû est ce qui manque.
    const partial = await soldOrder({
      quantity: 4,
      credit: false,
      advanceXaf: 1500,
      at: at('16:30:00'),
    });
    const refusedPartial = await fulfil(partial.id, at('16:35:00'), [
      { orderLineId: await lineOf(partial.id), quantityBase: 4 },
    ]);
    expect(code(refusedPartial.result)).toBe('ORDER_NOT_PAID');
    expect(reason(refusedPartial.result)).toContain('2 500 F CFA');
    expect(await notesOf(partial.id)).toHaveLength(0);
  });

  it('AV-511 : payée en entier — par l’acompte ou par un encaissement ultérieur — la vente se livre, sans signalement', async () => {
    const advanced = await soldOrder({
      quantity: 4,
      credit: false,
      advanceXaf: 4000,
      at: at('16:40:00'),
    });
    const byAdvance = await fulfil(advanced.id, at('16:42:00'), [
      { orderLineId: await lineOf(advanced.id), quantityBase: 4 },
    ]);
    expect(byAdvance.result.status, JSON.stringify(byAdvance.result)).toBe('APPLIED');
    expect((await orderRow(advanced.id)).status).toBe('FULFILLED');
    expect(await conflictsOfType(advanced.id, 'DELIVERY_UNPAID')).toHaveLength(0);

    // Il paye, on reçoit sa transaction, et on le livre : refus, encaissement ciblé, puis livraison.
    const later = await soldOrder({ quantity: 4, credit: false, at: at('16:44:00') });
    const laterLine = await lineOf(later.id);
    expect(
      code(
        (await fulfil(later.id, at('16:45:00'), [{ orderLineId: laterLine, quantityBase: 4 }]))
          .result,
      ),
    ).toBe('ORDER_NOT_PAID');
    const payment = await run(
      commercial,
      'sales.payment.record',
      'CUSTOMER_PAYMENT',
      freshUuid(),
      at('16:46:00'),
      {
        customerId: later.customer,
        methodCode: 'ESPECES',
        amountXaf: 4000,
        cashAccountId,
        allocations: [{ saleId: later.saleId, amountXaf: 4000 }],
      },
    );
    expect(payment.status, JSON.stringify(payment)).toMatch(/^APPLIED/);
    expect((await ordersSales(later.id))[0]).toMatchObject({
      balance_due_xaf: 0,
      payment_status: 'PAID',
    });
    const delivered = await fulfil(later.id, at('16:47:00'), [
      { orderLineId: laterLine, quantityBase: 4 },
    ]);
    expect(delivered.result.status, JSON.stringify(delivered.result)).toBe('APPLIED');
    expect((await orderRow(later.id)).status).toBe('FULFILLED');
  });

  it('AV-511 : chaque vente qui fournit la marchandise doit être payée — la part de la vente payée se livre, pas celle d’une vente non payée', async () => {
    const { product, id } = await soldOrder({
      quantity: 10,
      stockQuantity: 6,
      advanceXaf: 6000,
      credit: false,
      at: at('16:50:00'),
    });
    const orderLineId = await lineOf(id);
    // La vente du disponible (6 pièces) est payée par l'acompte ; le reste attend du stock.
    expect((await ordersSales(id))[0]).toMatchObject({ payment_status: 'PAID' });
    await stock(product.id, 4, 600);
    const restConfirmed = await confirmRemaining(id, at('16:52:00'));
    expect(restConfirmed.status, JSON.stringify(restConfirmed)).toBe('APPLIED');
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    expect(sales[1]).toMatchObject({ total_xaf: 4000, balance_due_xaf: 4000 });

    // 7 pièces : 6 de la première vente (payée) et 1 de la seconde (non payée) — l'ensemble est refusé.
    const refused = await fulfil(id, at('16:54:00'), [{ orderLineId, quantityBase: 7 }]);
    expect(code(refused.result)).toBe('ORDER_NOT_PAID');
    expect(reason(refused.result)).toContain(sales[1]!.doc_number);
    expect(reason(refused.result)).not.toContain(sales[0]!.doc_number);
    expect(await notesOf(id)).toHaveLength(0);

    // 6 pièces : toute la première vente, payée.
    const first = await fulfil(id, at('16:56:00'), [{ orderLineId, quantityBase: 6 }]);
    expect(first.result.status, JSON.stringify(first.result)).toBe('APPLIED');
    // Les 4 dernières viennent de la seconde vente, non payée : refusées.
    expect(
      code((await fulfil(id, at('16:58:00'), [{ orderLineId, quantityBase: 4 }])).result),
    ).toBe('ORDER_NOT_PAID');
    expect(await deliveredOf(id)).toEqual([[10, 10, 6]]);
  });

  it('AV-511 : hors ligne, la remise a eu lieu — appliquée, avertissement DELIVERY_UNPAID et conflit informatif pour la Finance', async () => {
    const { id, sale } = await soldOrder({
      quantity: 4,
      credit: false,
      advanceXaf: 1000,
      at: at('17:05:00'),
    });
    const orderLineId = await lineOf(id);
    const delivered = await fulfil(
      id,
      at('17:10:00'),
      [{ orderLineId, quantityBase: 4 }],
      {},
      { offline: true },
    );
    expect(delivered.result.status, JSON.stringify(delivered.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(delivered.result)).toEqual(['DELIVERY_UNPAID']);
    expect(await notesOf(id)).toHaveLength(1);
    expect(await deliveredOf(id)).toEqual([[4, 4, 4]]);
    expect((await orderRow(id)).status).toBe('FULFILLED');

    const conflicts = await conflictsOfType(id, 'DELIVERY_UNPAID');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      owner_role: 'FINANCE',
      applied: 1,
      entity_type: 'SALES_ORDER',
      status: 'OPEN',
    });
    expect(conflicts[0]!.details).toMatchObject({
      orderDocNumber: (await orderRow(id)).doc_number,
      deliveryNoteId: delivered.id,
      sales: [{ saleId: fromBin(sale.id), docNumber: sale.doc_number, balanceDueXaf: 3000 }],
    });
    // La vente reste due : elle figure aux créances, la Finance relance.
    expect((await ordersSales(id))[0]).toMatchObject({ balance_due_xaf: 3000 });
  });

  it('AV-511 : paramètre du site levé — une commande non payée se livre sans refus ni signalement ; une valeur mal formée maintient l’exigence', async () => {
    // Avant 16 h, le site d'essai a le paramètre à faux : aucune exigence.
    const lifted = await soldOrder({ quantity: 4, credit: false, at: at('12:00:00') });
    const liftedDelivery = await fulfil(lifted.id, at('12:10:00'), [
      { orderLineId: await lineOf(lifted.id), quantityBase: 4 },
    ]);
    expect(liftedDelivery.result.status, JSON.stringify(liftedDelivery.result)).toBe('APPLIED');
    expect(await conflictsOfType(lifted.id, 'DELIVERY_UNPAID')).toHaveLength(0);

    // À partir de 17 h 30, la valeur du site est une chaîne : elle est ignorée, l'exigence demeure.
    await allowDeliveryWithoutPayment(siteId, admin.userId, 'non', at('17:30:00'));
    const malformed = await soldOrder({ quantity: 4, credit: false, at: at('17:35:00') });
    expect(
      code(
        (
          await fulfil(malformed.id, at('17:40:00'), [
            { orderLineId: await lineOf(malformed.id), quantityBase: 4 },
          ])
        ).result,
      ),
    ).toBe('ORDER_NOT_PAID');
  });

  // --- 10. Livraison à crédit d'un client autorisé (AV-512) ------------------------------------------------
  // Un client autorisé au crédit est livré avant d'avoir payé, dans son plafond : la livraison est un crédit
  // accordé, contrôlé (`creditCheck`) sur son encours de crédit, le seul remis non payé. Heures de 17 h 41 à
  // 17 h 59, paiement avant livraison exigé (rétabli à 16 h).

  /** Commande d'un client donné : un produit neuf, le stock, la commande confirmée, sa vente. */
  async function creditOrder(customerId: string, quantity: number, when: string) {
    const product = await sellable(1000);
    await stock(product.id, quantity, 600);
    const { id } = await placed({ customerId, lines: [line(product, quantity)] }, when);
    const [sale] = await ordersSales(id);
    return { id, sale: sale!, saleId: fromBin(sale!.id), orderLineId: await lineOf(id) };
  }
  const setLimit = (customerId: string, limitXaf: number | null) =>
    db
      .updateTable('crm_customers')
      .set({ credit_limit_xaf: limitXaf })
      .where('id', '=', toBin(customerId))
      .execute();
  /** Encaissement ciblé sur une vente, comme le fait « Encaisser le reste dû ». */
  async function payInFull(customerId: string, saleId: string, amountXaf: number, when: string) {
    const payment = await run(
      commercial,
      'sales.payment.record',
      'CUSTOMER_PAYMENT',
      freshUuid(),
      when,
      {
        customerId,
        methodCode: 'ESPECES',
        amountXaf,
        cashAccountId,
        allocations: [{ saleId, amountXaf }],
      },
    );
    expect(payment.status, JSON.stringify(payment)).toMatch(/^APPLIED/);
  }
  const exposureOf = (customerId: string) => customerCreditExposureXaf(db, customerId);

  it('AV-512 : un client autorisé au crédit est livré à crédit dans son plafond — sans refus ni signalement, la vente reste due', async () => {
    const customer = await newCustomer({ credit: true });
    const order = await creditOrder(customer, 4, at('17:41:00'));
    // Commandée, vendue, pas livrée : rien n'est encore un crédit (AV-512).
    expect(await exposureOf(customer)).toBe(0);

    const delivered = await fulfil(order.id, at('17:41:30'), [
      { orderLineId: order.orderLineId, quantityBase: 4 },
    ]);
    expect(delivered.result.status, JSON.stringify(delivered.result)).toBe('APPLIED');
    expect(warningsOf(delivered.result)).toEqual([]);
    expect(await conflictsOfType(order.id, 'DELIVERY_UNPAID')).toHaveLength(0);
    expect((await orderRow(order.id)).status).toBe('FULFILLED');
    // La vente reste due (créance) et la marchandise remise est devenue un crédit accordé.
    expect((await ordersSales(order.id))[0]).toMatchObject({
      balance_due_xaf: 4000,
      payment_status: 'UNPAID',
    });
    expect(await exposureOf(customer)).toBe(4000);
  });

  it('AV-512 : plafond dépassé ou absent — CREDIT_LIMIT_EXCEEDED en ligne sans écriture ; hors ligne, appliquée et signalée avec le motif', async () => {
    const customer = await newCustomer({ credit: true });
    await setLimit(customer, 3000);
    const order = await creditOrder(customer, 4, at('17:42:00'));
    const before = await stateOf(order.id);
    const refused = await fulfil(order.id, at('17:42:20'), [
      { orderLineId: order.orderLineId, quantityBase: 4 },
    ]);
    expect(code(refused.result)).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(reason(refused.result)).toContain('Plafond de crédit du client dépassé');
    expect(reason(refused.result)).toContain('4 000 F CFA pour un plafond de 3 000 F CFA');
    expect(reason(refused.result)).toContain(order.sale.doc_number);
    expect(await stateOf(order.id)).toEqual(before);
    expect(await notesOf(order.id)).toHaveLength(0);

    // Hors ligne : la remise a eu lieu, elle est appliquée ; le conflit porte le motif et les chiffres.
    const offline = await fulfil(
      order.id,
      at('17:42:40'),
      [{ orderLineId: order.orderLineId, quantityBase: 4 }],
      {},
      { offline: true },
    );
    expect(offline.result.status, JSON.stringify(offline.result)).toBe('APPLIED_WITH_WARNINGS');
    expect(warningsOf(offline.result)).toEqual(['DELIVERY_UNPAID']);
    const [conflict] = await conflictsOfType(order.id, 'DELIVERY_UNPAID');
    expect(conflict).toMatchObject({ owner_role: 'FINANCE', applied: 1 });
    expect(conflict!.details).toMatchObject({
      reason: 'CREDIT_LIMIT_EXCEEDED',
      creditLimitXaf: 3000,
      exposureBeforeXaf: 0,
      newCreditXaf: 4000,
    });

    // Autorisé au crédit mais sans plafond défini : tout crédit dépasse (BR-VEN-025), même refus en ligne.
    const unlimited = await newCustomer({ credit: true });
    await setLimit(unlimited, null);
    const noLimit = await creditOrder(unlimited, 2, at('17:43:00'));
    const refusedNoLimit = await fulfil(noLimit.id, at('17:43:20'), [
      { orderLineId: noLimit.orderLineId, quantityBase: 2 },
    ]);
    expect(code(refusedNoLimit.result)).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(reason(refusedNoLimit.result)).toContain('sans plafond défini');
    expect(await notesOf(noLimit.id)).toHaveLength(0);
  });

  it('AV-512 : l’encours de crédit ne compte que le remis non payé — une commande non livrée n’en est pas un, le payé s’impute sur le livré', async () => {
    const customer = await newCustomer({ credit: true });
    await setLimit(customer, 5000);
    const first = await creditOrder(customer, 3, at('17:44:00'));
    const second = await creditOrder(customer, 3, at('17:44:05'));
    // Deux commandes de 3 000 non livrées : aucun crédit accordé, l'encours de crédit est nul.
    expect(await exposureOf(customer)).toBe(0);

    // La première, livrée : 3 000 de crédit, dans le plafond de 5 000 (la seconde, non livrée, ne compte pas).
    const firstDelivery = await fulfil(first.id, at('17:44:10'), [
      { orderLineId: first.orderLineId, quantityBase: 3 },
    ]);
    expect(firstDelivery.result.status, JSON.stringify(firstDelivery.result)).toBe('APPLIED');
    expect(await exposureOf(customer)).toBe(3000);

    // La seconde porterait l'encours à 6 000 : refusée tant que la première n'est pas payée.
    const blocked = await fulfil(second.id, at('17:44:20'), [
      { orderLineId: second.orderLineId, quantityBase: 3 },
    ]);
    expect(code(blocked.result)).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(reason(blocked.result)).toContain('6 000 F CFA pour un plafond de 5 000 F CFA');
    expect(await notesOf(second.id)).toHaveLength(0);

    // La première payée : l'encours retombe à 0, la seconde se livre.
    await payInFull(customer, first.saleId, 3000, at('17:44:30'));
    expect(await exposureOf(customer)).toBe(0);
    const secondDelivery = await fulfil(second.id, at('17:44:40'), [
      { orderLineId: second.orderLineId, quantityBase: 3 },
    ]);
    expect(secondDelivery.result.status, JSON.stringify(secondDelivery.result)).toBe('APPLIED');
    expect(await exposureOf(customer)).toBe(3000);

    // Livraisons partielles d'une même vente : le crédit se compte à la quantité remise, au franc près.
    const partial = await newCustomer({ credit: true });
    await setLimit(partial, 6000);
    const big = await creditOrder(partial, 10, at('17:45:00'));
    const part = (quantityBase: number, when: string) =>
      fulfil(big.id, when, [{ orderLineId: big.orderLineId, quantityBase }]);
    expect((await part(4, at('17:45:10'))).result.status).toBe('APPLIED');
    expect(await exposureOf(partial)).toBe(4000);
    // 4 000 + 3 000 > 6 000 : refusé ; 4 000 + 2 000 = 6 000, pile le plafond : accordé.
    expect(code((await part(3, at('17:45:20'))).result)).toBe('CREDIT_LIMIT_EXCEEDED');
    expect((await part(2, at('17:45:30'))).result.status).toBe('APPLIED');
    expect(await exposureOf(partial)).toBe(6000);
    // 2 000 payés s'imputent sur le livré : l'encours tombe à 4 000, 2 000 de plus de marchandise passent.
    await payInFull(partial, big.saleId, 2000, at('17:45:40'));
    expect(await exposureOf(partial)).toBe(4000);
    expect((await part(2, at('17:45:50'))).result.status).toBe('APPLIED');
    expect(await exposureOf(partial)).toBe(6000);
    expect(await deliveredOf(big.id)).toEqual([[10, 10, 8]]);
  });

  it('AV-512 : paramètre `sales.delivery_on_credit_allowed` faux — un client autorisé au crédit paie d’abord, comme un client sans crédit', async () => {
    // À partir de 17 h 50, le site d'essai n'accorde plus de livraison à crédit.
    await setDeliveryOnCredit(siteId, admin.userId, false, at('17:50:00'));
    const customer = await newCustomer({ credit: true });
    const order = await creditOrder(customer, 4, at('17:51:00'));
    const refused = await fulfil(order.id, at('17:51:20'), [
      { orderLineId: order.orderLineId, quantityBase: 4 },
    ]);
    expect(code(refused.result)).toBe('ORDER_NOT_PAID');
    // Le paiement est exigé de tous : le message ne parle pas du droit au crédit.
    expect(reason(refused.result)).not.toContain('droit au crédit');
    expect(await notesOf(order.id)).toHaveLength(0);

    // Payée en entier, elle se livre.
    await payInFull(customer, order.saleId, 4000, at('17:51:40'));
    const delivered = await fulfil(order.id, at('17:51:50'), [
      { orderLineId: order.orderLineId, quantityBase: 4 },
    ]);
    expect(delivered.result.status, JSON.stringify(delivered.result)).toBe('APPLIED');
  });
});

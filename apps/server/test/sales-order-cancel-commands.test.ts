/**
 * Annulation d'une commande et clôture de son reste (P4-06, D04 §7.1 BR-VEN-009, ADR-028 §5 et §6,
 * ADR-029 §10, AV-128, AV-146, SM-ORDER, SM-SALE) à travers le vrai pipeline : `sales.order.cancel`
 * (commande `DRAFT` ou `CONFIRMED`, avant toute livraison), `sales.order.close_remaining` (commande
 * en partie livrée), contre-écritures par document `ANV` (un par vente touchée), libération de
 * l'acompte et de la part payée (crédit client ou remboursement), répercussion de l'annulation d'une
 * vente (`sales.sale.cancel`, validation) sur sa commande, demandes d'annulation en cours, rejeu et
 * saisie hors ligne.
 *
 * La commande de livraison (`sales.delivery.record`, P4-07) n'existe pas encore : une livraison est
 * simulée par `deliverSoldGoods` (API publique d'inventory) puis par les compteurs « livré » des
 * lignes de vente et de commande, écrits en un seul `UPDATE` chacun.
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
import {
  deliverSoldGoods,
  recordStockMove,
  soldGoodsPosition,
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
} from './helpers.js';

const NOW = '2026-10-09T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-09T${hhmmss}.000Z`;
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

describe('sales.order.cancel / close_remaining (P4-06)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let commercial: Actor;
  let otherCommercial: Actor;
  let manager: Actor;
  let finance: Actor;
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
          occurredAt: new Date('2026-10-09T06:00:00.000Z'),
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

  async function reasonCode(label = 'Client injoignable'): Promise<{ id: string; label: string }> {
    const id = freshUuid();
    await db
      .insertInto('catalog_reason_codes')
      .values({
        id: toBin(id),
        code: `CAN-${id.slice(-8)}`,
        category: 'CANCELLATION',
        label,
        created_by: toBin(admin.userId),
      })
      .execute();
    return { id, label };
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
  const saleRow = (id: string) =>
    db.selectFrom('sales_sales').selectAll().where('id', '=', toBin(id)).executeTakeFirstOrThrow();
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
  const cancellationLines = (cancellationId: Buffer) =>
    db
      .selectFrom('sales_sale_cancellation_lines')
      .selectAll()
      .where('cancellation_id', '=', cancellationId)
      .orderBy('id')
      .execute();
  const returnMovesOf = async (docs: readonly { readonly id: Buffer }[]) =>
    docs.length === 0
      ? []
      : db
          .selectFrom('inventory_stock_moves')
          .selectAll()
          .where('move_type', '=', 'CUSTOMER_RETURN')
          .where('source_doc_type', '=', 'SALE_CANCELLATION')
          .where(
            'source_doc_id',
            'in',
            docs.map((doc) => doc.id),
          )
          .execute();
  const cashMovementsOf = (sourceDocId: string) =>
    db
      .selectFrom('finance_cash_movements')
      .selectAll()
      .where('source_doc_id', '=', toBin(sourceDocId))
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
  const customerRow = (id: string) =>
    db
      .selectFrom('crm_customers')
      .select(['stage', 'first_sale_id', 'conversion_reverted'])
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
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

  /**
   * Simule une livraison (la commande `sales.delivery.record` est le travail de P4-07) : mouvement
   * `DELIVERY` rattaché à la vente, puis compteurs « livré » de la ligne de vente et de la ligne de
   * commande (un seul `UPDATE` chacun), enfin statut dérivé de la commande. Une seule vente par
   * ligne de commande.
   */
  async function deliver(
    orderId: string,
    orderLineNo: number,
    quantity: number,
    status: 'PARTIALLY_FULFILLED' | 'FULFILLED' = 'PARTIALLY_FULFILLED',
  ): Promise<void> {
    const orderLine = (await orderLines(orderId)).find((l) => l.line_no === orderLineNo)!;
    const saleLine = await db
      .selectFrom('sales_sale_lines')
      .selectAll()
      .where('order_line_id', '=', orderLine.id)
      .executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await deliverSoldGoods(
        trx,
        { idGenerator },
        {
          saleId: fromBin(saleLine.sale_id),
          saleLineId: fromBin(saleLine.id),
          quantityBase: quantity,
          sourceDocId: freshUuid(),
          occurredAt: new Date(at('10:00:00')),
          createdBy: admin.userId,
        },
      );
      await trx
        .updateTable('sales_sale_lines')
        .set({
          delivered_quantity_base: String(Number(saleLine.delivered_quantity_base) + quantity),
        })
        .where('id', '=', saleLine.id)
        .execute();
      await trx
        .updateTable('sales_sales_order_lines')
        .set({
          delivered_quantity_base: String(Number(orderLine.delivered_quantity_base) + quantity),
        })
        .where('id', '=', orderLine.id)
        .execute();
      await trx
        .updateTable('sales_sales_orders')
        .set({ status })
        .where('id', '=', toBin(orderId))
        .execute();
    });
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
    const financeRole = await roleId('FINANCE');
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
      finance = await actor(financeRole);
      // Le Resp. commercial d'un autre périmètre : annulation et clôture sur toute commande (portée ALL).
      const managerRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, managerRole, 'sales.order.cancel', adminId);
      manager = await actor(managerRole);
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

  /** Identifiant de la demande de validation d'une annulation de vente. */
  const approvalOf = async (cancellationId: string): Promise<string> => {
    const approval = await db
      .selectFrom('approvals_approval_requests')
      .select('id')
      .where('subject_id', '=', toBin(cancellationId))
      .executeTakeFirstOrThrow();
    return fromBin(approval.id);
  };
  const decide = (kind: 'approve' | 'reject', requestId: string, occurredAt: string) =>
    run(
      finance,
      `approvals.request.${kind}`,
      'APPROVAL_REQUEST',
      requestId,
      occurredAt,
      kind === 'reject' ? { requestId, comment: 'Vente conforme' } : { requestId },
    );

  // --- 1. Annulation d'une commande entièrement vendue -------------------------------------------------

  it('cancel d’une commande CONFIRMED vendue : un document ANV par vente, stock rendu, ligne retirée, commande CANCELLED', async () => {
    const { product, customer, id, saleId, sale } = await soldOrder({
      quantity: 4,
      stockQuantity: 10,
      unitCost: 600,
    });
    const reason = await reasonCode();
    const before = await orderRow(id);
    const toDeliver = await toDeliverOf();
    expect(await onHandAt(product.id, storeId)).toBe(6);
    expect(await onHandAt(product.id, toDeliver)).toBe(4);
    const [saleLineBefore] = await saleLines(saleId);

    const result = await cancelOrder(id, at('09:30:00'), { reasonCodeId: reason.id });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');

    // Document d'annulation (cause de la commande), appliqué à l'heure de l'opération.
    const docs = await cancellationsOfOrder(id);
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc).toMatchObject({
      cause: 'ORDER_CANCELLATION',
      status: 'APPLIED',
      cancelled_total_xaf: 4000,
      released_payment_treatment: null,
      captured_offline: 0,
    });
    expect(doc.doc_number).toMatch(/^ANV-/);
    expect(fromBin(doc.order_id!)).toBe(id);
    expect(fromBin(doc.sale_id)).toBe(saleId);
    expect(fromBin(doc.reason_code_id!)).toBe(reason.id);
    expect(fromBin(doc.requested_by)).toBe(commercial.userId);
    expect(doc.applied_at?.toISOString()).toBe(at('09:30:00'));
    expect(doc.occurred_at.toISOString()).toBe(at('09:30:00'));
    expect(refs(result)).toMatchObject({
      docNumber: before.doc_number,
      cancellation1: doc.doc_number,
    });
    const docLines = await cancellationLines(doc.id);
    expect(docLines).toHaveLength(1);
    expect(fromBin(docLines[0]!.sale_line_id)).toBe(fromBin(saleLineBefore!.id));
    expect(Number(docLines[0]!.quantity_base)).toBe(4);
    expect(docLines[0]!.amount_xaf).toBe(4000);

    // Vente : contre-écriture, passée CANCELLED ; ligne de vente entièrement annulée.
    expect(await saleRow(saleId)).toMatchObject({
      status: 'CANCELLED',
      cancelled_xaf: 4000,
      net_total_xaf: 0,
      amount_paid_xaf: 0,
      balance_due_xaf: 0,
    });
    const [saleLine] = await saleLines(saleId);
    expect(saleLine).toMatchObject({ cancelled_xaf: 4000 });
    expect(Number(saleLine!.cancelled_quantity_base)).toBe(4);

    // Stock : retour de « à livrer » au magasin, à la valeur figée de la vente.
    const returns = await returnMovesOf(docs);
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({
      move_type: 'CUSTOMER_RETURN',
      source_doc_type: 'SALE_CANCELLATION',
    });
    expect(fromBin(returns[0]!.from_location_id)).toBe(toDeliver);
    expect(fromBin(returns[0]!.to_location_id)).toBe(storeId);
    expect(Number(returns[0]!.value_xaf)).toBe(2400);
    expect(await onHandAt(product.id, storeId)).toBe(10);
    expect(await onHandAt(product.id, toDeliver)).toBe(0);
    expect(
      await soldGoodsPosition(db, { saleId, saleLineId: fromBin(saleLine!.id) }),
    ).toMatchObject({
      soldQuantity: 4,
      returnedQuantity: 4,
      deliveredQuantity: 0,
      netQuantity: 0,
      remainingQuantity: 0,
      netValueXaf: 0,
    });

    // Ligne de commande : tout est retiré (commandé et vendu nuls, cumul retiré = ancien commandé).
    const [orderLine] = await orderLines(id);
    expect(orderLine).toMatchObject({ line_total_xaf: 0 });
    expect(Number(orderLine!.quantity)).toBe(0);
    expect(Number(orderLine!.quantity_base)).toBe(0);
    expect(Number(orderLine!.sold_quantity_base)).toBe(0);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(4);
    expect(Number(orderLine!.delivered_quantity_base)).toBe(0);

    // Commande : annulée à l'heure de l'opération, par son auteur ; version montée une fois.
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CANCELLED',
      total_estimated_xaf: 0,
      advance_paid_xaf: 0,
      cancel_comment: null,
      closed_at: null,
      closed_by: null,
      released_payment_treatment: null,
    });
    expect(order.cancelled_at?.toISOString()).toBe(at('09:30:00'));
    expect(fromBin(order.cancelled_by!)).toBe(commercial.userId);
    expect(fromBin(order.cancel_reason_code_id!)).toBe(reason.id);
    expect(order.version).toBe(before.version + 1);
    expect(fromBin(order.updated_by!)).toBe(commercial.userId);
    // L'identité de la vente d'origine n'a pas changé.
    expect(fromBin(sale.id)).toBe(saleId);

    // Le prospect converti par cette vente reste client ; sa conversion est signalée annulée.
    const customerAfter = await customerRow(customer);
    expect(customerAfter.stage).toBe('CUSTOMER');
    expect(fromBin(customerAfter.first_sale_id!)).toBe(saleId);
    expect(customerAfter.conversion_reverted).toBe(1);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('cancel avec un commentaire seul (sans code motif) : le commentaire est conservé sur la commande et sur le document', async () => {
    const { id } = await soldOrder({ quantity: 2, stockQuantity: 5 });
    const result = await cancelOrder(id, at('09:31:00'), { comment: 'Le client a changé d’avis' });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CANCELLED',
      cancel_reason_code_id: null,
      cancel_comment: 'Le client a changé d’avis',
    });
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({ comment: 'Le client a changé d’avis', reason_code_id: null });
  });

  it('cancel d’une commande en partie vendue : la part en attente est retirée sans mouvement ni document, la part vendue est contre-passée ; CANCELLED est terminal', async () => {
    const a = await sellable(1000);
    const b = await sellable(2500);
    await stock(a.id, 4, 300);
    const customer = await newCustomer({ credit: true });
    // Ligne A : 4 vendus ; ligne B : aucun stock, 3 en attente.
    const { id } = await placed(
      { customerId: customer, lines: [line(a, 4), line(b, 3)] },
      at('09:00:00'),
    );
    const [orderLineA, orderLineB] = await orderLines(id);
    expect(Number(orderLineA!.sold_quantity_base)).toBe(4);
    expect(Number(orderLineB!.sold_quantity_base)).toBe(0);
    const before = await orderRow(id);
    expect(before.total_estimated_xaf).toBe(4000 + 7500);

    const result = await cancelOrder(id, at('09:30:00'), { comment: 'Annulation' });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    // Un seul document : la ligne B n'a rien de vendu, donc rien à contre-passer.
    const docs = await cancellationsOfOrder(id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ cause: 'ORDER_CANCELLATION', cancelled_total_xaf: 4000 });
    expect(refs(result)['cancellation2']).toBeUndefined();
    const [lineA, lineB] = await orderLines(id);
    for (const [orderLine, withdrawn] of [
      [lineA, 4],
      [lineB, 3],
    ] as const) {
      expect(Number(orderLine!.quantity)).toBe(0);
      expect(Number(orderLine!.quantity_base)).toBe(0);
      expect(Number(orderLine!.sold_quantity_base)).toBe(0);
      expect(Number(orderLine!.withdrawn_quantity_base)).toBe(withdrawn);
      expect(orderLine!.line_total_xaf).toBe(0);
    }
    const order = await orderRow(id);
    expect(order).toMatchObject({ status: 'CANCELLED', total_estimated_xaf: 0 });
    const bMoves = await db
      .selectFrom('inventory_stock_moves')
      .select('id')
      .where('product_id', '=', toBin(b.id))
      .execute();
    expect(bMoves).toHaveLength(0);
    expect(await onHandAt(a.id, storeId)).toBe(4);

    // Terminale : plus de confirmation du reste (même si le stock arrive), plus de modification.
    await stock(b.id, 10, 1000);
    const afterCancel = await stateOf(id);
    expect(code(await confirmRemaining(id, at('10:00:00')))).toBe('ORDER_STATUS_INVALID');
    expect(
      code(
        await updateOrder(id, at('10:01:00'), {
          lines: [{ orderLineId: fromBin(lineA!.id), quantity: 2, quantityBase: 2 }],
        }),
      ),
    ).toBe('ORDER_NOT_MODIFIABLE');
    expect(await stateOf(id)).toEqual(afterCancel);
    expect(await ordersSales(id)).toHaveLength(1);

    // Trace d'audit de la commande (journal en ajout seul) : une ligne SUCCESS à l'heure de la saisie.
    const audit = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result', 'occurred_at', 'entity_type'])
      .where('entity_id', '=', toBin(id))
      .where('action', '=', 'sales.order.cancel')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ result: 'SUCCESS', entity_type: 'SALES_ORDER' });
    expect(audit[0]!.occurred_at.toISOString()).toBe(at('09:30:00'));
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 2. Acompte sur une commande sans vente --------------------------------------------------------------

  /** Commande sans stock (aucune vente) avec un acompte affecté à la commande. */
  async function orderWithAdvanceOnly(amountXaf: number) {
    const product = await sellable(1000);
    const customer = await newCustomer({ credit: false });
    const { id } = await placed(
      {
        customerId: customer,
        lines: [line(product, 2)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf, cashAccountId }],
      },
      at('09:00:00'),
    );
    expect(await ordersSales(id)).toHaveLength(0);
    const order = await orderRow(id);
    expect(order.advance_paid_xaf).toBe(amountXaf);
    return { product, customer, id };
  }

  it('cancel avec un acompte et aucune vente : le sort de l’acompte est exigé, sans quoi rien n’est écrit', async () => {
    const { id } = await orderWithAdvanceOnly(1500);
    const before = await stateOf(id);
    const refused = await cancelOrder(id, at('09:30:00'), { comment: 'Annulation' });
    expect(code(refused)).toBe('PAYMENT_TREATMENT_REQUIRED');
    expect(await stateOf(id)).toEqual(before);
    expect(before.order[0]).toBe('CONFIRMED');
    expect(before.allocations).toEqual([['ACTIVE', null, 1500, 'commande']]);
    const [payment] = await paymentsOfOrder(id);
    expect(payment).toMatchObject({ status: 'RECORDED', unallocated_xaf: 0, refunded_xaf: 0 });
    expect(await cashMovementsOf(id)).toHaveLength(0);
    // Un sort inconnu est refusé dès la validation du schéma : aucune écriture non plus.
    const unknownTreatment = await cancelOrder(id, at('09:31:00'), {
      comment: 'Annulation',
      paymentTreatment: 'DONATION',
    });
    expect(unknownTreatment.status).toBe('REJECTED');
    expect(await stateOf(id)).toEqual(before);
  });

  it('cancel avec un acompte et CUSTOMER_CREDIT : l’affectation est renversée (ORDER_CANCELLED), l’argent reste au nom du client', async () => {
    const { id } = await orderWithAdvanceOnly(1500);
    const cashBefore = await cashAccountBalance(db, cashAccountId);
    const result = await cancelOrder(id, at('09:30:00'), {
      comment: 'Annulation',
      paymentTreatment: 'CUSTOMER_CREDIT',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    // Aucune vente : aucun document ANV, aucune référence d'annulation.
    expect(refs(result)['cancellation1']).toBeUndefined();
    expect(await cancellationsOfOrder(id)).toHaveLength(0);

    const [allocation] = await allocationsOf(id, []);
    expect(allocation).toMatchObject({
      status: 'REVERSED',
      reversal_cause: 'ORDER_CANCELLED',
      amount_xaf: 1500,
    });
    expect(allocation!.reversed_at?.toISOString()).toBe(at('09:30:00'));
    const [payment] = await paymentsOfOrder(id);
    expect(payment).toMatchObject({ unallocated_xaf: 1500, refunded_xaf: 0, status: 'RECORDED' });
    // L'argent reste en caisse (crédit client) : aucun mouvement de remboursement.
    expect(await cashMovementsOf(id)).toHaveLength(0);
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore);

    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CANCELLED',
      advance_paid_xaf: 0,
      released_payment_treatment: 'CUSTOMER_CREDIT',
      total_estimated_xaf: 0,
    });
    const [orderLine] = await orderLines(id);
    expect(Number(orderLine!.quantity_base)).toBe(0);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(2);
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  it('cancel avec un acompte et REFUND : mouvement de trésorerie sortant dont la pièce source est la commande', async () => {
    const cashBefore = (await cashAccountBalance(db, cashAccountId)) ?? 0;
    const { id } = await orderWithAdvanceOnly(1500);
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore + 1500);
    const result = await cancelOrder(id, at('09:30:00'), {
      comment: 'Annulation',
      paymentTreatment: 'REFUND',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');

    const movements = await cashMovementsOf(id);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      direction: 'OUT',
      amount_xaf: 1500,
      movement_type: 'REFUND',
      source_doc_type: 'SALE_REFUND',
    });
    expect(fromBin(movements[0]!.cash_account_id)).toBe(cashAccountId);
    expect(movements[0]!.occurred_at.toISOString()).toBe(at('09:30:00'));
    const [payment] = await paymentsOfOrder(id);
    expect(payment).toMatchObject({ refunded_xaf: 1500, unallocated_xaf: 0 });
    const [allocation] = await allocationsOf(id, []);
    expect(allocation).toMatchObject({ status: 'REVERSED', reversal_cause: 'ORDER_CANCELLED' });
    expect(await orderRow(id)).toMatchObject({
      status: 'CANCELLED',
      advance_paid_xaf: 0,
      released_payment_treatment: 'REFUND',
    });
    // Entrée de l'acompte et remboursement s'annulent ; le grand livre de trésorerie reste juste.
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore);
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  // --- 3. Vente payée par l'acompte --------------------------------------------------------------------

  it('cancel d’une commande dont la vente est payée par l’acompte : la part libérée suit le sort choisi (CUSTOMER_CREDIT), affectation de la vente renversée', async () => {
    const { product, id, saleId } = await soldOrder({
      quantity: 4,
      stockQuantity: 10,
      credit: true,
      advanceXaf: 1500,
    });
    // L'acompte est passé à la vente à la confirmation : plus rien d'affecté à la commande.
    expect(await saleRow(saleId)).toMatchObject({
      amount_paid_xaf: 1500,
      balance_due_xaf: 2500,
      payment_status: 'PARTIALLY_PAID',
    });
    expect((await orderRow(id)).advance_paid_xaf).toBe(0);

    const before = await stateOf(id);
    const refused = await cancelOrder(id, at('09:30:00'), { comment: 'Annulation' });
    expect(code(refused)).toBe('PAYMENT_TREATMENT_REQUIRED');
    expect(await stateOf(id)).toEqual(before);
    expect(await onHandAt(product.id, storeId)).toBe(6);

    const result = await cancelOrder(id, at('09:40:00'), {
      comment: 'Annulation',
      paymentTreatment: 'CUSTOMER_CREDIT',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({
      cause: 'ORDER_CANCELLATION',
      status: 'APPLIED',
      released_payment_treatment: 'CUSTOMER_CREDIT',
      cancelled_total_xaf: 4000,
    });
    const allocations = await allocationsOf(id, [toBin(saleId)]);
    // L'affectation de la commande avait été renversée à la confirmation (ORDER_CONFIRMED) ; celle de
    // la vente l'est par l'annulation (SALE_CANCELLED).
    expect(allocations).toHaveLength(2);
    expect(
      allocations.map((a) => [a.status, a.reversal_cause, a.amount_xaf, a.order_id ? 'c' : 'v']),
    ).toEqual(
      expect.arrayContaining([
        ['REVERSED', 'ORDER_CONFIRMED', 1500, 'c'],
        ['REVERSED', 'SALE_CANCELLED', 1500, 'v'],
      ]),
    );
    const [payment] = await paymentsOfOrder(id);
    expect(payment).toMatchObject({ unallocated_xaf: 1500, refunded_xaf: 0 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'CANCELLED',
      amount_paid_xaf: 0,
      balance_due_xaf: 0,
    });
    expect(await orderRow(id)).toMatchObject({ status: 'CANCELLED', advance_paid_xaf: 0 });
    expect(await onHandAt(product.id, storeId)).toBe(10);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('cancel d’une commande dont la vente est intégralement payée par l’acompte et REFUND : le remboursement a pour pièce source le document ANV', async () => {
    const cashBefore = (await cashAccountBalance(db, cashAccountId)) ?? 0;
    const { product, id, saleId } = await soldOrder({
      quantity: 2,
      stockQuantity: 5,
      credit: false,
      advanceXaf: 2000,
    });
    expect(await saleRow(saleId)).toMatchObject({ payment_status: 'PAID', amount_paid_xaf: 2000 });
    const result = await cancelOrder(id, at('09:30:00'), {
      comment: 'Annulation',
      paymentTreatment: 'REFUND',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({ released_payment_treatment: 'REFUND', status: 'APPLIED' });
    const movements = await cashMovementsOf(fromBin(doc!.id));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      direction: 'OUT',
      amount_xaf: 2000,
      movement_type: 'REFUND',
      source_doc_type: 'SALE_REFUND',
    });
    const [payment] = await paymentsOfOrder(id);
    expect(payment).toMatchObject({ refunded_xaf: 2000, unallocated_xaf: 0 });
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore);
    expect(await onHandAt(product.id, storeId)).toBe(5);
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  it('cancel d’une commande avec une ligne de service : aucun mouvement de stock pour le service, il est annulé en montant', async () => {
    const goods = await sellable(1000);
    const service = await sellable(500, { service: true });
    await stock(goods.id, 5, 300);
    const customer = await newCustomer({ credit: true });
    const { id } = await placed(
      { customerId: customer, lines: [line(goods, 2), line(service, 1)] },
      at('09:00:00'),
    );
    const [sale] = await ordersSales(id);
    expect(Number(sale!.total_xaf)).toBe(2500);
    expect(await onHandAt(goods.id, storeId)).toBe(3);

    const result = await cancelOrder(id, at('09:30:00'), { comment: 'Annulation' });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const docs = await cancellationsOfOrder(id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ cause: 'ORDER_CANCELLATION', cancelled_total_xaf: 2500 });
    const docLines = await cancellationLines(docs[0]!.id);
    expect(docLines.map((l) => [Number(l.quantity_base), l.amount_xaf]).sort()).toEqual([
      [1, 500],
      [2, 2000],
    ]);
    // Seule la marchandise revient au stock : une ligne de service n'a aucun mouvement.
    const returns = await returnMovesOf(docs);
    expect(returns).toHaveLength(1);
    expect(returns[0]!.product_id.equals(toBin(goods.id))).toBe(true);
    expect(await onHandAt(goods.id, storeId)).toBe(5);
    const serviceLine = (await saleLines(fromBin(sale!.id))).find((l) =>
      l.product_id.equals(toBin(service.id)),
    )!;
    expect(serviceLine).toMatchObject({ cancelled_xaf: 500 });
    expect(Number(serviceLine.cancelled_quantity_base)).toBe(1);
    expect(await saleRow(fromBin(sale!.id))).toMatchObject({
      status: 'CANCELLED',
      cancelled_xaf: 2500,
    });
    expect(await orderRow(id)).toMatchObject({ status: 'CANCELLED', total_estimated_xaf: 0 });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 4. Brouillon ------------------------------------------------------------------------------------

  it('cancel d’un brouillon : CANCELLED, aucun mouvement de stock, aucun document ANV', async () => {
    const product = await sellable(1000);
    await stock(product.id, 5, 300);
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
        lines: [line(product, 5)],
      },
    );
    expect(draft.status, JSON.stringify(draft)).toBe('APPLIED');
    const before = await orderRow(draftId);
    expect(before).toMatchObject({ status: 'DRAFT', confirmed_at: null });

    const result = await cancelOrder(draftId, at('09:20:00'), { comment: 'Brouillon abandonné' });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(refs(result)['cancellation1']).toBeUndefined();
    const order = await orderRow(draftId);
    expect(order).toMatchObject({
      status: 'CANCELLED',
      confirmed_at: null,
      total_estimated_xaf: 0,
      cancel_comment: 'Brouillon abandonné',
    });
    expect(order.cancelled_at?.toISOString()).toBe(at('09:20:00'));
    expect(fromBin(order.cancelled_by!)).toBe(commercial.userId);
    expect(order.version).toBe(before.version + 1);
    const [orderLine] = await orderLines(draftId);
    expect(Number(orderLine!.quantity_base)).toBe(0);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(5);
    expect(await ordersSales(draftId)).toHaveLength(0);
    expect(await cancellationsOfOrder(draftId)).toHaveLength(0);
    // Le stock n'a jamais été touché par le brouillon ni par son annulation.
    expect(await onHandAt(product.id, storeId)).toBe(5);
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select('move_type')
      .where('product_id', '=', toBin(product.id))
      .execute();
    expect(moves.map((move) => move.move_type)).toEqual(['PURCHASE_RECEIPT']);
    // Le prospect n'a jamais été converti.
    expect((await customerRow(customer)).stage).toBe('PROSPECT');
  });

  // --- 5. Refus ----------------------------------------------------------------------------------------

  it('refus : commande en partie livrée, déjà annulée, clôturée ou livrée en entier', async () => {
    // PARTIALLY_FULFILLED : le reste se clôture, il ne s'annule pas.
    const partial = await soldOrder({ quantity: 4, stockQuantity: 10 });
    await deliver(partial.id, 1, 2);
    expect((await orderRow(partial.id)).status).toBe('PARTIALLY_FULFILLED');
    const partialState = await stateOf(partial.id);
    expect(code(await cancelOrder(partial.id, at('09:30:00'), { comment: 'Annulation' }))).toBe(
      'CANCELLATION_EXCEEDS_UNDELIVERED',
    );
    expect(await stateOf(partial.id)).toEqual(partialState);

    // CANCELLED : déjà annulée.
    const toCancel = await soldOrder({ quantity: 2, stockQuantity: 5 });
    expect((await cancelOrder(toCancel.id, at('09:30:00'), { comment: 'Annulation' })).status).toBe(
      'APPLIED',
    );
    const cancelledState = await stateOf(toCancel.id);
    expect(code(await cancelOrder(toCancel.id, at('09:31:00'), { comment: 'Encore' }))).toBe(
      'ORDER_ALREADY_CANCELLED',
    );
    expect(await stateOf(toCancel.id)).toEqual(cancelledState);

    // CLOSED : terminée.
    const toClose = await soldOrder({ quantity: 4, stockQuantity: 10 });
    await deliver(toClose.id, 1, 1);
    const closed = await closeRemaining(toClose.id, at('09:35:00'), { comment: 'Clôture' });
    expect(closed.status, JSON.stringify(closed)).toBe('APPLIED');
    expect((await orderRow(toClose.id)).status).toBe('CLOSED');
    const closedState = await stateOf(toClose.id);
    expect(code(await cancelOrder(toClose.id, at('09:36:00'), { comment: 'Annulation' }))).toBe(
      'ORDER_STATUS_INVALID',
    );
    expect(await stateOf(toClose.id)).toEqual(closedState);

    // FULFILLED : tout est livré.
    const fulfilled = await soldOrder({ quantity: 3, stockQuantity: 3 });
    await deliver(fulfilled.id, 1, 3, 'FULFILLED');
    expect((await orderRow(fulfilled.id)).status).toBe('FULFILLED');
    const fulfilledState = await stateOf(fulfilled.id);
    expect(code(await cancelOrder(fulfilled.id, at('09:40:00'), { comment: 'Annulation' }))).toBe(
      'ORDER_STATUS_INVALID',
    );
    expect(await stateOf(fulfilled.id)).toEqual(fulfilledState);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('refus : motif manquant ou inconnu, commande inconnue, autre commercial, droit d’annulation absent', async () => {
    const { id, product } = await soldOrder({ quantity: 3, stockQuantity: 8 });
    const before = await stateOf(id);

    // Ni code motif ni commentaire.
    expect(code(await cancelOrder(id, at('09:30:00'), {}))).toBe('REASON_REQUIRED');
    // Code motif inconnu.
    expect(code(await cancelOrder(id, at('09:31:00'), { reasonCodeId: freshUuid() }))).toBe(
      'REFERENCE_INVALID',
    );
    // Commentaire vide : refusé par le schéma, jamais pris pour un motif.
    expect((await cancelOrder(id, at('09:32:00'), { comment: '   ' })).status).toBe('REJECTED');
    // Un autre commercial (portée « propre ») n'est pas l'auteur de la commande.
    expect(
      code(
        await cancelOrder(
          id,
          at('09:33:00'),
          { comment: 'Annulation' },
          { actor: otherCommercial },
        ),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    // Le finance n'a pas la permission d'annuler une commande.
    expect(
      code(await cancelOrder(id, at('09:34:00'), { comment: 'Annulation' }, { actor: finance })),
    ).toBe('FORBIDDEN');
    expect(await stateOf(id)).toEqual(before);
    expect(await onHandAt(product.id, storeId)).toBe(5);

    // Commande inconnue.
    expect(code(await cancelOrder(freshUuid(), at('09:35:00'), { comment: 'Annulation' }))).toBe(
      'NOT_FOUND',
    );
    expect(code(await closeRemaining(freshUuid(), at('09:36:00'), { comment: 'Clôture' }))).toBe(
      'NOT_FOUND',
    );
    // Une clôture a les mêmes gardes de portée et de motif.
    const partial = await soldOrder({ quantity: 4, stockQuantity: 10 });
    await deliver(partial.id, 1, 1);
    const partialState = await stateOf(partial.id);
    expect(code(await closeRemaining(partial.id, at('09:37:00'), {}))).toBe('REASON_REQUIRED');
    expect(
      code(await closeRemaining(partial.id, at('09:38:00'), { reasonCodeId: freshUuid() })),
    ).toBe('REFERENCE_INVALID');
    expect(
      code(
        await closeRemaining(
          partial.id,
          at('09:39:00'),
          { comment: 'Clôture' },
          { actor: otherCommercial },
        ),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(await stateOf(partial.id)).toEqual(partialState);
  });

  it('le Resp. commercial (portée ALL) annule ou clôture la commande d’un autre commercial, sans validation (AV-128)', async () => {
    const toCancel = await soldOrder({ quantity: 3, stockQuantity: 10 });
    const cancelled = await cancelOrder(
      toCancel.id,
      at('09:30:00'),
      { comment: 'Décision du responsable' },
      { actor: manager },
    );
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    const order = await orderRow(toCancel.id);
    expect(order.status).toBe('CANCELLED');
    expect(fromBin(order.cancelled_by!)).toBe(manager.userId);
    // L'auteur de la commande reste le commercial ; la validation n'est jamais demandée.
    expect(fromBin(order.created_by)).toBe(commercial.userId);
    const [doc] = await cancellationsOfOrder(toCancel.id);
    expect(fromBin(doc!.requested_by)).toBe(manager.userId);
    expect(doc).toMatchObject({ status: 'APPLIED', approval_request_id: null });

    const toClose = await soldOrder({ quantity: 4, stockQuantity: 10 });
    await deliver(toClose.id, 1, 1);
    const closed = await closeRemaining(
      toClose.id,
      at('09:40:00'),
      { comment: 'Clôture du responsable' },
      { actor: manager },
    );
    expect(closed.status, JSON.stringify(closed)).toBe('APPLIED');
    const closedOrder = await orderRow(toClose.id);
    expect(closedOrder.status).toBe('CLOSED');
    expect(fromBin(closedOrder.closed_by!)).toBe(manager.userId);
  });

  // --- 6. Clôture du reste d'une commande en partie livrée ---------------------------------------------------

  it('close_remaining : le non-livré est contre-passé, le livré reste chez le client, la part en attente est retirée sans mouvement', async () => {
    const a = await sellable(1000);
    const b = await sellable(2500);
    await stock(a.id, 10, 600);
    const customer = await newCustomer({ credit: true });
    const reason = await reasonCode('Client absent');
    // Ligne A : 10 vendus ; ligne B : aucun stock, 5 en attente.
    const { id } = await placed(
      { customerId: customer, lines: [line(a, 10), line(b, 5)] },
      at('09:00:00'),
    );
    const [sale] = await ordersSales(id);
    const saleId = fromBin(sale!.id);
    const [saleLineA] = await saleLines(saleId);
    expect(await saleLines(saleId)).toHaveLength(1);
    await deliver(id, 1, 4);
    const before = await orderRow(id);
    expect(before.status).toBe('PARTIALLY_FULFILLED');
    const customerLocation = await customerLocationOf();
    expect(await onHandAt(a.id, customerLocation)).toBe(4);

    const result = await closeRemaining(id, at('11:00:00'), {
      reasonCodeId: reason.id,
      comment: 'Le client ne prend que 4 pièces',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');

    // Un seul document : la ligne B n'a rien de vendu.
    const docs = await cancellationsOfOrder(id);
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc).toMatchObject({
      cause: 'ORDER_CLOSURE',
      status: 'APPLIED',
      cancelled_total_xaf: 6000,
      comment: 'Le client ne prend que 4 pièces',
    });
    expect(fromBin(doc.reason_code_id!)).toBe(reason.id);
    expect(fromBin(doc.order_id!)).toBe(id);
    expect(doc.applied_at?.toISOString()).toBe(at('11:00:00'));
    expect(refs(result)).toMatchObject({
      docNumber: before.doc_number,
      cancellation1: doc.doc_number,
    });
    const docLines = await cancellationLines(doc.id);
    expect(docLines).toHaveLength(1);
    expect(fromBin(docLines[0]!.sale_line_id)).toBe(fromBin(saleLineA!.id));
    expect(Number(docLines[0]!.quantity_base)).toBe(6);
    expect(docLines[0]!.amount_xaf).toBe(6000);

    // Stock : 6 retournent au magasin ; les 4 livrés restent chez le client ; « à livrer » est vide.
    const returns = await returnMovesOf(docs);
    expect(returns.reduce((sum, move) => sum + Number(move.quantity), 0)).toBe(6);
    expect(returns.reduce((sum, move) => sum + Number(move.value_xaf), 0)).toBe(3600);
    expect(await onHandAt(a.id, storeId)).toBe(6);
    expect(await onHandAt(a.id, customerLocation)).toBe(4);
    expect(await onHandAt(a.id, await toDeliverOf())).toBe(0);
    // La part en attente n'a jamais eu de stock : aucun mouvement pour le produit B.
    const bMoves = await db
      .selectFrom('inventory_stock_moves')
      .select('id')
      .where('product_id', '=', toBin(b.id))
      .execute();
    expect(bMoves).toHaveLength(0);
    expect(
      await soldGoodsPosition(db, { saleId, saleLineId: fromBin(saleLineA!.id) }),
    ).toMatchObject({
      soldQuantity: 10,
      deliveredQuantity: 4,
      returnedQuantity: 6,
      netQuantity: 4,
      remainingQuantity: 0,
    });

    // Vente : annulée en partie seulement (4 livrés), elle reste confirmée.
    expect(await saleRow(saleId)).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 6000,
      net_total_xaf: 4000,
    });
    const [saleLineAfter] = await saleLines(saleId);
    expect(Number(saleLineAfter!.cancelled_quantity_base)).toBe(6);
    expect(Number(saleLineAfter!.delivered_quantity_base)).toBe(4);

    // Lignes de commande : le commandé de A devient le livré ; B est entièrement retirée.
    const [orderLineA, orderLineB] = await orderLines(id);
    expect(orderLineA).toMatchObject({ line_total_xaf: 4000 });
    expect(Number(orderLineA!.quantity)).toBe(4);
    expect(Number(orderLineA!.quantity_base)).toBe(4);
    expect(Number(orderLineA!.sold_quantity_base)).toBe(4);
    expect(Number(orderLineA!.delivered_quantity_base)).toBe(4);
    expect(Number(orderLineA!.withdrawn_quantity_base)).toBe(6);
    expect(orderLineB).toMatchObject({ line_total_xaf: 0 });
    expect(Number(orderLineB!.quantity_base)).toBe(0);
    expect(Number(orderLineB!.sold_quantity_base)).toBe(0);
    expect(Number(orderLineB!.withdrawn_quantity_base)).toBe(5);

    // Commande : CLOSED avec la clôture tracée ; ni annulée ni livrée en entier.
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CLOSED',
      total_estimated_xaf: 4000,
      closed_reason: 'Le client ne prend que 4 pièces',
      cancelled_at: null,
      cancelled_by: null,
    });
    expect(order.closed_at?.toISOString()).toBe(at('11:00:00'));
    expect(fromBin(order.closed_by!)).toBe(commercial.userId);
    expect(order.version).toBe(before.version + 1);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });

    // Terminée : une seconde clôture est refusée, sans effet.
    const closedState = await stateOf(id);
    expect(code(await closeRemaining(id, at('11:30:00'), { comment: 'Encore' }))).toBe(
      'ORDER_STATUS_INVALID',
    );
    expect(await stateOf(id)).toEqual(closedState);
  });

  it('close_remaining avec un code motif seul : le libellé du motif est consigné comme raison de la clôture', async () => {
    const { id } = await soldOrder({ quantity: 4, stockQuantity: 4 });
    await deliver(id, 1, 1);
    const reason = await reasonCode('Marchandise refusée à la livraison');
    const result = await closeRemaining(id, at('10:30:00'), { reasonCodeId: reason.id });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CLOSED',
      closed_reason: 'Marchandise refusée à la livraison',
    });
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({ cause: 'ORDER_CLOSURE', cancelled_total_xaf: 3000, comment: null });
    const [orderLine] = await orderLines(id);
    expect(Number(orderLine!.quantity_base)).toBe(1);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(3);
  });

  it('close_remaining sur une commande sans livraison : ORDER_STATUS_INVALID (il faut l’annuler)', async () => {
    const { id } = await soldOrder({ quantity: 3, stockQuantity: 3 });
    const before = await stateOf(id);
    expect(code(await closeRemaining(id, at('09:30:00'), { comment: 'Clôture' }))).toBe(
      'ORDER_STATUS_INVALID',
    );
    expect(await stateOf(id)).toEqual(before);
    // Une commande annulée n'a pas non plus de reste à clôturer.
    expect((await cancelOrder(id, at('09:40:00'), { comment: 'Annulation' })).status).toBe(
      'APPLIED',
    );
    expect(code(await closeRemaining(id, at('09:41:00'), { comment: 'Clôture' }))).toBe(
      'ORDER_STATUS_INVALID',
    );
  });

  it('close_remaining avec un acompte encore affecté à la commande : libéré selon le sort choisi (ORDER_CLOSED)', async () => {
    // Ligne A vendue et livrée en partie, ligne B en attente avec l'acompte resté sur la commande :
    // l'acompte part à la vente à la confirmation, le reste libéré par la clôture suit le sort choisi.
    const a = await sellable(1000);
    const b = await sellable(1000);
    await stock(a.id, 4, 300);
    const customer = await newCustomer({ credit: false });
    const { id } = await placed(
      {
        customerId: customer,
        lines: [line(a, 4), line(b, 3)],
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 6000, cashAccountId }],
      },
      at('09:00:00'),
    );
    // La vente de A (4000) prend 4000 de l'acompte ; 2000 restent affectés à la commande (ligne B en attente).
    const [sale] = await ordersSales(id);
    expect(Number(sale!.amount_paid_xaf)).toBe(4000);
    expect((await orderRow(id)).advance_paid_xaf).toBe(2000);
    await deliver(id, 1, 1);

    const before = await stateOf(id);
    const refused = await closeRemaining(id, at('10:00:00'), { comment: 'Clôture' });
    expect(code(refused)).toBe('PAYMENT_TREATMENT_REQUIRED');
    expect(await stateOf(id)).toEqual(before);

    const result = await closeRemaining(id, at('10:05:00'), {
      comment: 'Clôture',
      paymentTreatment: 'CUSTOMER_CREDIT',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const allocations = await allocationsOf(id, [sale!.id]);
    // Le registre d'affectation est immuable : l'affectation de la vente (4 000) est renversée en entier
    // et sa part conservée (1 000) est réaffectée par une nouvelle ligne.
    expect(allocations).toHaveLength(4);
    expect(
      allocations.map((a2) => [
        a2.status,
        a2.reversal_cause,
        a2.amount_xaf,
        a2.order_id ? 'c' : 'v',
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['REVERSED', 'ORDER_CONFIRMED', 6000, 'c'],
        ['REVERSED', 'ORDER_CLOSED', 2000, 'c'],
        ['REVERSED', 'SALE_CANCELLED', 4000, 'v'],
        ['ACTIVE', null, 1000, 'v'],
      ]),
    );
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CLOSED',
      advance_paid_xaf: 0,
      released_payment_treatment: 'CUSTOMER_CREDIT',
    });
    const [payment] = await paymentsOfOrder(id);
    // 2000 libérés par la clôture de la commande, 3000 par l'annulation du non-livré de la vente.
    expect(payment).toMatchObject({ unallocated_xaf: 5000, refunded_xaf: 0 });
    expect(await saleRow(fromBin(sale!.id))).toMatchObject({
      amount_paid_xaf: 1000,
      net_total_xaf: 1000,
    });
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 7. Annulation d'une vente sur commande -------------------------------------------------------------

  it('sales.sale.cancel d’une vente sur commande : la quantité annulée est retirée de la commande, qui reste CONFIRMED s’il reste une ligne ouverte', async () => {
    const a = await sellable(1000);
    const b = await sellable(2500);
    await stock(a.id, 4, 300);
    const customer = await newCustomer({ credit: true });
    // Ligne A : 4 vendus ; ligne B : aucun stock, 3 en attente.
    const { id } = await placed(
      { customerId: customer, lines: [line(a, 4), line(b, 3)] },
      at('09:00:00'),
    );
    const [sale] = await ordersSales(id);
    const saleId = fromBin(sale!.id);
    const before = await orderRow(id);

    const { id: cancellationId, result } = await cancelSale(saleId, at('09:05:00'), {
      comment: 'Erreur de saisie',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({
      cause: 'SALE_CANCELLATION',
      status: 'APPLIED',
      cancelled_total_xaf: 4000,
    });
    expect(fromBin(doc!.id)).toBe(cancellationId);
    expect(doc!.applied_at?.toISOString()).toBe(at('09:05:00'));
    expect(await saleRow(saleId)).toMatchObject({ status: 'CANCELLED', cancelled_xaf: 4000 });
    expect(await onHandAt(a.id, storeId)).toBe(4);

    // Commande : le vendu net et le commandé de A baissent, le cumul retiré monte ; B est intacte.
    const [lineA, lineB] = await orderLines(id);
    expect(lineA).toMatchObject({ line_total_xaf: 0 });
    expect(Number(lineA!.quantity)).toBe(0);
    expect(Number(lineA!.quantity_base)).toBe(0);
    expect(Number(lineA!.sold_quantity_base)).toBe(0);
    expect(Number(lineA!.withdrawn_quantity_base)).toBe(4);
    expect(lineB).toMatchObject({ line_total_xaf: 7500 });
    expect(Number(lineB!.quantity_base)).toBe(3);
    expect(Number(lineB!.withdrawn_quantity_base)).toBe(0);
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CONFIRMED',
      total_estimated_xaf: 7500,
      cancelled_at: null,
      closed_at: null,
    });
    expect(order.version).toBe(before.version + 1);

    // La quantité retirée n'est pas revendue par une confirmation ultérieure.
    const idle = await confirmRemaining(id, at('10:00:00'));
    expect(idle.status, JSON.stringify(idle)).toBe('APPLIED');
    expect(refs(idle)['saleDocNumber']).toBeUndefined();
    expect(await ordersSales(id)).toHaveLength(1);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('sales.sale.cancel de l’unique vente d’une commande : la commande devient CANCELLED (rien livré)', async () => {
    const { product, id, saleId } = await soldOrder({ quantity: 4, stockQuantity: 4 });
    const reason = await reasonCode();
    const result = (
      await cancelSale(saleId, at('09:05:00'), {
        reasonCodeId: reason.id,
        comment: 'Erreur de saisie',
      })
    ).result;
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CANCELLED',
      total_estimated_xaf: 0,
      cancel_comment: 'Erreur de saisie',
      closed_at: null,
    });
    expect(order.cancelled_at?.toISOString()).toBe(at('09:05:00'));
    expect(fromBin(order.cancelled_by!)).toBe(commercial.userId);
    expect(fromBin(order.cancel_reason_code_id!)).toBe(reason.id);
    const [orderLine] = await orderLines(id);
    expect(Number(orderLine!.quantity_base)).toBe(0);
    expect(Number(orderLine!.sold_quantity_base)).toBe(0);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(4);
    expect(await onHandAt(product.id, storeId)).toBe(4);
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(0);
    // Plus rien à annuler : l'annulation de la commande est refusée proprement.
    expect(code(await cancelOrder(id, at('09:10:00'), { comment: 'Encore' }))).toBe(
      'ORDER_ALREADY_CANCELLED',
    );
  });

  it('sales.sale.cancel d’une vente en partie livrée : l’annulation du non-livré rend la commande CLOSED', async () => {
    const { product, id, saleId } = await soldOrder({ quantity: 10, stockQuantity: 10 });
    await deliver(id, 1, 4);
    const result = (await cancelSale(saleId, at('09:05:00'))).result;
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({ cause: 'SALE_CANCELLATION', cancelled_total_xaf: 6000 });
    expect(await saleRow(saleId)).toMatchObject({ status: 'CONFIRMED', cancelled_xaf: 6000 });
    const order = await orderRow(id);
    expect(order).toMatchObject({
      status: 'CLOSED',
      total_estimated_xaf: 4000,
      cancelled_at: null,
    });
    expect(order.closed_at?.toISOString()).toBe(at('09:05:00'));
    expect(fromBin(order.closed_by!)).toBe(commercial.userId);
    expect(order.closed_reason).toMatch(/^Annulation de la vente VTE-/);
    const [orderLine] = await orderLines(id);
    expect(Number(orderLine!.quantity_base)).toBe(4);
    expect(Number(orderLine!.sold_quantity_base)).toBe(4);
    expect(Number(orderLine!.delivered_quantity_base)).toBe(4);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(6);
    expect(await onHandAt(product.id, storeId)).toBe(6);
    expect(await onHandAt(product.id, await customerLocationOf())).toBe(4);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('voie validation : la commande reste intacte tant que la demande est en cours, puis suit la décision (heure de la décision)', async () => {
    const { product, id, saleId } = await soldOrder({ quantity: 4, stockQuantity: 4 });
    const beforeRequest = await stateOf(id);
    const { id: cancellationId, result } = await cancelSale(
      saleId,
      at('09:10:00'),
      { comment: 'Demande du client' },
      'sales.sale.request_cancellation',
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect((await saleRow(saleId)).status).toBe('CANCELLATION_REQUESTED');
    const [requested] = await cancellationsOfOrder(id);
    expect(requested).toMatchObject({ status: 'REQUESTED', applied_at: null });
    // Aucun effet sur la commande ni sur le stock avant la décision.
    const afterRequest = await stateOf(id);
    expect(afterRequest.order).toEqual(beforeRequest.order);
    expect(afterRequest.lines).toEqual(beforeRequest.lines);
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(4);

    const approved = await decide('approve', await approvalOf(cancellationId), at('10:00:00'));
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({ status: 'APPLIED', cause: 'SALE_CANCELLATION' });
    expect(doc!.applied_at?.toISOString()).toBe(at('10:00:00'));
    expect(await saleRow(saleId)).toMatchObject({ status: 'CANCELLED', cancelled_xaf: 4000 });
    const order = await orderRow(id);
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelled_at?.toISOString()).toBe(at('10:00:00'));
    const [orderLine] = await orderLines(id);
    expect(Number(orderLine!.quantity_base)).toBe(0);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(4);
    expect(await onHandAt(product.id, storeId)).toBe(4);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('voie validation : une demande rejetée n’a aucun effet sur la commande', async () => {
    const { product, id, saleId } = await soldOrder({ quantity: 4, stockQuantity: 6 });
    const beforeRequest = await stateOf(id);
    const { id: cancellationId } = await cancelSale(
      saleId,
      at('09:10:00'),
      {},
      'sales.sale.request_cancellation',
    );
    const rejected = await decide('reject', await approvalOf(cancellationId), at('10:00:00'));
    expect(rejected.status, JSON.stringify(rejected)).toBe('APPLIED');
    const after = await stateOf(id);
    // La demande rejetée est conservée (REJECTED) ; tout le reste est identique à l'avant-demande.
    expect(after.docs).toHaveLength(1);
    expect(after.docs[0]![1]).toBe('REJECTED');
    expect(after.order).toEqual(beforeRequest.order);
    expect(after.lines).toEqual(beforeRequest.lines);
    expect(after.sales).toEqual(beforeRequest.sales);
    expect(await onHandAt(product.id, storeId)).toBe(2);
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(4);
    expect(await returnMovesOf(await cancellationsOfOrder(id))).toHaveLength(0);
  });

  it('un document SALE_CANCELLATION d’une vente sur commande porte la commande de la vente (dictionnaire sales_sale_cancellations.order_id)', async () => {
    const { id, saleId } = await soldOrder({ quantity: 2, stockQuantity: 2 });
    const { id: cancellationId, result } = await cancelSale(saleId, at('09:05:00'));
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const doc = await db
      .selectFrom('sales_sale_cancellations')
      .select(['cause', 'order_id'])
      .where('id', '=', toBin(cancellationId))
      .executeTakeFirstOrThrow();
    expect(doc.cause).toBe('SALE_CANCELLATION');
    // « Commande de la vente, dénormalisée ; nul pour une vente directe » (dictionnaire 05-sales).
    expect(doc.order_id).not.toBeNull();
    expect(fromBin(doc.order_id!)).toBe(id);
  });

  // --- 8. Demande d'annulation en cours -----------------------------------------------------------------

  it('une demande d’annulation en cours sur une vente de la commande : annulation et modification de la commande sont refusées sans écriture', async () => {
    const { id, saleId, product } = await soldOrder({ quantity: 4, stockQuantity: 10 });
    const [orderLine] = await orderLines(id);
    const { id: cancellationId, result } = await cancelSale(
      saleId,
      at('09:10:00'),
      { comment: 'Demande' },
      'sales.sale.request_cancellation',
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect((await saleRow(saleId)).status).toBe('CANCELLATION_REQUESTED');
    const before = await stateOf(id);

    expect(code(await cancelOrder(id, at('09:20:00'), { comment: 'Annulation' }))).toBe(
      'SALE_CANCELLATION_PENDING',
    );
    expect(await stateOf(id)).toEqual(before);
    // Une baisse de la commande devrait annuler la même vente : refusée de la même façon.
    const lowered = await updateOrder(id, at('09:21:00'), {
      lines: [{ orderLineId: fromBin(orderLine!.id), quantity: 2, quantityBase: 2 }],
    });
    expect(code(lowered)).toBe('SALE_CANCELLATION_PENDING');
    expect(await stateOf(id)).toEqual(before);
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(4);

    // La demande rejetée, la commande peut de nouveau être annulée.
    const rejected = await decide('reject', await approvalOf(cancellationId), at('09:30:00'));
    expect(rejected.status, JSON.stringify(rejected)).toBe('APPLIED');
    expect((await saleRow(saleId)).status).toBe('CONFIRMED');
    const cancelled = await cancelOrder(id, at('09:40:00'), { comment: 'Annulation' });
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('APPLIED');
    const docs = await cancellationsOfOrder(id);
    expect(docs.map((doc) => [doc.cause, doc.status]).sort()).toEqual([
      ['ORDER_CANCELLATION', 'APPLIED'],
      ['SALE_CANCELLATION', 'REJECTED'],
    ]);
    expect((await orderRow(id)).status).toBe('CANCELLED');
    expect(await onHandAt(product.id, storeId)).toBe(10);
  });

  it('une demande d’annulation en cours bloque aussi la clôture du reste', async () => {
    const { id, saleId } = await soldOrder({ quantity: 4, stockQuantity: 4 });
    await deliver(id, 1, 1);
    const requested = await cancelSale(
      saleId,
      at('09:10:00'),
      {},
      'sales.sale.request_cancellation',
    );
    expect(requested.result.status, JSON.stringify(requested.result)).toBe('APPLIED');
    const before = await stateOf(id);
    expect(code(await closeRemaining(id, at('09:20:00'), { comment: 'Clôture' }))).toBe(
      'SALE_CANCELLATION_PENDING',
    );
    expect(await stateOf(id)).toEqual(before);
  });

  // --- 9. Rejeu et hors ligne ----------------------------------------------------------------------------

  it('rejeu : la même commande (même command_id) ne produit aucun second effet ; une autre commande est refusée', async () => {
    const { product, id } = await soldOrder({ quantity: 4, stockQuantity: 10 });
    const commandId = freshUuid();
    const seq = ++deviceSeq;
    const first = await cancelOrder(
      id,
      at('09:30:00'),
      { comment: 'Annulation' },
      { commandId, deviceSeq: seq },
    );
    expect(first.status, JSON.stringify(first)).toBe('APPLIED');
    const afterFirst = await stateOf(id);
    expect(afterFirst.docs).toHaveLength(1);
    expect(await onHandAt(product.id, storeId)).toBe(10);

    const replay = await cancelOrder(
      id,
      at('09:30:00'),
      { comment: 'Annulation' },
      { commandId, deviceSeq: seq },
    );
    expect(replay.status, JSON.stringify(replay)).toBe('APPLIED');
    expect(refs(replay)).toEqual(refs(first));
    expect(await stateOf(id)).toEqual(afterFirst);
    expect(await cancellationsOfOrder(id)).toHaveLength(1);
    expect(await returnMovesOf(await cancellationsOfOrder(id))).toHaveLength(1);
    expect(await onHandAt(product.id, storeId)).toBe(10);

    // Même identifiant de commande avec un autre contenu : refusé par le pipeline.
    const reused = await cancelOrder(
      id,
      at('09:30:00'),
      { comment: 'Autre motif' },
      { commandId, deviceSeq: seq },
    );
    expect(code(reused)).toBe('COMMAND_ID_REUSED');

    // Une autre commande d'annulation sur la même commande : refusée, sans second effet.
    expect(code(await cancelOrder(id, at('09:35:00'), { comment: 'Encore' }))).toBe(
      'ORDER_ALREADY_CANCELLED',
    );
    expect(await stateOf(id)).toEqual(afterFirst);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('rejeu d’une clôture : la même commande ne contre-passe pas deux fois le reste', async () => {
    const { product, id } = await soldOrder({ quantity: 6, stockQuantity: 6 });
    await deliver(id, 1, 2);
    const commandId = freshUuid();
    const seq = ++deviceSeq;
    const first = await closeRemaining(
      id,
      at('10:30:00'),
      { comment: 'Clôture' },
      { commandId, deviceSeq: seq },
    );
    expect(first.status, JSON.stringify(first)).toBe('APPLIED');
    const afterFirst = await stateOf(id);
    const replay = await closeRemaining(
      id,
      at('10:30:00'),
      { comment: 'Clôture' },
      { commandId, deviceSeq: seq },
    );
    expect(replay.status).toBe('APPLIED');
    expect(await stateOf(id)).toEqual(afterFirst);
    expect(afterFirst.docs).toHaveLength(1);
    expect(await onHandAt(product.id, storeId)).toBe(4);
  });

  it('hors ligne : l’annulation saisie avant sa synchronisation est appliquée à l’heure de la saisie (document, stock, trésorerie)', async () => {
    const cashBefore = (await cashAccountBalance(db, cashAccountId)) ?? 0;
    const { product, id, saleId } = await soldOrder({
      quantity: 2,
      stockQuantity: 5,
      credit: false,
      advanceXaf: 2000,
      at: at('08:00:00'),
    });
    const result = await cancelOrder(
      id,
      at('09:40:00'),
      { comment: 'Annulation saisie sur le terrain', paymentTreatment: 'REFUND' },
      { offline: true },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const [doc] = await cancellationsOfOrder(id);
    expect(doc).toMatchObject({
      cause: 'ORDER_CANCELLATION',
      status: 'APPLIED',
      captured_offline: 1,
      released_payment_treatment: 'REFUND',
    });
    expect(doc!.applied_at?.toISOString()).toBe(at('09:40:00'));
    expect(doc!.occurred_at.toISOString()).toBe(at('09:40:00'));
    // Reçu par le serveur après la saisie : l'heure métier reste celle de la saisie.
    expect(doc!.received_at_server).not.toBeNull();
    const order = await orderRow(id);
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelled_at?.toISOString()).toBe(at('09:40:00'));
    const [returned] = await returnMovesOf([doc!]);
    expect(returned!.occurred_at.toISOString()).toBe(at('09:40:00'));
    const [refund] = await cashMovementsOf(fromBin(doc!.id));
    expect(refund).toMatchObject({
      movement_type: 'REFUND',
      captured_offline: 1,
      amount_xaf: 2000,
    });
    expect(refund!.occurred_at.toISOString()).toBe(at('09:40:00'));
    const allocations = await allocationsOf(id, [toBin(saleId)]);
    const saleAllocation = allocations.find((a) => a.sale_id !== null)!;
    expect(saleAllocation).toMatchObject({ status: 'REVERSED', reversal_cause: 'SALE_CANCELLED' });
    expect(saleAllocation.reversed_at?.toISOString()).toBe(at('09:40:00'));
    expect(await onHandAt(product.id, storeId)).toBe(5);
    expect(await cashAccountBalance(db, cashAccountId)).toBe(cashBefore);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
    expect(await verifyCashLedger(db)).toMatchObject({ ok: true });
  });

  it('hors ligne : une annulation qui arrive pour une commande déjà livrée est une intention rejetée, jamais un fait accompli', async () => {
    const { id } = await soldOrder({ quantity: 4, stockQuantity: 4 });
    await deliver(id, 1, 4, 'FULFILLED');
    const before = await stateOf(id);
    const late = await cancelOrder(
      id,
      at('09:30:00'),
      { comment: 'Annulation saisie hors ligne' },
      { offline: true },
    );
    expect(code(late)).toBe('ORDER_STATUS_INVALID');
    expect(await stateOf(id)).toEqual(before);
    expect(warningsOf(late)).toEqual([]);
  });

  it('concurrence : annulation de la commande et annulation de sa vente lancées en même temps — un seul effet, aucun interblocage', async () => {
    const pairs = await Promise.all(
      [0, 1, 2].map(() => soldOrder({ quantity: 4, stockQuantity: 6, unitCost: 500 })),
    );
    const results = await Promise.all(
      pairs.flatMap((pair, index) => {
        const hh = `09:${String(10 + index).padStart(2, '0')}:00`;
        return [
          cancelOrder(pair.id, at(hh), { comment: 'Annulation de la commande' }),
          cancelSale(pair.saleId, at(hh), { comment: 'Annulation de la vente' }).then(
            (cancelled) => cancelled.result,
          ),
        ];
      }),
    );
    // Aucune erreur transitoire : l'ordre de verrous (commande, puis ventes) sérialise les deux.
    for (const result of results) {
      expect(['APPLIED', 'REJECTED'], JSON.stringify(result)).toContain(result.status);
    }
    for (const [index, pair] of pairs.entries()) {
      const orderResult = results[index * 2]!;
      const saleResult = results[index * 2 + 1]!;
      // Exactement un gagnant ; le perdant voit l'état terminal (jamais un second effet).
      expect([orderResult.status, saleResult.status].sort()).toEqual(['APPLIED', 'REJECTED']);
      const loser = orderResult.status === 'REJECTED' ? orderResult : saleResult;
      expect(['ORDER_ALREADY_CANCELLED', 'SALE_ALREADY_CANCELLED']).toContain(code(loser));
      const docs = await cancellationsOfOrder(pair.id);
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ status: 'APPLIED', cancelled_total_xaf: 4000 });
      expect(await returnMovesOf(docs)).toHaveLength(1);
      expect(await saleRow(pair.saleId)).toMatchObject({
        status: 'CANCELLED',
        cancelled_xaf: 4000,
      });
      const order = await orderRow(pair.id);
      expect(order.status).toBe('CANCELLED');
      expect(order.cancelled_at).not.toBeNull();
      const [orderLine] = await orderLines(pair.id);
      expect(Number(orderLine!.quantity_base)).toBe(0);
      expect(Number(orderLine!.sold_quantity_base)).toBe(0);
      expect(Number(orderLine!.withdrawn_quantity_base)).toBe(4);
      expect(await onHandAt(pair.product.id, storeId)).toBe(6);
      expect(await onHandAt(pair.product.id, await toDeliverOf())).toBe(0);
    }
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  // --- 10. Plusieurs ventes ---------------------------------------------------------------------------------

  it('commande à deux ventes (confirmation puis confirm_remaining) : un document ANV par vente, numéros distincts, (command_id, sale_id) respecté', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const { id } = await placed(
      { customerId: customer, lines: [line(product, 5)] },
      at('09:00:00'),
    );
    await stock(product.id, 4, 700);
    const later = await confirmRemaining(id, at('10:00:00'));
    expect(later.status, JSON.stringify(later)).toBe('APPLIED');
    const sales = await ordersSales(id);
    expect(sales).toHaveLength(2);
    expect(sales.map((sale) => Number(sale.total_xaf))).toEqual([3000, 2000]);
    const saleIds = sales.map((sale) => fromBin(sale.id));
    const costs = new Map<string, number>();
    for (const sale of sales) {
      const [saleLine] = await saleLines(fromBin(sale.id));
      costs.set(fromBin(sale.id), Number(saleLine!.cost_xaf));
    }
    expect(await onHandAt(product.id, storeId)).toBe(2);
    const before = await orderRow(id);

    const commandId = freshUuid();
    const result = await cancelOrder(id, at('11:00:00'), { comment: 'Annulation' }, { commandId });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');

    const docs = await cancellationsOfOrder(id);
    expect(docs).toHaveLength(2);
    expect(new Set(docs.map((doc) => doc.doc_number)).size).toBe(2);
    for (const doc of docs) expect(doc.doc_number).toMatch(/^ANV-/);
    expect(new Set(docs.map((doc) => fromBin(doc.sale_id)))).toEqual(new Set(saleIds));
    const bySale = new Map(docs.map((doc) => [fromBin(doc.sale_id), doc]));
    expect(bySale.get(saleIds[0]!)).toMatchObject({
      cause: 'ORDER_CANCELLATION',
      cancelled_total_xaf: 3000,
    });
    expect(bySale.get(saleIds[1]!)).toMatchObject({
      cause: 'ORDER_CANCELLATION',
      cancelled_total_xaf: 2000,
    });
    // Les deux numéros sont rendus dans serverRefs ; aucun troisième.
    const serverRefs = refs(result);
    expect(new Set([serverRefs['cancellation1'], serverRefs['cancellation2']])).toEqual(
      new Set(docs.map((doc) => doc.doc_number)),
    );
    expect(serverRefs['cancellation3']).toBeUndefined();
    expect(serverRefs['docNumber']).toBe(before.doc_number);
    // Une même commande de synchronisation : deux documents, un par vente (UNIQUE (command_id, sale_id)).
    for (const doc of docs) expect(fromBin(doc.command_id!)).toBe(commandId);
    const duplicates = await db
      .selectFrom('sales_sale_cancellations')
      .select(['command_id', 'sale_id', sql<string>`COUNT(*)`.as('n')])
      .where('command_id', '=', toBin(commandId))
      .groupBy(['command_id', 'sale_id'])
      .having(sql<number>`COUNT(*)`, '>', 1)
      .execute();
    expect(duplicates).toHaveLength(0);

    // Stock : chaque retour rend la valeur figée de sa vente ; tout est revenu au magasin.
    const returns = await returnMovesOf(docs);
    for (const doc of docs) {
      const ofDoc = returns.filter((move) => move.source_doc_id.equals(doc.id));
      expect(ofDoc.reduce((sum, move) => sum + Number(move.value_xaf), 0)).toBe(
        costs.get(fromBin(doc.sale_id)),
      );
    }
    expect(returns.reduce((sum, move) => sum + Number(move.quantity), 0)).toBe(5);
    expect(await onHandAt(product.id, storeId)).toBe(7);
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(0);
    for (const sale of sales) {
      expect(await saleRow(fromBin(sale.id))).toMatchObject({ status: 'CANCELLED' });
    }
    const [orderLine] = await orderLines(id);
    expect(Number(orderLine!.quantity_base)).toBe(0);
    expect(Number(orderLine!.sold_quantity_base)).toBe(0);
    expect(Number(orderLine!.withdrawn_quantity_base)).toBe(5);
    const order = await orderRow(id);
    expect(order).toMatchObject({ status: 'CANCELLED', total_estimated_xaf: 0 });
    expect(order.cancelled_at?.toISOString()).toBe(at('11:00:00'));
    expect(order.version).toBe(before.version + 1);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });

  it('commande à deux ventes dont l’une est partiellement livrée : seule la part non livrée de chaque vente est contre-passée à la clôture', async () => {
    const product = await sellable(1000);
    await stock(product.id, 3, 500);
    const customer = await newCustomer({ credit: true });
    const { id } = await placed(
      { customerId: customer, lines: [line(product, 5)] },
      at('09:00:00'),
    );
    await stock(product.id, 4, 700);
    expect((await confirmRemaining(id, at('10:00:00'))).status).toBe('APPLIED');
    const [first, second] = await ordersSales(id);
    // La première vente (3) est livrée en entier : seule la seconde reste annulable (2).
    const orderLine = (await orderLines(id))[0]!;
    const firstLine = (await saleLines(fromBin(first!.id)))[0]!;
    await db.transaction().execute(async (trx) => {
      await deliverSoldGoods(
        trx,
        { idGenerator },
        {
          saleId: fromBin(first!.id),
          saleLineId: fromBin(firstLine.id),
          quantityBase: 3,
          sourceDocId: freshUuid(),
          occurredAt: new Date(at('10:30:00')),
          createdBy: admin.userId,
        },
      );
      await trx
        .updateTable('sales_sale_lines')
        .set({ delivered_quantity_base: '3' })
        .where('id', '=', firstLine.id)
        .execute();
      await trx
        .updateTable('sales_sales_order_lines')
        .set({ delivered_quantity_base: '3' })
        .where('id', '=', orderLine.id)
        .execute();
      await trx
        .updateTable('sales_sales_orders')
        .set({ status: 'PARTIALLY_FULFILLED' })
        .where('id', '=', toBin(id))
        .execute();
    });

    const result = await closeRemaining(id, at('11:00:00'), { comment: 'Clôture' });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    // Un seul document : la vente entièrement livrée n'a rien d'annulable.
    const docs = await cancellationsOfOrder(id);
    expect(docs).toHaveLength(1);
    expect(fromBin(docs[0]!.sale_id)).toBe(fromBin(second!.id));
    expect(docs[0]).toMatchObject({ cause: 'ORDER_CLOSURE', cancelled_total_xaf: 2000 });
    expect(await saleRow(fromBin(first!.id))).toMatchObject({
      status: 'CONFIRMED',
      cancelled_xaf: 0,
    });
    expect(await saleRow(fromBin(second!.id))).toMatchObject({
      status: 'CANCELLED',
      cancelled_xaf: 2000,
    });
    const [lineAfter] = await orderLines(id);
    expect(Number(lineAfter!.quantity_base)).toBe(3);
    expect(Number(lineAfter!.sold_quantity_base)).toBe(3);
    expect(Number(lineAfter!.delivered_quantity_base)).toBe(3);
    expect(Number(lineAfter!.withdrawn_quantity_base)).toBe(2);
    expect((await orderRow(id)).status).toBe('CLOSED');
    expect(await onHandAt(product.id, await toDeliverOf())).toBe(0);
    expect(await onHandAt(product.id, await customerLocationOf())).toBe(3);
    expect(await onHandAt(product.id, storeId)).toBe(4);
    expect(await verifyStockLedger(db, {})).toMatchObject({ ok: true });
  });
});

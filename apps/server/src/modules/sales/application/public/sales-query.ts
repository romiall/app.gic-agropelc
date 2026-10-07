/**
 * Lectures des commandes, ventes, livraisons et encaissements (P4-10 ; 08-api-events/
 * 01-architecture-api.md §4.5). Aucune décision d'autorisation ici : le transport `sales-api/`
 * décide de la portée (RC-04) à partir de la ressource (`resource`) de chaque élément et masque les
 * coûts sans droit de valorisation (RC-05). Pagination par curseur, du plus récent au plus ancien
 * sur `id` (UUIDv7) ; le curseur est l'`id` du dernier élément examiné.
 */
import { sql, type Expression, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const SALES_LIST_DEFAULT_LIMIT = 50;
export const SALES_LIST_MAX_LIMIT = 200;

export interface SalesPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Ressource d'un document pour l'évaluation de la portée (RC-04). */
export interface SalesResource {
  readonly ownerUserId: string;
  readonly siteId: string;
  readonly zoneId: string;
}

function pageOf<Row extends { readonly id: Buffer }, T>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => T,
): SalesPage<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: hasMore && last ? fromBin(last.id) : null };
}

/**
 * Périmètre d'une liste (`listConfinementAt` d'`identity`) : documents d'un de ces sites **ou** dont
 * le titulaire est l'un de ces utilisateurs. Sur-ensemble des documents visibles, que le transport
 * affine élément par élément.
 */
export interface ListScope {
  readonly siteIds: readonly string[];
  readonly ownerUserIds: readonly string[];
}

const isEmptyScope = (scope: ListScope | undefined): boolean =>
  scope !== undefined && scope.siteIds.length === 0 && scope.ownerUserIds.length === 0;

/** Condition « site OU titulaire » ; appelée seulement pour un périmètre non vide. */
function scopeCondition(
  scope: ListScope,
  site: (ids: Buffer[]) => Expression<SqlBool>,
  owner: (ids: Buffer[]) => Expression<SqlBool>,
  or: (conditions: Expression<SqlBool>[]) => Expression<SqlBool>,
): Expression<SqlBool> {
  const conditions: Expression<SqlBool>[] = [];
  if (scope.siteIds.length > 0) conditions.push(site(scope.siteIds.map((id) => toBin(id))));
  if (scope.ownerUserIds.length > 0) {
    conditions.push(owner(scope.ownerUserIds.map((id) => toBin(id))));
  }
  return or(conditions);
}

const qty = (value: string | number): number => Number(value);
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

interface ListFilter {
  readonly anyOf?: ListScope;
  readonly siteId?: string;
  readonly customerId?: string;
  readonly fromUtc?: Date;
  readonly toUtc?: Date;
  readonly beforeId?: string;
  readonly limit: number;
}

// --- Commandes ----------------------------------------------------------------------------------------

export interface OrderSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly status: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly fulfilmentLocationId: string;
  readonly channelCode: string | null;
  readonly commercialUserId: string | null;
  readonly createdBy: string;
  readonly totalEstimatedXaf: number;
  readonly advancePaidXaf: number;
  readonly requestedDeliveryDate: string | null;
  readonly deliveryAddress: string | null;
  readonly occurredAt: string;
  readonly version: number;
  readonly resource: SalesResource;
}

function orderQuery(executor: Executor) {
  return executor
    .selectFrom('sales_sales_orders as o')
    .innerJoin('organization_sites as site', 'site.id', 'o.site_id')
    .selectAll('o')
    .select([
      'site.zone_id as site_zone_id',
      sql<string | null>`DATE_FORMAT(o.requested_delivery_date, '%Y-%m-%d')`.as('requested_day'),
    ]);
}
type OrderRow = Awaited<ReturnType<ReturnType<typeof orderQuery>['executeTakeFirstOrThrow']>>;

function toOrderSummary(row: OrderRow): OrderSummary {
  const commercial = fromBinOrNull(row.commercial_user_id);
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    status: row.status,
    customerId: fromBin(row.customer_id),
    siteId: fromBin(row.site_id),
    fulfilmentLocationId: fromBin(row.fulfilment_location_id),
    channelCode: row.channel_code,
    commercialUserId: commercial,
    createdBy: fromBin(row.created_by),
    totalEstimatedXaf: Number(row.total_estimated_xaf),
    advancePaidXaf: Number(row.advance_paid_xaf),
    requestedDeliveryDate: row.requested_day,
    deliveryAddress: row.delivery_address,
    occurredAt: row.occurred_at.toISOString(),
    version: row.version,
    resource: {
      ownerUserId: commercial ?? fromBin(row.created_by),
      siteId: fromBin(row.site_id),
      zoneId: fromBin(row.site_zone_id),
    },
  };
}

export async function listOrders(
  executor: Executor,
  filter: ListFilter & {
    readonly status?: string;
    readonly fulfilmentLocationId?: string;
  },
): Promise<SalesPage<OrderSummary>> {
  if (isEmptyScope(filter.anyOf)) return { items: [], nextCursor: null };
  const rows = await orderQuery(executor)
    .$if(filter.anyOf !== undefined, (qb) =>
      qb.where((eb) =>
        scopeCondition(
          filter.anyOf!,
          (ids) => eb('o.site_id', 'in', ids),
          (ids) => eb(eb.fn.coalesce('o.commercial_user_id', 'o.created_by'), 'in', ids),
          (conditions) => eb.or(conditions),
        ),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('o.site_id', '=', toBin(filter.siteId!)))
    .$if(filter.customerId !== undefined, (qb) =>
      qb.where('o.customer_id', '=', toBin(filter.customerId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('o.status', '=', filter.status!))
    .$if(filter.fulfilmentLocationId !== undefined, (qb) =>
      qb.where('o.fulfilment_location_id', '=', toBin(filter.fulfilmentLocationId!)),
    )
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('o.occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('o.occurred_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('o.id', '<', toBin(filter.beforeId!)))
    .orderBy('o.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return pageOf(rows, filter.limit, toOrderSummary);
}

export interface OrderLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitCode: string;
  readonly orderedBase: number;
  readonly soldBase: number;
  readonly deliveredBase: number;
  readonly withdrawnBase: number;
  /** En attente (commandé − vendu) et à livrer (vendu − livré), unité de base. */
  readonly pendingBase: number;
  readonly undeliveredBase: number;
  readonly quotedUnitPriceXaf: number;
  readonly lineTotalXaf: number;
}

export interface OrderDetail extends OrderSummary {
  readonly lines: readonly OrderLineView[];
  readonly sales: readonly SaleSummary[];
  readonly deliveries: readonly DeliveryNoteSummary[];
  readonly cancelledAt: string | null;
  readonly cancelComment: string | null;
  readonly closedAt: string | null;
  readonly closedReason: string | null;
}

export async function getOrder(
  executor: Executor,
  orderId: string,
): Promise<OrderDetail | undefined> {
  const row = await orderQuery(executor).where('o.id', '=', toBin(orderId)).executeTakeFirst();
  if (!row) return undefined;
  const lines = await executor
    .selectFrom('sales_sales_order_lines')
    .selectAll()
    .where('order_id', '=', row.id)
    .orderBy('line_no', 'asc')
    .execute();
  const sales = await listSales(executor, { orderId, limit: SALES_LIST_MAX_LIMIT });
  const deliveries = await listDeliveryNotes(executor, { orderId, limit: SALES_LIST_MAX_LIMIT });
  return {
    ...toOrderSummary(row),
    lines: lines.map((line) => {
      const ordered = qty(line.quantity_base);
      const sold = qty(line.sold_quantity_base);
      const delivered = qty(line.delivered_quantity_base);
      return {
        id: fromBin(line.id),
        lineNo: line.line_no,
        productId: fromBin(line.product_id),
        productName: line.product_name_snapshot,
        quantity: qty(line.quantity),
        unitCode: line.unit_code,
        orderedBase: ordered,
        soldBase: sold,
        deliveredBase: delivered,
        withdrawnBase: qty(line.withdrawn_quantity_base),
        pendingBase: Math.round((ordered - sold) * 1000) / 1000,
        undeliveredBase: Math.round((sold - delivered) * 1000) / 1000,
        quotedUnitPriceXaf: Number(line.quoted_unit_price_xaf),
        lineTotalXaf: Number(line.line_total_xaf),
      };
    }),
    sales: sales.items,
    deliveries: deliveries.items,
    cancelledAt: iso(row.cancelled_at),
    cancelComment: row.cancel_comment,
    closedAt: iso(row.closed_at),
    closedReason: row.closed_reason,
  };
}

// --- Ventes ---------------------------------------------------------------------------------------------

export interface SaleSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly saleType: string;
  readonly orderId: string | null;
  readonly status: string;
  readonly paymentStatus: string;
  readonly customerId: string | null;
  readonly siteId: string;
  readonly fromLocationId: string;
  readonly channelCode: string | null;
  readonly sellerUserId: string;
  readonly commercialUserId: string | null;
  readonly totalXaf: number;
  readonly cancelledXaf: number;
  readonly netTotalXaf: number;
  readonly amountPaidXaf: number;
  readonly balanceDueXaf: number;
  readonly dueDate: string | null;
  readonly flags: readonly string[];
  readonly capturedOffline: boolean;
  readonly occurredAt: string;
  readonly resource: SalesResource;
}

function saleQuery(executor: Executor) {
  return executor
    .selectFrom('sales_sales')
    .selectAll()
    .select(sql<string | null>`DATE_FORMAT(due_date, '%Y-%m-%d')`.as('due_day'));
}
type SaleRow = Awaited<ReturnType<ReturnType<typeof saleQuery>['executeTakeFirstOrThrow']>>;

function toSaleSummary(row: SaleRow): SaleSummary {
  const commercial = fromBinOrNull(row.commercial_user_id);
  const flags = Array.isArray(row.flags) ? (row.flags as string[]) : [];
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    saleType: row.sale_type,
    orderId: fromBinOrNull(row.order_id),
    status: row.status,
    // Colonne générée, jamais nulle (le type généré la dit nullable).
    paymentStatus: row.payment_status ?? 'UNPAID',
    customerId: fromBinOrNull(row.customer_id),
    siteId: fromBin(row.site_id),
    fromLocationId: fromBin(row.from_location_id),
    channelCode: row.channel_code,
    sellerUserId: fromBin(row.seller_user_id),
    commercialUserId: commercial,
    totalXaf: Number(row.total_xaf),
    cancelledXaf: Number(row.cancelled_xaf),
    netTotalXaf: Number(row.net_total_xaf),
    amountPaidXaf: Number(row.amount_paid_xaf),
    balanceDueXaf: Number(row.balance_due_xaf),
    dueDate: row.due_day,
    flags,
    capturedOffline: Boolean(row.captured_offline),
    occurredAt: row.occurred_at.toISOString(),
    resource: {
      ownerUserId: commercial ?? fromBin(row.seller_user_id),
      siteId: fromBin(row.site_id),
      zoneId: fromBin(row.zone_id),
    },
  };
}

export async function listSales(
  executor: Executor,
  filter: Omit<ListFilter, 'limit'> & {
    readonly limit: number;
    readonly orderId?: string;
    readonly status?: string;
    readonly paymentStatus?: string;
    readonly commercialUserId?: string;
  },
): Promise<SalesPage<SaleSummary>> {
  if (isEmptyScope(filter.anyOf)) return { items: [], nextCursor: null };
  const rows = await saleQuery(executor)
    .$if(filter.anyOf !== undefined, (qb) =>
      qb.where((eb) =>
        scopeCondition(
          filter.anyOf!,
          (ids) => eb('site_id', 'in', ids),
          (ids) => eb(eb.fn.coalesce('commercial_user_id', 'seller_user_id'), 'in', ids),
          (conditions) => eb.or(conditions),
        ),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.customerId !== undefined, (qb) =>
      qb.where('customer_id', '=', toBin(filter.customerId!)),
    )
    .$if(filter.orderId !== undefined, (qb) => qb.where('order_id', '=', toBin(filter.orderId!)))
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.paymentStatus !== undefined, (qb) =>
      qb.where('payment_status', '=', filter.paymentStatus!),
    )
    .$if(filter.commercialUserId !== undefined, (qb) =>
      qb.where('commercial_user_id', '=', toBin(filter.commercialUserId!)),
    )
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('occurred_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return pageOf(rows, filter.limit, toSaleSummary);
}

export interface SaleLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly orderLineId: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitCode: string;
  readonly quantityBase: number;
  readonly pricingQuantity: number;
  readonly pricingUnitCode: string;
  readonly listUnitPriceXaf: number | null;
  readonly unitPriceXaf: number;
  readonly priceSource: string;
  readonly discountXaf: number;
  readonly lineTotalXaf: number;
  readonly cancelledBase: number;
  readonly cancelledXaf: number;
  readonly deliveredBase: number;
  /** Coût figé (RC-05 : masqué sans `inventory.valuation.read`). */
  readonly unitCostXaf: number | null;
  readonly costXaf: number | null;
}

export interface SalePaymentView {
  readonly allocationId: string;
  readonly paymentId: string;
  readonly docNumber: string;
  readonly methodCode: string;
  readonly amountXaf: number;
  readonly status: string;
  readonly reversalCause: string | null;
  readonly allocatedAt: string;
}

export interface SaleCancellationView {
  readonly id: string;
  readonly docNumber: string;
  readonly cause: string;
  readonly status: string;
  readonly cancelledTotalXaf: number;
  readonly appliedAt: string | null;
  readonly comment: string | null;
}

export interface SaleDetail extends SaleSummary {
  readonly lines: readonly SaleLineView[];
  readonly payments: readonly SalePaymentView[];
  readonly cancellations: readonly SaleCancellationView[];
}

export async function getSale(executor: Executor, saleId: string): Promise<SaleDetail | undefined> {
  const row = await saleQuery(executor).where('id', '=', toBin(saleId)).executeTakeFirst();
  if (!row) return undefined;
  const lines = await executor
    .selectFrom('sales_sale_lines')
    .selectAll()
    .where('sale_id', '=', row.id)
    .orderBy('line_no', 'asc')
    .execute();
  const allocations = await executor
    .selectFrom('sales_payment_allocations as a')
    .innerJoin('sales_customer_payments as p', 'p.id', 'a.payment_id')
    .select([
      'a.id as id',
      'a.payment_id as payment_id',
      'p.doc_number as doc_number',
      'p.payment_method_code as method',
      'a.amount_xaf as amount_xaf',
      'a.status as status',
      'a.reversal_cause as reversal_cause',
      'a.allocated_at as allocated_at',
    ])
    .where('a.sale_id', '=', row.id)
    .orderBy('a.allocated_at', 'asc')
    .orderBy('a.id', 'asc')
    .execute();
  const cancellations = await executor
    .selectFrom('sales_sale_cancellations')
    .select(['id', 'doc_number', 'cause', 'status', 'cancelled_total_xaf', 'applied_at', 'comment'])
    .where('sale_id', '=', row.id)
    .orderBy('doc_number', 'asc')
    .execute();
  return {
    ...toSaleSummary(row),
    lines: lines.map((line) => ({
      id: fromBin(line.id),
      lineNo: line.line_no,
      orderLineId: fromBinOrNull(line.order_line_id),
      productId: fromBin(line.product_id),
      productName: line.product_name_snapshot,
      quantity: qty(line.quantity),
      unitCode: line.unit_code,
      quantityBase: qty(line.quantity_base),
      pricingQuantity: qty(line.pricing_quantity),
      pricingUnitCode: line.pricing_unit_code,
      listUnitPriceXaf: line.list_unit_price_xaf === null ? null : Number(line.list_unit_price_xaf),
      unitPriceXaf: Number(line.unit_price_xaf),
      priceSource: line.price_source,
      discountXaf: Number(line.discount_xaf),
      lineTotalXaf: Number(line.line_total_xaf),
      cancelledBase: qty(line.cancelled_quantity_base),
      cancelledXaf: Number(line.cancelled_xaf),
      deliveredBase: qty(line.delivered_quantity_base),
      unitCostXaf: line.unit_cost_xaf === null ? null : Number(line.unit_cost_xaf),
      costXaf: line.cost_xaf === null ? null : Number(line.cost_xaf),
    })),
    payments: allocations.map((a) => ({
      allocationId: fromBin(a.id),
      paymentId: fromBin(a.payment_id),
      docNumber: a.doc_number,
      methodCode: a.method,
      amountXaf: Number(a.amount_xaf),
      status: a.status,
      reversalCause: a.reversal_cause,
      allocatedAt: a.allocated_at.toISOString(),
    })),
    cancellations: cancellations.map((c) => ({
      id: fromBin(c.id),
      docNumber: c.doc_number,
      cause: c.cause,
      status: c.status,
      cancelledTotalXaf: Number(c.cancelled_total_xaf),
      appliedAt: iso(c.applied_at),
      comment: c.comment,
    })),
  };
}

// --- Livraisons -----------------------------------------------------------------------------------------

export interface DeliveryNoteSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly orderId: string;
  readonly siteId: string;
  readonly deliveredByUserId: string;
  readonly recipientName: string | null;
  readonly notes: string | null;
  readonly occurredAt: string;
  readonly capturedOffline: boolean;
  readonly lines: readonly {
    readonly orderLineId: string;
    readonly saleLineId: string;
    readonly quantityBase: number;
  }[];
  readonly resource: SalesResource;
}

export async function listDeliveryNotes(
  executor: Executor,
  filter: Omit<ListFilter, 'customerId'> & { readonly orderId?: string },
): Promise<SalesPage<DeliveryNoteSummary>> {
  if (isEmptyScope(filter.anyOf)) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('sales_delivery_notes as d')
    .innerJoin('sales_sales_orders as o', 'o.id', 'd.order_id')
    .innerJoin('organization_sites as site', 'site.id', 'd.site_id')
    .selectAll('d')
    .select([
      'o.commercial_user_id as order_commercial',
      'o.created_by as order_author',
      'site.zone_id as site_zone_id',
    ])
    .$if(filter.anyOf !== undefined, (qb) =>
      qb.where((eb) =>
        scopeCondition(
          filter.anyOf!,
          (ids) => eb('d.site_id', 'in', ids),
          (ids) => eb(eb.fn.coalesce('o.commercial_user_id', 'o.created_by'), 'in', ids),
          (conditions) => eb.or(conditions),
        ),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('d.site_id', '=', toBin(filter.siteId!)))
    .$if(filter.orderId !== undefined, (qb) => qb.where('d.order_id', '=', toBin(filter.orderId!)))
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('d.occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('d.occurred_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('d.id', '<', toBin(filter.beforeId!)))
    .orderBy('d.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit, (row) => row);
  const ids = page.items.map((row) => row.id);
  const lineRows =
    ids.length === 0
      ? []
      : await executor
          .selectFrom('sales_delivery_note_lines')
          .select(['delivery_note_id', 'order_line_id', 'sale_line_id', 'quantity_base'])
          .where('delivery_note_id', 'in', ids)
          .orderBy('id', 'asc')
          .execute();
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((row) => ({
      id: fromBin(row.id),
      docNumber: row.doc_number,
      orderId: fromBin(row.order_id),
      siteId: fromBin(row.site_id),
      deliveredByUserId: fromBin(row.delivered_by_user_id),
      recipientName: row.recipient_name,
      notes: row.notes,
      occurredAt: row.occurred_at.toISOString(),
      capturedOffline: Boolean(row.captured_offline),
      lines: lineRows
        .filter((line) => Buffer.compare(line.delivery_note_id, row.id) === 0)
        .map((line) => ({
          orderLineId: fromBin(line.order_line_id),
          saleLineId: fromBin(line.sale_line_id),
          quantityBase: qty(line.quantity_base),
        })),
      resource: {
        ownerUserId: fromBinOrNull(row.order_commercial) ?? fromBin(row.order_author),
        siteId: fromBin(row.site_id),
        zoneId: fromBin(row.site_zone_id),
      },
    })),
  };
}

// --- Encaissements ----------------------------------------------------------------------------------------

export interface PaymentSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly siteId: string;
  readonly methodCode: string;
  readonly amountXaf: number;
  readonly externalReference: string | null;
  readonly cashAccountId: string;
  readonly receivedByUserId: string;
  readonly unallocatedXaf: number;
  readonly refundedXaf: number;
  readonly duplicateOfPaymentId: string | null;
  readonly capturedOffline: boolean;
  readonly occurredAt: string;
  readonly resource: SalesResource;
}

function paymentQuery(executor: Executor) {
  return executor
    .selectFrom('sales_customer_payments as p')
    .innerJoin('organization_sites as site', 'site.id', 'p.site_id')
    .selectAll('p')
    .select('site.zone_id as site_zone_id');
}
type PaymentRow = Awaited<ReturnType<ReturnType<typeof paymentQuery>['executeTakeFirstOrThrow']>>;

function toPaymentSummary(row: PaymentRow): PaymentSummary {
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    status: row.status,
    customerId: fromBinOrNull(row.customer_id),
    siteId: fromBin(row.site_id),
    methodCode: row.payment_method_code,
    amountXaf: Number(row.amount_xaf),
    externalReference: row.external_reference,
    cashAccountId: fromBin(row.cash_account_id),
    receivedByUserId: fromBin(row.received_by_user_id),
    unallocatedXaf: Number(row.unallocated_xaf),
    refundedXaf: Number(row.refunded_xaf),
    duplicateOfPaymentId: fromBinOrNull(row.duplicate_of_payment_id),
    capturedOffline: Boolean(row.captured_offline),
    occurredAt: row.occurred_at.toISOString(),
    resource: {
      ownerUserId: fromBin(row.received_by_user_id),
      siteId: fromBin(row.site_id),
      zoneId: fromBin(row.site_zone_id),
    },
  };
}

export async function listPayments(
  executor: Executor,
  filter: ListFilter & { readonly status?: string },
): Promise<SalesPage<PaymentSummary>> {
  if (isEmptyScope(filter.anyOf)) return { items: [], nextCursor: null };
  const rows = await paymentQuery(executor)
    .$if(filter.anyOf !== undefined, (qb) =>
      qb.where((eb) =>
        scopeCondition(
          filter.anyOf!,
          (ids) => eb('p.site_id', 'in', ids),
          (ids) => eb('p.received_by_user_id', 'in', ids),
          (conditions) => eb.or(conditions),
        ),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('p.site_id', '=', toBin(filter.siteId!)))
    .$if(filter.customerId !== undefined, (qb) =>
      qb.where('p.customer_id', '=', toBin(filter.customerId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('p.status', '=', filter.status!))
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('p.occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('p.occurred_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('p.id', '<', toBin(filter.beforeId!)))
    .orderBy('p.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return pageOf(rows, filter.limit, toPaymentSummary);
}

export interface PaymentDetail extends PaymentSummary {
  readonly allocations: readonly {
    readonly id: string;
    readonly saleId: string | null;
    readonly orderId: string | null;
    readonly amountXaf: number;
    readonly status: string;
    readonly reversalCause: string | null;
    readonly allocatedAt: string;
  }[];
  readonly cancelComment: string | null;
  readonly cancelledAt: string | null;
}

export async function getPayment(
  executor: Executor,
  paymentId: string,
): Promise<PaymentDetail | undefined> {
  const row = await paymentQuery(executor).where('p.id', '=', toBin(paymentId)).executeTakeFirst();
  if (!row) return undefined;
  const allocations = await executor
    .selectFrom('sales_payment_allocations')
    .selectAll()
    .where('payment_id', '=', row.id)
    .orderBy('allocated_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return {
    ...toPaymentSummary(row),
    allocations: allocations.map((a) => ({
      id: fromBin(a.id),
      saleId: fromBinOrNull(a.sale_id),
      orderId: fromBinOrNull(a.order_id),
      amountXaf: Number(a.amount_xaf),
      status: a.status,
      reversalCause: a.reversal_cause,
      allocatedAt: a.allocated_at.toISOString(),
    })),
    cancelComment: row.cancel_comment,
    cancelledAt: iso(row.cancelled_at),
  };
}

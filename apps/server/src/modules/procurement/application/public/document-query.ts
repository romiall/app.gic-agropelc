/**
 * Lectures des documents d'achat (P6-06 ; 08-api-events/01-architecture-api.md §4.8) : demandes
 * d'achat, bons de commande avec reliquats, rapprochement d'un BC (commandé, livré, rejeté,
 * accepté, facturé) et réceptions. Pagination par curseur sur l'identifiant (UUIDv7, ordre
 * chronologique décroissant), comme `crm`. La portée et le masquage des valeurs (RC-05) sont
 * appliqués par le transport (`procurement-api/`).
 */
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const PROCUREMENT_LIST_DEFAULT_LIMIT = 50;
export const PROCUREMENT_LIST_MAX_LIMIT = 200;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Réceptions dont les quantités comptent au BC (stock entré) ; SM-RECEIPT. */
const COUNTED_RECEIPT_STATUSES = [
  'POSTED',
  'POSTED_PENDING_REVIEW',
  'REVIEW_REJECTED',
  'CANCELLATION_PENDING',
];

const qty = (value: string | number) => Number(value);
const milli = (value: number) => Math.round(value * 1000);
const fromMilli = (value: number) => value / 1000;

/** Forme `AAAA-MM-JJ` d'une colonne `DATE` lue (mysql2 : minuit local). */
function formatDate(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** Page de `limit` lignes lues à `limit + 1` : le curseur suivant est le dernier identifiant gardé. */
function pageOf<R extends { readonly id: Buffer }>(
  rows: readonly R[],
  limit: number,
): { readonly rows: readonly R[]; readonly nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  return {
    rows: kept,
    nextCursor: rows.length > limit ? fromBin(kept[kept.length - 1]!.id) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Demandes d'achat
// ---------------------------------------------------------------------------------------------

export interface PurchaseRequestLine {
  readonly id: string;
  readonly productId: string;
  readonly unitCode: string;
  readonly quantity: number;
  readonly quantityBase: number;
  readonly orderedQtyBase: number;
  readonly remainingToOrderBase: number;
  readonly estimatedUnitPriceXaf: number | null;
  readonly notes: string | null;
}

export interface PurchaseRequestSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly requestedBy: string;
  readonly justification: string;
  readonly neededByDate: string | null;
  readonly status: string;
  readonly estimatedTotalXaf: number;
  readonly approvalRequestId: string | null;
  readonly occurredAt: string;
  readonly capturedOffline: boolean;
  readonly lines: readonly PurchaseRequestLine[];
}

export interface PurchaseRequestFilter {
  /** Portée par défaut : DA de ces sites ou de ces demandeurs. */
  readonly anyOf?: { readonly siteIds: readonly string[]; readonly requestedBy: readonly string[] };
  readonly siteId?: string;
  readonly requestedBy?: string;
  readonly status?: string;
  readonly beforeId?: string;
  readonly limit: number;
}

async function requestLines(
  executor: Executor,
  requestIds: readonly Buffer[],
): Promise<Map<string, PurchaseRequestLine[]>> {
  const byRequest = new Map<string, PurchaseRequestLine[]>();
  if (requestIds.length === 0) return byRequest;
  const rows = await executor
    .selectFrom('procurement_purchase_request_lines')
    .selectAll()
    .where('request_id', 'in', requestIds)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  for (const row of rows) {
    const key = fromBin(row.request_id);
    const requested = qty(row.quantity_base);
    const ordered = qty(row.ordered_qty_base);
    const list = byRequest.get(key) ?? [];
    list.push({
      id: fromBin(row.id),
      productId: fromBin(row.product_id),
      unitCode: row.unit_code,
      quantity: qty(row.quantity),
      quantityBase: requested,
      orderedQtyBase: ordered,
      remainingToOrderBase: fromMilli(Math.max(0, milli(requested) - milli(ordered))),
      estimatedUnitPriceXaf:
        row.estimated_unit_price_xaf === null ? null : Number(row.estimated_unit_price_xaf),
      notes: row.notes,
    });
    byRequest.set(key, list);
  }
  return byRequest;
}

type RequestRow = Selectable<DB['procurement_purchase_requests']>;

function toRequestSummary(
  row: RequestRow,
  lines: Map<string, PurchaseRequestLine[]>,
): PurchaseRequestSummary {
  const id = fromBin(row.id);
  return {
    id,
    docNumber: row.doc_number,
    siteId: fromBin(row.site_id),
    requestedBy: fromBin(row.requested_by),
    justification: row.justification,
    neededByDate: formatDate(row.needed_by_date),
    status: row.status,
    estimatedTotalXaf: Number(row.estimated_total_xaf),
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    occurredAt: row.occurred_at.toISOString(),
    capturedOffline: Boolean(row.captured_offline),
    lines: lines.get(id) ?? [],
  };
}

export async function listPurchaseRequests(
  executor: Executor,
  filter: PurchaseRequestFilter,
): Promise<Page<PurchaseRequestSummary>> {
  if (filter.anyOf && filter.anyOf.siteIds.length + filter.anyOf.requestedBy.length === 0) {
    return { items: [], nextCursor: null };
  }
  const rows = await executor
    .selectFrom('procurement_purchase_requests')
    .selectAll()
    .$if(filter.anyOf !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([
          ...(filter.anyOf!.siteIds.length > 0
            ? [
                eb(
                  'site_id',
                  'in',
                  filter.anyOf!.siteIds.map((id) => toBin(id)),
                ),
              ]
            : []),
          ...(filter.anyOf!.requestedBy.length > 0
            ? [
                eb(
                  'requested_by',
                  'in',
                  filter.anyOf!.requestedBy.map((id) => toBin(id)),
                ),
              ]
            : []),
        ]),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.requestedBy !== undefined, (qb) =>
      qb.where('requested_by', '=', toBin(filter.requestedBy!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  const lines = await requestLines(
    executor,
    page.rows.map((row) => row.id),
  );
  return {
    items: page.rows.map((row) => toRequestSummary(row, lines)),
    nextCursor: page.nextCursor,
  };
}

export async function getPurchaseRequest(
  executor: Executor,
  requestId: string,
): Promise<PurchaseRequestSummary | undefined> {
  const row = await executor
    .selectFrom('procurement_purchase_requests')
    .selectAll()
    .where('id', '=', toBin(requestId))
    .executeTakeFirst();
  if (!row) return undefined;
  return toRequestSummary(row, await requestLines(executor, [row.id]));
}

// ---------------------------------------------------------------------------------------------
// Bons de commande
// ---------------------------------------------------------------------------------------------

export interface PurchaseOrderLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly unitCode: string;
  readonly orderedQtyBase: number;
  readonly acceptedQtyBase: number;
  readonly closedQtyBase: number;
  readonly excessQtyBase: number;
  readonly invoicedQtyBase: number;
  /** BR-APP-009 : commandé − accepté − clôturé (jamais négatif). */
  readonly remainingQtyBase: number;
  readonly unitPriceXaf: number;
  readonly lineTotalXaf: number;
  readonly status: string;
  readonly requestLineId: string | null;
}

export interface PurchaseOrderSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly deliveryLocationId: string;
  readonly expectedDeliveryDate: string | null;
  readonly status: string;
  readonly totalXaf: number;
  readonly approvalRequestId: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly sentAt: string | null;
  readonly closedReason: string | null;
  readonly cancelledAt: string | null;
  readonly occurredAt: string;
  readonly lines: readonly PurchaseOrderLine[];
}

export interface PurchaseOrderFilter {
  readonly siteIds?: readonly string[];
  readonly siteId?: string;
  readonly supplierId?: string;
  readonly status?: string;
  readonly beforeId?: string;
  readonly limit: number;
}

type OrderLineRow = Selectable<DB['procurement_purchase_order_lines']>;

function orderLineRows(executor: Executor, orderIds: readonly Buffer[]): Promise<OrderLineRow[]> {
  return executor
    .selectFrom('procurement_purchase_order_lines')
    .selectAll()
    .where('order_id', 'in', orderIds)
    .orderBy('line_no', 'asc')
    .execute();
}

function toOrderLine(row: OrderLineRow): PurchaseOrderLine {
  const ordered = milli(qty(row.ordered_qty_base));
  const accepted = milli(qty(row.accepted_qty_base));
  const closed = milli(qty(row.closed_qty_base));
  return {
    id: fromBin(row.id),
    lineNo: row.line_no,
    productId: fromBin(row.product_id),
    unitCode: row.unit_code,
    orderedQtyBase: fromMilli(ordered),
    acceptedQtyBase: fromMilli(accepted),
    closedQtyBase: fromMilli(closed),
    excessQtyBase: qty(row.excess_qty_base),
    invoicedQtyBase: qty(row.invoiced_qty_base),
    remainingQtyBase:
      row.status === 'CANCELLED' ? 0 : fromMilli(Math.max(0, ordered - accepted - closed)),
    unitPriceXaf: Number(row.unit_price_xaf),
    lineTotalXaf: Number(row.line_total_xaf),
    status: row.status,
    requestLineId: fromBinOrNull(row.request_line_id),
  };
}

async function orderLinesById(
  executor: Executor,
  orderIds: readonly Buffer[],
): Promise<Map<string, PurchaseOrderLine[]>> {
  const byOrder = new Map<string, PurchaseOrderLine[]>();
  if (orderIds.length === 0) return byOrder;
  for (const row of await orderLineRows(executor, orderIds)) {
    const key = fromBin(row.order_id);
    const list = byOrder.get(key) ?? [];
    list.push(toOrderLine(row));
    byOrder.set(key, list);
  }
  return byOrder;
}

type OrderRow = Selectable<DB['procurement_purchase_orders']>;

function toOrderSummary(
  row: OrderRow,
  lines: Map<string, PurchaseOrderLine[]>,
): PurchaseOrderSummary {
  const id = fromBin(row.id);
  return {
    id,
    docNumber: row.doc_number,
    siteId: fromBin(row.site_id),
    supplierId: fromBin(row.supplier_id),
    deliveryLocationId: fromBin(row.delivery_location_id),
    expectedDeliveryDate: formatDate(row.expected_delivery_date),
    status: row.status,
    totalXaf: Number(row.total_xaf),
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    approvedAt: row.approved_at?.toISOString() ?? null,
    approvedBy: fromBinOrNull(row.approved_by),
    sentAt: row.sent_at?.toISOString() ?? null,
    closedReason: row.closed_reason,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    occurredAt: row.occurred_at.toISOString(),
    lines: lines.get(id) ?? [],
  };
}

export async function listPurchaseOrders(
  executor: Executor,
  filter: PurchaseOrderFilter,
): Promise<Page<PurchaseOrderSummary>> {
  if (filter.siteIds && filter.siteIds.length === 0) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('procurement_purchase_orders')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.supplierId !== undefined, (qb) =>
      qb.where('supplier_id', '=', toBin(filter.supplierId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  const lines = await orderLinesById(
    executor,
    page.rows.map((row) => row.id),
  );
  return {
    items: page.rows.map((row) => toOrderSummary(row, lines)),
    nextCursor: page.nextCursor,
  };
}

export async function getPurchaseOrder(
  executor: Executor,
  orderId: string,
): Promise<PurchaseOrderSummary | undefined> {
  const row = await executor
    .selectFrom('procurement_purchase_orders')
    .selectAll()
    .where('id', '=', toBin(orderId))
    .executeTakeFirst();
  if (!row) return undefined;
  return toOrderSummary(row, await orderLinesById(executor, [row.id]));
}

export interface OrderMatchingLine {
  readonly poLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly unitCode: string;
  readonly status: string;
  readonly orderedQtyBase: number;
  /** Réceptions comptabilisées (hors quarantaine, rejetées et annulées). */
  readonly deliveredQtyBase: number;
  readonly rejectedQtyBase: number;
  readonly acceptedQtyBase: number;
  /** Réceptions en quarantaine, sans effet tant que non tranchées (BR-APP-012). */
  readonly quarantinedQtyBase: number;
  readonly closedQtyBase: number;
  readonly excessQtyBase: number;
  readonly remainingQtyBase: number;
  readonly invoicedQtyBase: number;
  readonly unitPriceXaf: number;
  readonly orderedValueXaf: number;
  readonly acceptedValueXaf: number;
  readonly invoicedValueXaf: number;
}

export interface OrderMatching {
  readonly orderId: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly status: string;
  readonly lines: readonly OrderMatchingLine[];
  readonly totals: {
    readonly orderedValueXaf: number;
    readonly acceptedValueXaf: number;
    readonly invoicedValueXaf: number;
    /** Paiements fournisseur : module `finance` (P8) — non disponible avant. */
    readonly paidXaf: number | null;
  };
}

/** Valeur d'une quantité au prix unitaire, arrondie au franc (demi supérieur, BR-VEN-014). */
const valueOf = (quantityBase: number, unitPriceXaf: number) =>
  Math.floor((milli(quantityBase) * unitPriceXaf + 500) / 1000);

/**
 * Rapprochement d'un BC (D08 UC-APP-12) : pour chaque ligne, commandé, livré, rejeté, accepté
 * (réceptions comptabilisées), en quarantaine, clôturé, excédent, reliquat et facturé.
 */
export async function purchaseOrderMatching(
  executor: Executor,
  orderId: string,
): Promise<OrderMatching | undefined> {
  const order = await executor
    .selectFrom('procurement_purchase_orders')
    .selectAll()
    .where('id', '=', toBin(orderId))
    .executeTakeFirst();
  if (!order) return undefined;
  const receiptRows = await executor
    .selectFrom('procurement_goods_receipt_lines as l')
    .innerJoin('procurement_goods_receipts as r', 'r.id', 'l.receipt_id')
    .select(['l.po_line_id', 'l.qty_delivered_base', 'l.qty_rejected_base', 'r.status'])
    .where('r.purchase_order_id', '=', order.id)
    .where('r.status', 'in', [...COUNTED_RECEIPT_STATUSES, 'QUARANTINED'])
    .execute();
  const sums = new Map<string, { delivered: number; rejected: number; quarantined: number }>();
  for (const row of receiptRows) {
    if (!row.po_line_id) continue;
    const key = fromBin(row.po_line_id);
    const sum = sums.get(key) ?? { delivered: 0, rejected: 0, quarantined: 0 };
    const delivered = milli(qty(row.qty_delivered_base));
    const rejected = milli(qty(row.qty_rejected_base));
    if (row.status === 'QUARANTINED') sum.quarantined += delivered - rejected;
    else {
      sum.delivered += delivered;
      sum.rejected += rejected;
    }
    sums.set(key, sum);
  }
  const lines = (await orderLineRows(executor, [order.id])).map((row): OrderMatchingLine => {
    const line = toOrderLine(row);
    const sum = sums.get(line.id) ?? { delivered: 0, rejected: 0, quarantined: 0 };
    return {
      poLineId: line.id,
      lineNo: line.lineNo,
      productId: line.productId,
      unitCode: line.unitCode,
      status: line.status,
      orderedQtyBase: line.orderedQtyBase,
      deliveredQtyBase: fromMilli(sum.delivered),
      rejectedQtyBase: fromMilli(sum.rejected),
      acceptedQtyBase: line.acceptedQtyBase,
      quarantinedQtyBase: fromMilli(sum.quarantined),
      closedQtyBase: line.closedQtyBase,
      excessQtyBase: line.excessQtyBase,
      remainingQtyBase: line.remainingQtyBase,
      invoicedQtyBase: line.invoicedQtyBase,
      unitPriceXaf: line.unitPriceXaf,
      orderedValueXaf: line.lineTotalXaf,
      acceptedValueXaf: valueOf(line.acceptedQtyBase, line.unitPriceXaf),
      invoicedValueXaf: valueOf(line.invoicedQtyBase, line.unitPriceXaf),
    };
  });
  const total = (pick: (line: OrderMatchingLine) => number) =>
    lines.reduce((sum, line) => sum + pick(line), 0);
  return {
    orderId: fromBin(order.id),
    docNumber: order.doc_number,
    siteId: fromBin(order.site_id),
    supplierId: fromBin(order.supplier_id),
    status: order.status,
    lines,
    totals: {
      orderedValueXaf: Number(order.total_xaf),
      acceptedValueXaf: total((line) => line.acceptedValueXaf),
      invoicedValueXaf: total((line) => line.invoicedValueXaf),
      paidXaf: null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Réceptions
// ---------------------------------------------------------------------------------------------

export interface GoodsReceiptLine {
  readonly id: string;
  readonly poLineId: string | null;
  readonly productId: string;
  readonly unitCode: string;
  readonly qtyDeliveredBase: number;
  readonly qtyRejectedBase: number;
  readonly qtyAcceptedBase: number;
  readonly overReceiptQtyBase: number;
  readonly rejectionReasonCodeId: string | null;
  readonly unitCostXaf: number;
  readonly supplierLotRef: string | null;
  readonly expiryDate: string | null;
  readonly stockLotId: string | null;
}

export interface GoodsReceiptSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly purchaseOrderId: string | null;
  readonly supplierId: string;
  readonly locationId: string;
  readonly receivedBy: string;
  readonly supplierDeliveryNoteRef: string | null;
  readonly observations: string | null;
  readonly status: string;
  readonly approvalRequestId: string | null;
  readonly totalAcceptedValueXaf: number;
  readonly distinctNoteConfirmed: boolean;
  readonly occurredAt: string;
  readonly capturedOffline: boolean;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
  readonly cancelComment: string | null;
  readonly lines: readonly GoodsReceiptLine[];
}

export interface GoodsReceiptFilter {
  readonly siteIds?: readonly string[];
  readonly siteId?: string;
  readonly purchaseOrderId?: string;
  readonly supplierId?: string;
  readonly status?: string;
  /** Heure métier incluse : `occurred_at` ≥ `from` et < `to`. */
  readonly from?: Date;
  readonly to?: Date;
  readonly beforeId?: string;
  readonly limit: number;
}

async function receiptLinesById(
  executor: Executor,
  receiptIds: readonly Buffer[],
): Promise<Map<string, GoodsReceiptLine[]>> {
  const byReceipt = new Map<string, GoodsReceiptLine[]>();
  if (receiptIds.length === 0) return byReceipt;
  const rows = await executor
    .selectFrom('procurement_goods_receipt_lines')
    .selectAll()
    .where('receipt_id', 'in', receiptIds)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  for (const row of rows) {
    const key = fromBin(row.receipt_id);
    const list = byReceipt.get(key) ?? [];
    list.push({
      id: fromBin(row.id),
      poLineId: fromBinOrNull(row.po_line_id),
      productId: fromBin(row.product_id),
      unitCode: row.unit_code,
      qtyDeliveredBase: qty(row.qty_delivered_base),
      qtyRejectedBase: qty(row.qty_rejected_base),
      qtyAcceptedBase: qty(row.qty_accepted_base ?? 0),
      overReceiptQtyBase: qty(row.over_receipt_qty_base),
      rejectionReasonCodeId: fromBinOrNull(row.rejection_reason_code_id),
      unitCostXaf: Number(row.unit_cost_xaf),
      supplierLotRef: row.supplier_lot_ref,
      expiryDate: formatDate(row.expiry_date),
      stockLotId: fromBinOrNull(row.stock_lot_id),
    });
    byReceipt.set(key, list);
  }
  return byReceipt;
}

type ReceiptRow = Selectable<DB['procurement_goods_receipts']>;

function toReceiptSummary(
  row: ReceiptRow,
  lines: Map<string, GoodsReceiptLine[]>,
): GoodsReceiptSummary {
  const id = fromBin(row.id);
  return {
    id,
    docNumber: row.doc_number,
    siteId: fromBin(row.site_id),
    purchaseOrderId: fromBinOrNull(row.purchase_order_id),
    supplierId: fromBin(row.supplier_id),
    locationId: fromBin(row.location_id),
    receivedBy: fromBin(row.received_by),
    supplierDeliveryNoteRef: row.supplier_delivery_note_ref,
    observations: row.observations,
    status: row.status,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    totalAcceptedValueXaf: Number(row.total_accepted_value_xaf),
    distinctNoteConfirmed: Boolean(row.distinct_note_confirmed),
    occurredAt: row.occurred_at.toISOString(),
    capturedOffline: Boolean(row.captured_offline),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelledBy: fromBinOrNull(row.cancelled_by),
    cancelComment: row.cancel_comment,
    lines: lines.get(id) ?? [],
  };
}

export async function listGoodsReceipts(
  executor: Executor,
  filter: GoodsReceiptFilter,
): Promise<Page<GoodsReceiptSummary>> {
  if (filter.siteIds && filter.siteIds.length === 0) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('procurement_goods_receipts')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.purchaseOrderId !== undefined, (qb) =>
      qb.where('purchase_order_id', '=', toBin(filter.purchaseOrderId!)),
    )
    .$if(filter.supplierId !== undefined, (qb) =>
      qb.where('supplier_id', '=', toBin(filter.supplierId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.from !== undefined, (qb) => qb.where('occurred_at', '>=', filter.from!))
    .$if(filter.to !== undefined, (qb) => qb.where('occurred_at', '<', filter.to!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  const lines = await receiptLinesById(
    executor,
    page.rows.map((row) => row.id),
  );
  return {
    items: page.rows.map((row) => toReceiptSummary(row, lines)),
    nextCursor: page.nextCursor,
  };
}

export async function getGoodsReceipt(
  executor: Executor,
  receiptId: string,
): Promise<GoodsReceiptSummary | undefined> {
  const row = await executor
    .selectFrom('procurement_goods_receipts')
    .selectAll()
    .where('id', '=', toBin(receiptId))
    .executeTakeFirst();
  if (!row) return undefined;
  return toReceiptSummary(row, await receiptLinesById(executor, [row.id]));
}

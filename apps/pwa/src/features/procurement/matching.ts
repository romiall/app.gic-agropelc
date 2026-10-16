/**
 * Rapprochement des bons de commande (ECR-APP-05, P8E-07 ; D08 UC-APP-12 ; BR-APP-007, 009, 010, 012 ;
 * ADR-043, ADR-047 §8 ; AV-302). Logique pure : groupes de statuts lus (`GET /purchase-orders`, un
 * statut par lecture), indicateurs d'écart d'un bon calculés depuis ses lignes (reliquat, rejeté, en
 * quarantaine, excédent de réception, facturé au-delà de l'accepté, date prévue dépassée — simple
 * constat, l'alerte de réception incomplète est celle de P9), formes du détail (`/matching`, réceptions,
 * factures). Les quantités sont en unité de base du produit.
 */

/** Ligne d'un bon lue dans la liste (`PurchaseOrderLine`, P8E-07 : livré, rejeté, quarantaine). */
export interface MatchingOrderLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  /** Unité d'achat du bon : jamais celle des quantités (unité de base du produit). */
  readonly unitCode: string;
  readonly orderedQtyBase: number;
  readonly deliveredQtyBase: number;
  readonly rejectedQtyBase: number;
  readonly quarantinedQtyBase: number;
  readonly acceptedQtyBase: number;
  readonly closedQtyBase: number;
  readonly excessQtyBase: number;
  readonly invoicedQtyBase: number;
  readonly remainingQtyBase: number;
  /** Nuls sans droit de valorisation (`inventory.valuation.read`, RC-05). */
  readonly unitPriceXaf: number | null;
  readonly lineTotalXaf: number | null;
  readonly status: string;
}

/** Bon de commande lu dans la liste. */
export interface MatchingOrder {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly expectedDeliveryDate: string | null;
  readonly status: string;
  readonly totalXaf: number | null;
  readonly sentAt: string | null;
  readonly closedReason: string | null;
  readonly occurredAt: string;
  readonly lines: readonly MatchingOrderLine[];
}

/** Ligne du rapprochement détaillé (`GET /purchase-orders/{id}/matching`). */
export interface MatchingDetailLine {
  readonly poLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly unitCode: string;
  readonly status: string;
  readonly orderedQtyBase: number;
  readonly deliveredQtyBase: number;
  readonly rejectedQtyBase: number;
  readonly acceptedQtyBase: number;
  readonly quarantinedQtyBase: number;
  readonly closedQtyBase: number;
  readonly excessQtyBase: number;
  readonly remainingQtyBase: number;
  readonly invoicedQtyBase: number;
  readonly unitPriceXaf: number | null;
  readonly orderedValueXaf: number | null;
  readonly acceptedValueXaf: number | null;
  readonly invoicedValueXaf: number | null;
}

export interface MatchingDetail {
  readonly orderId: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly status: string;
  readonly lines: readonly MatchingDetailLine[];
  readonly totals: {
    readonly orderedValueXaf: number | null;
    readonly acceptedValueXaf: number | null;
    readonly invoicedValueXaf: number | null;
    /** Payé : lecteurs des dettes seulement (`finance.payable.read`) ; nul sinon. */
    readonly paidXaf: number | null;
  };
}

/** Réception d'un bon (`GET /receipts?purchase_order_id=`). */
export interface ReceiptItem {
  readonly id: string;
  readonly docNumber: string;
  readonly status: string;
  readonly supplierDeliveryNoteRef: string | null;
  readonly occurredAt: string;
  readonly cancelComment: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly poLineId: string | null;
    readonly productId: string;
    readonly qtyDeliveredBase: number;
    readonly qtyRejectedBase: number;
    readonly qtyAcceptedBase: number;
  }[];
}

/** Groupes de la liste, dans l'ordre du choix (SM-PURCHASE-ORDER, bons envoyés au fournisseur). */
export const MATCHING_GROUPS = {
  OPEN: ['SENT', 'PARTIALLY_RECEIVED'],
  RECEIVED: ['RECEIVED'],
  CLOSED: ['CLOSED'],
} as const satisfies Record<string, readonly string[]>;
export type MatchingGroup = keyof typeof MATCHING_GROUPS;
export const MATCHING_GROUP_ORDER: readonly MatchingGroup[] = ['OPEN', 'RECEIVED', 'CLOSED'];

export const MATCHING_PAGE_LIMIT = 200;
export const MATCHING_MAX_PAGES = 5;

/** Chemins de lecture d'un groupe, un par statut, pour un fournisseur s'il est choisi. */
export function matchingListPaths(group: MatchingGroup, supplierId: string): string[] {
  const supplier = supplierId ? `&supplier_id=${encodeURIComponent(supplierId)}` : '';
  return MATCHING_GROUPS[group].map(
    (status) => `/api/v1/purchase-orders?status=${status}&limit=${MATCHING_PAGE_LIMIT}${supplier}`,
  );
}

export const receiptsPath = (orderId: string) =>
  `/api/v1/receipts?purchase_order_id=${orderId}&limit=${MATCHING_PAGE_LIMIT}`;

export const orderInvoicesPath = (orderId: string) =>
  `/api/v1/supplier-invoices?purchase_order_id=${orderId}&limit=${MATCHING_PAGE_LIMIT}`;

/**
 * Bons réunis de plusieurs statuts : le plus récent d'abord. Un bon qui change de statut entre deux
 * lectures apparaît une fois, dans sa dernière lecture (statut le plus avancé de l'ordre du groupe).
 */
export function sortOrders<T extends Pick<MatchingOrder, 'occurredAt' | 'id'>>(
  items: readonly T[],
): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
  );
}

export function sortReceipts(items: readonly ReceiptItem[]): ReceiptItem[] {
  return [...items].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
  );
}

/** Quantités comparées en millièmes (trois décimales au plus, ADR-016). */
const milli = (value: number) => Math.round(value * 1000);

/** Écarts d'une ligne, dans l'ordre d'affichage. */
export type LineGap = 'REMAINING' | 'REJECTED' | 'QUARANTINED' | 'EXCESS' | 'OVER_INVOICED';

export function lineGaps(
  line: Pick<
    MatchingOrderLine,
    | 'status'
    | 'remainingQtyBase'
    | 'rejectedQtyBase'
    | 'quarantinedQtyBase'
    | 'excessQtyBase'
    | 'invoicedQtyBase'
    | 'acceptedQtyBase'
  >,
): LineGap[] {
  if (line.status === 'CANCELLED') return [];
  const gaps: LineGap[] = [];
  if (milli(line.remainingQtyBase) > 0) gaps.push('REMAINING');
  if (milli(line.rejectedQtyBase) > 0) gaps.push('REJECTED');
  if (milli(line.quarantinedQtyBase) > 0) gaps.push('QUARANTINED');
  if (milli(line.excessQtyBase) > 0) gaps.push('EXCESS');
  // Facture approuvée au-delà de l'accepté (décision de la Finance, ADR-043 ; AV-274).
  if (milli(line.invoicedQtyBase) > milli(line.acceptedQtyBase)) gaps.push('OVER_INVOICED');
  return gaps;
}

export interface OrderIndicators {
  /** Lignes avec un reliquat (commandé − accepté − clôturé). */
  readonly remainingLines: number;
  readonly rejected: boolean;
  readonly quarantined: boolean;
  readonly excess: boolean;
  readonly overInvoiced: boolean;
  /**
   * Jours depuis la date de livraison prévue d'un bon encore attendu (envoyé ou reçu en partie, avec
   * un reliquat) ; `null` sinon. Simple constat, sans seuil (AV-302) : l'alerte est celle de P9.
   */
  readonly overdueDays: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Jours de `from` à `to` (dates AAAA-MM-JJ du calendrier). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function orderIndicators(
  order: Pick<MatchingOrder, 'status' | 'expectedDeliveryDate' | 'lines'>,
  today: string,
): OrderIndicators {
  const gaps = order.lines.map(lineGaps);
  const has = (gap: LineGap) => gaps.some((list) => list.includes(gap));
  const remainingLines = gaps.filter((list) => list.includes('REMAINING')).length;
  const awaited = order.status === 'SENT' || order.status === 'PARTIALLY_RECEIVED';
  const expected = order.expectedDeliveryDate;
  const late =
    awaited &&
    remainingLines > 0 &&
    expected !== null &&
    DATE_ONLY.test(expected) &&
    DATE_ONLY.test(today) &&
    expected < today;
  return {
    remainingLines,
    rejected: has('REJECTED'),
    quarantined: has('QUARANTINED'),
    excess: has('EXCESS'),
    overInvoiced: has('OVER_INVOICED'),
    overdueDays: late ? daysBetween(expected, today) : null,
  };
}

/** Un écart à examiner : rejet, quarantaine, excédent, facturé au-delà, ou livraison attendue en retard. */
export function hasGap(indicators: OrderIndicators): boolean {
  return (
    indicators.rejected ||
    indicators.quarantined ||
    indicators.excess ||
    indicators.overInvoiced ||
    indicators.overdueDays !== null
  );
}

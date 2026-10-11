/**
 * ECR-APP-03 « Bons de commande » (responsable des achats ; en ligne ; D08, SM-PURCHASE-ORDER ;
 * BR-APP-001 à 006, AV-051) : logique pure.
 *
 * - Liste lue sur `GET /purchase-orders` (par statut, page par page) ; actions selon le statut :
 *   brouillon modifiable (`procurement.order.update` : date prévue, quantité et prix des lignes,
 *   annulation de lignes), soumis (`.submit` : approuvé d'office jusqu'au seuil
 *   `procurement.po_approval_threshold_xaf`, sinon validation de la Direction), marqué envoyé
 *   (`.mark_sent`), reliquat clôturé avec motif (`.close_remaining`), annulé sans réception
 *   (`.cancel`, commentaire, motif `CANCELLATION` facultatif).
 * - Création (`procurement.order.create`, agrégat `PURCHASE_ORDER`) : fournisseur actif, emplacement
 *   de livraison physique actif, date prévue, 1 à 200 lignes ; chaque ligne vient d'une ligne de
 *   demande approuvée (quantité au plus le reste à commander, même produit) ou d'un produit
 *   achetable, dans une unité d'achat convertie en unité de base, au prix par unité de base. Total
 *   calculé par `orderAmounts` (packages/domain), comme le serveur.
 */
import { DomainError, orderAmounts, quantityFromDecimal } from '@gic/domain';
import type { SaleUnit } from '../sales/sale-form.js';
import { checkTransferLine, type TransferLineDraft } from '../stock/transfer.js';

export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;
export const MAX_ORDER_LINES = 200;
export const DEFAULT_APPROVAL_THRESHOLD_XAF = 500_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Ligne de bon de commande lue (`unitPriceXaf`, `lineTotalXaf` nuls sans droit de valorisation). */
export interface OrderLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly unitCode: string;
  readonly orderedQtyBase: number;
  readonly acceptedQtyBase: number;
  readonly remainingQtyBase: number;
  readonly unitPriceXaf: number | null;
  readonly lineTotalXaf: number | null;
  readonly status: string;
  readonly requestLineId: string | null;
}

/** Bon de commande renvoyé par `GET /api/v1/purchase-orders`. */
export interface OrderView {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly deliveryLocationId: string;
  readonly expectedDeliveryDate: string | null;
  readonly status: string;
  readonly totalXaf: number | null;
  readonly sentAt: string | null;
  readonly closedReason: string | null;
  readonly occurredAt: string;
  readonly lines: readonly OrderLineView[];
}

/** Demande d'achat renvoyée par `GET /api/v1/purchase-requests`. */
export interface RequestView {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly status: string;
  readonly lines: readonly {
    readonly id: string;
    readonly productId: string;
    readonly unitCode: string;
    readonly quantityBase: number;
    readonly remainingToOrderBase: number;
    readonly estimatedUnitPriceXaf: number | null;
  }[];
}

/** Actions proposées selon le statut (SM-PURCHASE-ORDER). */
export function orderActions(status: string): {
  readonly edit: boolean;
  readonly submit: boolean;
  readonly markSent: boolean;
  readonly closeRemaining: boolean;
  readonly cancel: boolean;
} {
  return {
    edit: status === 'DRAFT',
    submit: status === 'DRAFT',
    markSent: status === 'APPROVED',
    closeRemaining: status === 'PARTIALLY_RECEIVED',
    cancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(status),
  };
}

/** Lignes de demandes approuvées encore à commander. */
export interface OrderableLine {
  readonly requestId: string;
  readonly requestDoc: string;
  readonly requestLineId: string;
  readonly productId: string;
  readonly unitCode: string;
  readonly remainingBase: number;
  readonly estimatedUnitPriceXaf: number | null;
}

export function orderableLines(requests: readonly RequestView[]): OrderableLine[] {
  return requests
    .filter((request) => request.status === 'APPROVED' || request.status === 'PARTIALLY_ORDERED')
    .flatMap((request) =>
      request.lines
        .filter((line) => line.remainingToOrderBase > 0)
        .map((line) => ({
          requestId: request.id,
          requestDoc: request.docNumber,
          requestLineId: line.id,
          productId: line.productId,
          unitCode: line.unitCode,
          remainingBase: line.remainingToOrderBase,
          estimatedUnitPriceXaf: line.estimatedUnitPriceXaf,
        })),
    );
}

/** Ligne saisie d'un nouveau bon : directe, ou tirée d'une ligne de demande. */
export interface OrderLineDraft extends TransferLineDraft {
  readonly requestLineId: string | null;
  /** Reste à commander de la ligne de demande (unité de base). */
  readonly remainingBase: number | null;
  readonly priceText: string;
}

export type OrderLineIssue =
  'PRODUCT_REQUIRED' | 'QUANTITY_INVALID' | 'OVER_REQUEST' | 'PRICE_INVALID';

export interface OrderLineCheck {
  readonly draft: OrderLineDraft;
  readonly quantity: number | null;
  readonly quantityBase: number | null;
  readonly unitPriceXaf: number | null;
  readonly issues: readonly OrderLineIssue[];
}

const parsePriceXaf = (text: string): number | null => {
  const normalized = text.trim().replace(/\s/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) ? value : null;
};

export function checkOrderLine(draft: OrderLineDraft, unit: SaleUnit | undefined): OrderLineCheck {
  const base = checkTransferLine(draft, unit);
  const issues: OrderLineIssue[] = base.issue ? [base.issue] : [];
  if (
    base.quantityBase !== null &&
    draft.remainingBase !== null &&
    Math.round(base.quantityBase * 1000) > Math.round(draft.remainingBase * 1000)
  ) {
    issues.push('OVER_REQUEST');
  }
  const unitPriceXaf = parsePriceXaf(draft.priceText);
  if (unitPriceXaf === null) issues.push('PRICE_INVALID');
  return {
    draft,
    quantity: base.quantity,
    quantityBase: base.quantityBase,
    unitPriceXaf,
    issues,
  };
}

/** Total du bon (arrondi au franc par ligne, comme le serveur) ; `null` si une ligne est invalide. */
export function orderTotal(
  lines: readonly { readonly quantityBase: number | null; readonly unitPriceXaf: number | null }[],
): number | null {
  if (lines.length === 0) return 0;
  if (lines.some((line) => line.quantityBase === null || line.unitPriceXaf === null)) return null;
  try {
    return orderAmounts(
      lines.map((line) => ({
        quantity: quantityFromDecimal(line.quantityBase as number),
        unitPriceXaf: line.unitPriceXaf as number,
      })),
    ).total as number;
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

export type OrderIssue =
  | 'SUPPLIER_REQUIRED'
  | 'LOCATION_REQUIRED'
  | 'DATE_INVALID'
  | 'LINES_REQUIRED'
  | 'TOO_MANY_LINES'
  | 'DUPLICATE_REQUEST_LINE';

export function checkOrder(input: {
  readonly supplierId: string;
  readonly deliveryLocationId: string;
  readonly expectedDeliveryDate: string;
  readonly lines: readonly OrderLineCheck[];
}): OrderIssue[] {
  const issues: OrderIssue[] = [];
  if (!input.supplierId) issues.push('SUPPLIER_REQUIRED');
  if (!input.deliveryLocationId) issues.push('LOCATION_REQUIRED');
  if (input.expectedDeliveryDate && !DATE_ONLY.test(input.expectedDeliveryDate)) {
    issues.push('DATE_INVALID');
  }
  if (input.lines.length === 0) issues.push('LINES_REQUIRED');
  if (input.lines.length > MAX_ORDER_LINES) issues.push('TOO_MANY_LINES');
  const requestLines = input.lines
    .map((line) => line.draft.requestLineId)
    .filter((id): id is string => id !== null);
  if (new Set(requestLines).size !== requestLines.length) issues.push('DUPLICATE_REQUEST_LINE');
  return issues;
}

export function createOrderPayload(input: {
  readonly supplierId: string;
  readonly deliveryLocationId: string;
  readonly expectedDeliveryDate: string;
  readonly lines: readonly OrderLineCheck[];
}) {
  return {
    supplierId: input.supplierId,
    deliveryLocationId: input.deliveryLocationId,
    ...(input.expectedDeliveryDate ? { expectedDeliveryDate: input.expectedDeliveryDate } : {}),
    lines: input.lines.map((line) => ({
      productId: line.draft.productId,
      unitCode: line.draft.unitCode,
      orderedQtyBase: line.quantityBase as number,
      unitPriceXaf: line.unitPriceXaf as number,
      ...(line.draft.requestLineId ? { requestLineId: line.draft.requestLineId } : {}),
    })),
  };
}

/** Modification d'une ligne d'un brouillon : quantité de base et prix (textes), ou annulation. */
export interface DraftLineEdit {
  readonly qtyText: string;
  readonly priceText: string;
  readonly cancel: boolean;
}

const parseBaseQty = (text: string): number | null => {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && value <= 99_999_999_999.999 ? value : null;
};

export type DraftEditIssue = 'LINE_INVALID' | 'ORDER_EMPTY' | 'DATE_INVALID' | 'NOTHING';

/**
 * Charge utile de `procurement.order.update` pour un brouillon : lignes changées seulement, date
 * prévue changée (vide : retirée). `issues` vide quand la modification est envoyable.
 */
export function draftUpdate(
  order: OrderView,
  edits: ReadonlyMap<string, DraftLineEdit>,
  expectedDeliveryDate: string,
): { readonly issues: readonly DraftEditIssue[]; readonly payload: Record<string, unknown> } {
  const issues: DraftEditIssue[] = [];
  const lines: Record<string, unknown>[] = [];
  let active = 0;
  for (const line of order.lines) {
    if (line.status === 'CANCELLED') continue;
    const edit = edits.get(line.id);
    if (!edit) {
      active += 1;
      continue;
    }
    if (edit.cancel) {
      lines.push({ lineNo: line.lineNo, cancel: true });
      continue;
    }
    active += 1;
    const qty = parseBaseQty(edit.qtyText);
    const price = parsePriceXaf(edit.priceText);
    if (qty === null || price === null) {
      issues.push('LINE_INVALID');
      continue;
    }
    const change: Record<string, unknown> = {};
    if (Math.round(qty * 1000) !== Math.round(line.orderedQtyBase * 1000))
      change.orderedQtyBase = qty;
    if (line.unitPriceXaf === null || price !== line.unitPriceXaf) change.unitPriceXaf = price;
    if (Object.keys(change).length > 0) lines.push({ lineNo: line.lineNo, ...change });
  }
  if (active === 0) issues.push('ORDER_EMPTY');
  const payload: Record<string, unknown> = {};
  if (expectedDeliveryDate !== (order.expectedDeliveryDate ?? '')) {
    if (expectedDeliveryDate && !DATE_ONLY.test(expectedDeliveryDate)) issues.push('DATE_INVALID');
    payload.expectedDeliveryDate = expectedDeliveryDate || null;
  }
  if (lines.length > 0) payload.lines = lines;
  if (Object.keys(payload).length === 0 && issues.length === 0) issues.push('NOTHING');
  return { issues: [...new Set(issues)], payload };
}

/** Annulation : commentaire exigé, motif `CANCELLATION` facultatif. */
export function cancelPayload(comment: string, reasonCodeId: string) {
  return {
    comment: comment.trim(),
    ...(reasonCodeId ? { reasonCodeId } : {}),
  };
}

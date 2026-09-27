/**
 * Règles partagées des achats (D08-APP ; SM-PURCHASE-REQUEST, SM-PURCHASE-ORDER, SM-RECEIPT) :
 * quantités d'une ligne de réception, reliquats et excédent d'un bon de commande, statuts dérivés,
 * montants. Pur, sans entrée-sortie, identique sur l'appareil (réception hors ligne) et le serveur
 * (ADR-021). Quantités en millièmes entiers (`Quantity`), montants en XAF entiers (ADR-013) ;
 * seuils fournis par l'appelant depuis les paramètres système (CLAUDE.md règle 8).
 */
import { DomainError } from './errors.js';
import { addXaf, xaf, type Xaf } from './money.js';
import {
  ZERO_QUANTITY,
  addQuantity,
  isPositiveQuantity,
  quantityFromMilli,
  quantityMilliUnits,
  subtractQuantity,
  type Quantity,
} from './quantity.js';
import { lineAmountXaf } from './rounding.js';

/**
 * BR-APP-007, INV-APP-01 : accepté = livré − rejeté, avec livré > 0 et 0 ≤ rejeté ≤ livré
 * (`RECEIPT_LINE_INVALID`). Un rejet exige un motif (`REJECTION_REASON_REQUIRED`, vérifié par
 * l'appelant qui connaît le motif). Rejet complet (livré = rejeté) admis : produit non commandé.
 */
export function receiptLineQuantities(input: {
  readonly delivered: Quantity;
  readonly rejected: Quantity;
}): { readonly accepted: Quantity; readonly hasRejection: boolean } {
  if (!isPositiveQuantity(input.delivered)) {
    throw new DomainError('Quantité livrée strictement positive attendue.', 'RECEIPT_LINE_INVALID');
  }
  const rejected = quantityMilliUnits(input.rejected);
  if (rejected < 0 || rejected > quantityMilliUnits(input.delivered)) {
    throw new DomainError(
      'Quantité rejetée comprise entre 0 et la quantité livrée attendue.',
      'RECEIPT_LINE_INVALID',
    );
  }
  return {
    accepted: subtractQuantity(input.delivered, input.rejected),
    hasRejection: rejected > 0,
  };
}

export interface OrderLineProgress {
  readonly ordered: Quantity;
  /** Σ accepté des réceptions comptabilisées (`accepted_qty_base`). */
  readonly accepted: Quantity;
  /** Reliquat clôturé manuellement (`closed_qty_base`). */
  readonly closed: Quantity;
  readonly cancelled?: boolean;
}

/** BR-APP-009 : reliquat = commandé − accepté − clôturé, jamais négatif (l'excédent est à part). */
export function orderLineRemaining(line: OrderLineProgress): Quantity {
  if (line.cancelled) return ZERO_QUANTITY;
  const remaining =
    quantityMilliUnits(line.ordered) -
    quantityMilliUnits(line.accepted) -
    quantityMilliUnits(line.closed);
  return quantityFromMilli(Math.max(0, remaining));
}

/**
 * BR-APP-010, AV-053 : part d'une nouvelle acceptation au-delà de ce que la ligne admet —
 * commandé − clôturé, majoré de la tolérance (pourcentage du commandé, 0 par défaut, arrondi au
 * millième inférieur). Zéro si l'acceptation tient dans la ligne.
 */
export function overReceiptQuantity(
  line: OrderLineProgress,
  accepting: Quantity,
  tolerancePct: number,
): Quantity {
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0) {
    throw new DomainError('Tolérance de réception invalide.', 'TOLERANCE_INVALID');
  }
  const ordered = quantityMilliUnits(line.ordered);
  const allowed =
    ordered - quantityMilliUnits(line.closed) + Math.floor((ordered * tolerancePct) / 100);
  const total = quantityMilliUnits(line.accepted) + quantityMilliUnits(accepting);
  return quantityFromMilli(Math.max(0, total - allowed));
}

export type ReceivableOrderStatus = 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED';

/**
 * BR-APP-009 : statut d'un BC envoyé d'après ses lignes non annulées — `RECEIVED` quand tous les
 * reliquats sont nuls sans clôture, `CLOSED` quand ils le sont grâce à une clôture de reliquat,
 * `PARTIALLY_RECEIVED` dès qu'une quantité est acceptée, `SENT` sinon.
 */
export function orderStatusFromLines(lines: readonly OrderLineProgress[]): ReceivableOrderStatus {
  const active = lines.filter((line) => !line.cancelled);
  const allDone = active.every((line) => quantityMilliUnits(orderLineRemaining(line)) === 0);
  const anyClosed = active.some((line) => isPositiveQuantity(line.closed));
  const anyAccepted = active.some((line) => isPositiveQuantity(line.accepted));
  if (active.length > 0 && allDone) return anyClosed ? 'CLOSED' : 'RECEIVED';
  return anyAccepted ? 'PARTIALLY_RECEIVED' : 'SENT';
}

export type OrderedRequestStatus = 'APPROVED' | 'PARTIALLY_ORDERED' | 'ORDERED';

/** BR-APP-004 : une DA approuvée suit la quantité commandée de ses lignes. */
export function requestStatusFromLines(
  lines: readonly { readonly requested: Quantity; readonly ordered: Quantity }[],
): OrderedRequestStatus {
  const anyOrdered = lines.some((line) => isPositiveQuantity(line.ordered));
  const allOrdered =
    lines.length > 0 &&
    lines.every((line) => quantityMilliUnits(line.ordered) >= quantityMilliUnits(line.requested));
  if (allOrdered) return 'ORDERED';
  return anyOrdered ? 'PARTIALLY_ORDERED' : 'APPROVED';
}

/**
 * BR-APP-005 : montants d'un BC — chaque ligne = quantité (unité de base) × prix unitaire de base,
 * arrondi au franc (demi supérieur, BR-VEN-014) ; total = Σ lignes. Prix ≥ 0 (`PRICE_INVALID`).
 */
export function orderAmounts(
  lines: readonly { readonly quantity: Quantity; readonly unitPriceXaf: number }[],
): { readonly lineTotals: readonly Xaf[]; readonly total: Xaf } {
  const lineTotals = lines.map((line) => {
    if (!Number.isInteger(line.unitPriceXaf) || line.unitPriceXaf < 0) {
      throw new DomainError('Prix unitaire en XAF entier positif ou nul attendu.', 'PRICE_INVALID');
    }
    if (!isPositiveQuantity(line.quantity)) {
      throw new DomainError(
        'Quantité commandée strictement positive attendue.',
        'QUANTITY_INVALID',
      );
    }
    return lineAmountXaf(line.quantity, xaf(line.unitPriceXaf));
  });
  return { lineTotals, total: lineTotals.length > 0 ? addXaf(...lineTotals) : xaf(0) };
}

/** BR-APP-005, AV-051 : approbation de la Direction au-delà du seuil (strictement supérieur). */
export function orderRequiresApproval(totalXaf: Xaf, thresholdXaf: number): boolean {
  return (totalXaf as number) > thresholdXaf;
}

/** Valeur acceptée d'une réception (`total_accepted_value_xaf`) : Σ accepté × coût unitaire. */
export function receiptAcceptedValueXaf(
  lines: readonly { readonly accepted: Quantity; readonly unitCostXaf: number }[],
): Xaf {
  const values = lines.map((line) => lineAmountXaf(line.accepted, xaf(line.unitCostXaf)));
  return values.length > 0 ? addXaf(...values) : xaf(0);
}

/** Σ des quantités (ex. accepté cumulé d'une ligne de BC). */
export function sumQuantities(values: readonly Quantity[]): Quantity {
  return values.length > 0 ? addQuantity(...values) : ZERO_QUANTITY;
}

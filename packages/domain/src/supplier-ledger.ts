/**
 * Factures et paiements fournisseurs : règles pures (P8 ; ADR-021, ADR-061 ; SM-SUPPLIER-INVOICE,
 * SM-SUPPLIER-PAYMENT, WF-09 ; D09 BR-FIN-030 à 033 ; INV-FIN-07 ; AV-053, AV-055, AV-358 à
 * AV-363). Sans entrée-sortie : l'appelant fournit le bon de commande rapproché (prix, accepté,
 * déjà facturé), les factures et les paramètres déjà lus.
 *
 * - **Rapprochement** (BR-FIN-031) : {@link matchSupplierInvoice} — quantité facturée cumulée ≤
 *   acceptée et prix facturé = prix du BC, aux tolérances près (nulles par défaut, AV-053) ; tout
 *   autre écart (ligne hors BC, fournisseur, montant de ligne, total imprimé, facture sans BC en
 *   mode revue) met la facture en `MISMATCH`.
 * - **Paiement** (BR-FIN-032, 033, INV-FIN-07) : {@link planSupplierPayment} vérifie les
 *   affectations contre le solde de chaque facture et le montant du paiement ; le reste est une
 *   avance, admise par paramètre (AV-362).
 * - **Statuts** : transitions des deux machines, statut payé d'une facture tiré de ses affectations.
 */
import { addBusinessDays } from './business-day.js';
import { DomainError } from './errors.js';
import { addXaf, xaf, type Xaf } from './money.js';
import { ZERO_QUANTITY, addQuantity, quantityMilliUnits, type Quantity } from './quantity.js';
import { lineAmountXaf } from './rounding.js';

/** États d'une facture fournisseur (SM-SUPPLIER-INVOICE). */
export const SUPPLIER_INVOICE_STATUSES = [
  'MISMATCH',
  'DISPUTED',
  'APPROVED',
  'PARTIALLY_PAID',
  'PAID',
  'CANCELLED',
] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

/** États d'un paiement fournisseur (SM-SUPPLIER-PAYMENT). */
export const SUPPLIER_PAYMENT_STATUSES = [
  'PENDING_APPROVAL',
  'RECORDED',
  'REJECTED',
  'CANCELLED',
] as const;
export type SupplierPaymentStatus = (typeof SUPPLIER_PAYMENT_STATUSES)[number];

/** États d'une affectation (ADR-061 §6 et §7) : prévue avant la validation, active, contrepassée. */
export const SUPPLIER_ALLOCATION_STATUSES = ['PLANNED', 'ACTIVE', 'REVERSED'] as const;
export type SupplierAllocationStatus = (typeof SUPPLIER_ALLOCATION_STATUSES)[number];

/** Mode d'une facture sans bon de commande (AV-358, `finance.invoice_without_po_mode`). */
export const INVOICE_WITHOUT_PO_MODES = ['REVIEW', 'APPROVE'] as const;
export type InvoiceWithoutPoMode = (typeof INVOICE_WITHOUT_PO_MODES)[number];

/** Motifs d'écart d'une facture (`mismatch_details`). */
export const INVOICE_MISMATCH_REASONS = [
  'NO_PURCHASE_ORDER',
  'SUPPLIER_MISMATCH',
  'LINE_NOT_ON_ORDER',
  'QUANTITY_ABOVE_ACCEPTED',
  'PRICE_MISMATCH',
  'LINE_AMOUNT_MISMATCH',
  'TOTAL_MISMATCH',
] as const;
export type InvoiceMismatchReason = (typeof INVOICE_MISMATCH_REASONS)[number];

export interface InvoiceMismatchDetail {
  readonly reason: InvoiceMismatchReason;
  /** Index de la ligne de facture concernée, s'il y en a une. */
  readonly lineIndex: number | null;
  readonly poLineId: string | null;
  /** Valeur attendue et valeur facturée : quantité décimale, prix ou montant en XAF. */
  readonly expected: number | null;
  readonly actual: number | null;
}

export interface InvoiceLineInput {
  readonly poLineId: string | null;
  readonly quantity: Quantity | null;
  readonly unitPriceXaf: number | null;
  readonly lineTotalXaf: number;
}

export interface MatchedOrderLine {
  readonly poLineId: string;
  readonly unitPriceXaf: number;
  /** Accepté de la ligne de BC (réceptions comptabilisées). */
  readonly accepted: Quantity;
  /** Déjà facturé par les factures approuvées (`invoiced_qty_base`). */
  readonly invoiced: Quantity;
}

export interface SupplierInvoiceMatch {
  readonly conforming: boolean;
  readonly totalXaf: Xaf;
  readonly details: readonly InvoiceMismatchDetail[];
}

const detail = (
  reason: InvoiceMismatchReason,
  fields: Partial<Omit<InvoiceMismatchDetail, 'reason'>> = {},
): InvoiceMismatchDetail => ({
  reason,
  lineIndex: fields.lineIndex ?? null,
  poLineId: fields.poLineId ?? null,
  expected: fields.expected ?? null,
  actual: fields.actual ?? null,
});

const assertAmount = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      `${label} : montant en XAF entier positif ou nul attendu.`,
      'AMOUNT_INVALID',
    );
  }
};

/**
 * Σ des quantités facturées par ligne de BC (lignes rattachées et chiffrées seulement) : le delta
 * appliqué à `invoiced_qty_base` quand la facture devient `APPROVED` (ADR-061 §3).
 */
export function invoicedQuantitiesByOrderLine(
  lines: readonly InvoiceLineInput[],
): ReadonlyMap<string, Quantity> {
  const totals = new Map<string, Quantity>();
  for (const line of lines) {
    if (line.poLineId === null || line.quantity === null) continue;
    totals.set(
      line.poLineId,
      addQuantity(totals.get(line.poLineId) ?? ZERO_QUANTITY, line.quantity),
    );
  }
  return totals;
}

/**
 * Rapprochement d'une facture à l'enregistrement (BR-FIN-031, ADR-061 §2). `order` est nul pour
 * une facture sans BC. Une ligne rattachée à une ligne de BC doit porter quantité et prix, et viser
 * une ligne de ce BC (`INVOICE_LINE_INVALID`, `PO_LINE_MISMATCH`). Tolérances : quantité en pour
 * cent de l'accepté, prix en XAF par unité de base (AV-053).
 */
export function matchSupplierInvoice(input: {
  readonly supplierId: string;
  readonly order: {
    readonly supplierId: string;
    readonly lines: readonly MatchedOrderLine[];
  } | null;
  readonly lines: readonly InvoiceLineInput[];
  readonly printedTotalXaf: number | null;
  readonly qtyTolerancePct: number;
  readonly priceToleranceXaf: number;
  readonly withoutOrderMode: InvoiceWithoutPoMode;
}): SupplierInvoiceMatch {
  if (input.lines.length === 0) {
    throw new DomainError('Une facture porte au moins une ligne.', 'INVOICE_LINE_INVALID');
  }
  input.lines.forEach((line, index) => assertAmount(line.lineTotalXaf, `Ligne ${index + 1}`));
  const totalXaf = addXaf(...input.lines.map((line) => xaf(line.lineTotalXaf)));
  const details: InvoiceMismatchDetail[] = [];

  if (input.order === null) {
    if (input.lines.some((line) => line.poLineId !== null)) {
      throw new DomainError(
        'Une ligne rattachée à un bon de commande exige la facture de ce bon.',
        'PO_LINE_MISMATCH',
      );
    }
    if (input.withoutOrderMode === 'REVIEW') details.push(detail('NO_PURCHASE_ORDER'));
  } else {
    if (input.order.supplierId !== input.supplierId) details.push(detail('SUPPLIER_MISMATCH'));
    const orderLines = new Map(input.order.lines.map((line) => [line.poLineId, line]));
    input.lines.forEach((line, index) => {
      if (line.poLineId === null) {
        details.push(detail('LINE_NOT_ON_ORDER', { lineIndex: index, actual: line.lineTotalXaf }));
        return;
      }
      const orderLine = orderLines.get(line.poLineId);
      if (orderLine === undefined) {
        throw new DomainError(
          `Ligne ${index + 1} : ligne de bon de commande étrangère à ce bon.`,
          'PO_LINE_MISMATCH',
        );
      }
      if (line.quantity === null || line.unitPriceXaf === null) {
        throw new DomainError(
          `Ligne ${index + 1} : quantité et prix unitaire attendus pour une ligne de bon de commande.`,
          'INVOICE_LINE_INVALID',
        );
      }
      assertAmount(line.unitPriceXaf, `Ligne ${index + 1}`);
      if (Math.abs(line.unitPriceXaf - orderLine.unitPriceXaf) > input.priceToleranceXaf) {
        details.push(
          detail('PRICE_MISMATCH', {
            lineIndex: index,
            poLineId: line.poLineId,
            expected: orderLine.unitPriceXaf,
            actual: line.unitPriceXaf,
          }),
        );
      }
      const computed = lineAmountXaf(line.quantity, xaf(line.unitPriceXaf)) as number;
      if (computed !== line.lineTotalXaf) {
        details.push(
          detail('LINE_AMOUNT_MISMATCH', {
            lineIndex: index,
            poLineId: line.poLineId,
            expected: computed,
            actual: line.lineTotalXaf,
          }),
        );
      }
    });
    for (const [poLineId, quantity] of invoicedQuantitiesByOrderLine(input.lines)) {
      const orderLine = orderLines.get(poLineId) as MatchedOrderLine;
      const acceptedMilli = quantityMilliUnits(orderLine.accepted);
      const allowedMilli = Math.floor((acceptedMilli * (100 + input.qtyTolerancePct)) / 100);
      const cumulativeMilli = quantityMilliUnits(orderLine.invoiced) + quantityMilliUnits(quantity);
      if (cumulativeMilli > allowedMilli) {
        details.push(
          detail('QUANTITY_ABOVE_ACCEPTED', {
            poLineId,
            expected: acceptedMilli / 1000,
            actual: cumulativeMilli / 1000,
          }),
        );
      }
    }
  }
  if (input.printedTotalXaf !== null && input.printedTotalXaf !== (totalXaf as number)) {
    details.push(detail('TOTAL_MISMATCH', { expected: totalXaf, actual: input.printedTotalXaf }));
  }
  return { conforming: details.length === 0, totalXaf, details };
}

/** Échéance d'une facture (AV-360) : saisie, sinon date + délai du fournisseur, sinon la date. */
export function supplierInvoiceDueDate(input: {
  readonly invoiceDate: string;
  readonly dueDate: string | null;
  readonly paymentTermsDays: number | null;
}): string {
  if (input.dueDate !== null) {
    if (input.dueDate < input.invoiceDate) {
      throw new DomainError("L'échéance précède la date de facture.", 'INVOICE_DUE_DATE_INVALID');
    }
    return input.dueDate;
  }
  return input.paymentTermsDays === null
    ? input.invoiceDate
    : addBusinessDays(input.invoiceDate, input.paymentTermsDays);
}

export type SupplierInvoiceAction = 'APPROVE' | 'DISPUTE' | 'CANCEL';

/**
 * Transitions décidées de SM-SUPPLIER-INVOICE (le paiement passe par
 * {@link supplierInvoiceStatusFromPaid}). Une facture qui porte des paiements ne s'annule pas
 * (`INVOICE_HAS_PAYMENTS`, AV-359).
 */
export function supplierInvoiceTransition(
  status: SupplierInvoiceStatus,
  action: SupplierInvoiceAction,
  paidXaf: number,
): SupplierInvoiceStatus {
  if (action === 'APPROVE' && (status === 'MISMATCH' || status === 'DISPUTED')) return 'APPROVED';
  if (action === 'DISPUTE' && status === 'MISMATCH') return 'DISPUTED';
  if (action === 'CANCEL') {
    if (status === 'MISMATCH' || status === 'DISPUTED') return 'CANCELLED';
    if (status === 'APPROVED' || status === 'PARTIALLY_PAID' || status === 'PAID') {
      if (paidXaf > 0) {
        throw new DomainError(
          'La facture porte des paiements : annuler d’abord le paiement.',
          'INVOICE_HAS_PAYMENTS',
        );
      }
      return 'CANCELLED';
    }
  }
  throw new DomainError(
    `Action ${action} impossible sur une facture ${status}.`,
    'INVOICE_STATUS_INVALID',
  );
}

/** INV-FIN-07 : statut payé d'une facture approuvée d'après Σ affectations actives. */
export function supplierInvoiceStatusFromPaid(
  totalXaf: number,
  paidXaf: number,
): 'APPROVED' | 'PARTIALLY_PAID' | 'PAID' {
  assertAmount(paidXaf, 'Payé');
  if (paidXaf > totalXaf) {
    throw new DomainError(
      'Les paiements affectés dépassent le montant de la facture.',
      'ALLOCATION_EXCEEDS',
    );
  }
  if (paidXaf === 0) return 'APPROVED';
  return paidXaf < totalXaf ? 'PARTIALLY_PAID' : 'PAID';
}

/** BR-FIN-033, AV-055 : validation de la Direction au-delà du seuil (strictement supérieur). */
export function supplierPaymentRequiresApproval(amountXaf: number, thresholdXaf: number): boolean {
  return amountXaf > thresholdXaf;
}

/** Facture telle que la voit une affectation : fournisseur, statut, solde restant dû. */
export interface PayableInvoice {
  readonly supplierId: string;
  readonly status: SupplierInvoiceStatus;
  readonly balanceXaf: number;
}

/**
 * Affectations d'un paiement (BR-FIN-032, INV-FIN-07, AV-362) : chaque facture appartient au
 * fournisseur, est payable (`APPROVED`, `PARTIALLY_PAID`) et reçoit au plus son solde
 * (`ALLOCATION_EXCEEDS`) ; une facture n'apparaît qu'une fois (`ALLOCATION_INVALID`) ; Σ ≤ montant
 * disponible (`SUPPLIER_PAYMENT_EXCEEDS`). Le reste est une avance, refusée si elle n'est pas
 * admise. Renvoie le reste non affecté.
 */
export function planSupplierPayment(input: {
  readonly supplierId: string;
  readonly availableXaf: number;
  readonly allocations: readonly { readonly invoiceId: string; readonly amountXaf: number }[];
  readonly invoices: ReadonlyMap<string, PayableInvoice>;
  readonly advanceAllowed: boolean;
}): { readonly unallocatedXaf: Xaf } {
  assertAmount(input.availableXaf, 'Paiement');
  const seen = new Set<string>();
  let allocated = 0;
  for (const allocation of input.allocations) {
    if (seen.has(allocation.invoiceId)) {
      throw new DomainError(
        'Une facture apparaît deux fois dans les affectations.',
        'ALLOCATION_INVALID',
      );
    }
    seen.add(allocation.invoiceId);
    if (!Number.isSafeInteger(allocation.amountXaf) || allocation.amountXaf <= 0) {
      throw new DomainError('Affectation strictement positive attendue.', 'AMOUNT_INVALID');
    }
    const invoice = input.invoices.get(allocation.invoiceId);
    if (
      invoice === undefined ||
      invoice.supplierId !== input.supplierId ||
      (invoice.status !== 'APPROVED' && invoice.status !== 'PARTIALLY_PAID')
    ) {
      throw new DomainError(
        'Seule une facture approuvée de ce fournisseur, non soldée, reçoit un paiement.',
        'ALLOCATION_INVALID',
      );
    }
    if (allocation.amountXaf > invoice.balanceXaf) {
      throw new DomainError("L'affectation dépasse le solde de la facture.", 'ALLOCATION_EXCEEDS');
    }
    allocated += allocation.amountXaf;
  }
  if (allocated > input.availableXaf) {
    throw new DomainError(
      'Les affectations dépassent le montant du paiement.',
      'SUPPLIER_PAYMENT_EXCEEDS',
    );
  }
  const unallocated = input.availableXaf - allocated;
  if (unallocated > 0 && !input.advanceAllowed) {
    throw new DomainError(
      'Le paiement dépasse les factures affectées et les avances ne sont pas admises.',
      'SUPPLIER_PAYMENT_EXCEEDS',
    );
  }
  return { unallocatedXaf: xaf(unallocated) };
}

export type SupplierPaymentAction = 'APPROVE' | 'REJECT' | 'CANCEL';

/** Transitions de SM-SUPPLIER-PAYMENT ; refus `SUPPLIER_PAYMENT_STATUS_INVALID` hors table. */
export function supplierPaymentTransition(
  status: SupplierPaymentStatus,
  action: SupplierPaymentAction,
): SupplierPaymentStatus {
  if (status === 'PENDING_APPROVAL') {
    if (action === 'APPROVE') return 'RECORDED';
    if (action === 'REJECT') return 'REJECTED';
    return 'CANCELLED';
  }
  if (status === 'RECORDED' && action === 'CANCEL') return 'CANCELLED';
  throw new DomainError(
    `Action ${action} impossible sur un paiement ${status}.`,
    'SUPPLIER_PAYMENT_STATUS_INVALID',
  );
}

/**
 * Factures fournisseurs (ECR-FIN-03, P8E-05 ; ADR-043, ADR-047 §4 ; AV-271 à AV-274, AV-278). Logique
 * pure : lectures (`GET /supplier-invoices`, `/payables`, `/purchase-orders/{id}/matching`), groupes de
 * statuts, actions proposées (contester, approuver, annuler : SM-SUPPLIER-INVOICE), saisie rapprochée
 * d'un bon de commande avec aperçu indicatif par la règle partagée (`matchSupplierInvoice` : les
 * tolérances et le mode « facture sans BC » ne sont pas servis à l'appareil, les défauts du registre
 * sont appliqués et le serveur tranche), doublon de référence, échéance, charge utile.
 */
import {
  DomainError,
  lineAmountXaf,
  matchSupplierInvoice,
  normalizedInvoiceRef,
  quantityFromDecimal,
  supplierInvoiceDueDate,
  xaf,
  type InvoiceLineInput,
  type InvoiceMismatchDetail,
  type SupplierInvoiceMatch,
} from '@gic/domain';
import { parseQuantity, parseXaf } from '../sales/sale-form.js';

/** Longueurs maximales (`supplierInvoiceRecordPayloadSchema`, `supplierInvoiceDecisionPayloadSchema`). */
export const MAX_INVOICE_REF = 60;
export const MAX_INVOICE_LINE_DESCRIPTION = 200;
export const MAX_INVOICE_COMMENT = 500;
export const MAX_INVOICE_REASON = 500;
export const MAX_INVOICE_LINES = 100;

/** Tolérances et mode sans BC appliqués à l'aperçu (défauts du registre, AV-053, AV-271). */
export const INVOICE_PREVIEW_SETTINGS = {
  qtyTolerancePct: 0,
  priceToleranceXaf: 0,
  withoutOrderMode: 'REVIEW',
} as const;

/** Facture lue (`SupplierInvoiceSummary` de `GET /supplier-invoices`). */
export interface SupplierInvoiceItem {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string | null;
  readonly supplierId: string;
  readonly supplierInvoiceRef: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly purchaseOrderId: string | null;
  readonly totalXaf: number;
  readonly printedTotalXaf: number | null;
  readonly paidXaf: number;
  /** Reste dû ; nul avant l'approbation. */
  readonly balanceXaf: number;
  /** `MISMATCH`, `DISPUTED`, `APPROVED`, `PARTIALLY_PAID`, `PAID`, `CANCELLED`. */
  readonly status: string;
  readonly mismatchDetails: readonly InvoiceMismatchDetail[];
  readonly approvalRequestId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly approvalReason: string | null;
  readonly disputeReason: string | null;
  readonly cancelReason: string | null;
  readonly occurredAt: string;
  readonly createdBy: string;
}

export interface SupplierInvoiceLineItem {
  readonly lineNo: number;
  readonly poLineId: string | null;
  readonly receiptLineId: string | null;
  readonly productId: string | null;
  readonly description: string;
  readonly quantityBase: number | null;
  readonly unitPriceXaf: number | null;
  readonly lineTotalXaf: number;
}

export interface SupplierInvoiceAllocationItem {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountXaf: number;
  /** `PLANNED`, `ACTIVE`, `REVERSED`. */
  readonly status: string;
  readonly activatedAt: string | null;
  readonly reversedAt: string | null;
}

/** Facture détaillée (`GET /supplier-invoices/{id}`). */
export interface SupplierInvoiceDetail extends SupplierInvoiceItem {
  readonly lines: readonly SupplierInvoiceLineItem[];
  readonly allocations: readonly SupplierInvoiceAllocationItem[];
}

export type AgingBucket = '0-30' | '31-60' | '61-90' | '>90';
export const AGING_BUCKETS: readonly AgingBucket[] = ['0-30', '31-60', '61-90', '>90'];

export interface PayableInvoiceItem {
  readonly invoiceId: string;
  readonly docNumber: string;
  readonly supplierInvoiceRef: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly totalXaf: number;
  readonly paidXaf: number;
  readonly balanceXaf: number;
  readonly daysOverdue: number;
  readonly overdue: boolean;
  readonly bucket: AgingBucket;
}

export interface SupplierPayablesItem {
  readonly supplierId: string;
  readonly balanceXaf: number;
  readonly overdueXaf: number;
  readonly advanceXaf: number;
  /** Dette nette des avances (BR-FIN-032). */
  readonly netXaf: number;
  readonly buckets: Readonly<Record<AgingBucket, number>>;
  readonly invoices: readonly PayableInvoiceItem[];
}

/** Dettes (`GET /payables`). */
export interface PayablesResponse {
  readonly as_of: string;
  readonly total_balance_xaf: number;
  readonly total_advance_xaf: number;
  readonly suppliers: readonly SupplierPayablesItem[];
}

/** Ligne de rapprochement d'un bon de commande (`GET /purchase-orders/{id}/matching`). */
export interface MatchingLineItem {
  readonly poLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  /** Unité d'achat du bon (sacs…) ; les quantités, elles, sont en unité de base du produit. */
  readonly unitCode: string;
  readonly status: string;
  readonly orderedQtyBase: number;
  readonly acceptedQtyBase: number;
  readonly invoicedQtyBase: number;
  readonly remainingQtyBase: number;
  /** Nul sans droit de valorisation (`inventory.valuation.read`). */
  readonly unitPriceXaf: number | null;
}

export interface OrderMatchingItem {
  readonly orderId: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly status: string;
  readonly lines: readonly MatchingLineItem[];
}

/** Groupes de statuts de la liste (SM-SUPPLIER-INVOICE), dans l'ordre du choix. */
export const INVOICE_GROUPS = {
  TO_DECIDE: ['MISMATCH', 'DISPUTED'],
  TO_PAY: ['APPROVED', 'PARTIALLY_PAID'],
  PAID: ['PAID'],
  CANCELLED: ['CANCELLED'],
} as const satisfies Record<string, readonly string[]>;
export type InvoiceGroup = keyof typeof INVOICE_GROUPS;
export const INVOICE_GROUP_ORDER: readonly InvoiceGroup[] = [
  'TO_DECIDE',
  'TO_PAY',
  'PAID',
  'CANCELLED',
];

export const INVOICE_PAGE_LIMIT = 200;
export const INVOICE_MAX_PAGES = 5;

/** Chemins de lecture d'un groupe, un par statut, pour un fournisseur s'il est choisi. */
export function invoiceListPaths(group: InvoiceGroup, supplierId: string): string[] {
  const supplier = supplierId ? `&supplier_id=${encodeURIComponent(supplierId)}` : '';
  return INVOICE_GROUPS[group].map(
    (status) => `/api/v1/supplier-invoices?status=${status}&limit=${INVOICE_PAGE_LIMIT}${supplier}`,
  );
}

/** Factures réunies de plusieurs statuts : échéance la plus proche d'abord, puis la plus récente. */
export function sortInvoices(items: readonly SupplierInvoiceItem[]): SupplierInvoiceItem[] {
  return [...items].sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      b.occurredAt.localeCompare(a.occurredAt) ||
      a.id.localeCompare(b.id),
  );
}

export interface InvoiceActions {
  readonly dispute: boolean;
  readonly approve: boolean;
  readonly cancel: boolean;
  /** Approbation refusée à son auteur (`SELF_APPROVAL_FORBIDDEN`, ADR-043 §5). */
  readonly ownInvoice: boolean;
}

/**
 * Actions proposées (SM-SUPPLIER-INVOICE, `finance.supplier_invoice.approve` : Direction, Finance) :
 * contester un écart ; approuver un écart ou une contestation, jamais sa propre facture ; annuler (avoir,
 * AV-272) une facture en écart, contestée, ou approuvée sans paiement. Le serveur revérifie.
 */
export function invoiceActions(
  item: Pick<SupplierInvoiceItem, 'status' | 'paidXaf' | 'createdBy'>,
  userId: string,
  mayDecide: boolean,
): InvoiceActions {
  const open = item.status === 'MISMATCH' || item.status === 'DISPUTED';
  const ownInvoice = item.createdBy === userId;
  return {
    dispute: mayDecide && item.status === 'MISMATCH',
    approve: mayDecide && open && !ownInvoice,
    cancel: mayDecide && (open || (item.status === 'APPROVED' && item.paidXaf === 0)),
    ownInvoice,
  };
}

export function invoiceDecisionPayload(reason: string) {
  return { reason: reason.trim() };
}

/** Ligne de facture en saisie. */
export interface InvoiceLineDraft {
  /** Clé stable de la ligne dans le formulaire. */
  readonly key: string;
  readonly poLineId: string | null;
  readonly productId: string | null;
  /**
   * Unité de base du produit, celle de la quantité saisie et du prix (revue de P8E-05 : jamais l'unité
   * d'achat du bon) ; nulle si le produit est inconnu de l'appareil.
   */
  readonly unitCode: string | null;
  readonly description: string;
  readonly quantityText: string;
  readonly unitPriceText: string;
  /** Montant lu sur la facture papier ; vide : quantité × prix (`lineAmountXaf`). */
  readonly totalText: string;
}

export interface InvoiceDraft {
  readonly supplierId: string;
  readonly purchaseOrderId: string;
  readonly supplierInvoiceRef: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly printedTotalText: string;
  readonly comment: string;
  readonly lines: readonly InvoiceLineDraft[];
}

export function emptyInvoiceDraft(today: string): InvoiceDraft {
  return {
    supplierId: '',
    purchaseOrderId: '',
    supplierInvoiceRef: '',
    invoiceDate: today,
    dueDate: '',
    printedTotalText: '',
    comment: '',
    lines: [],
  };
}

const formatDecimal = (value: number) => String(Math.round(value * 1000) / 1000);

/**
 * Lignes proposées depuis le rapprochement du bon : une par ligne de BC, quantité = accepté non encore
 * facturé (rien si tout est facturé), prix du bon, en unité de base du produit (`baseUnitOf`). Le
 * montant reste calculé jusqu'à une saisie.
 */
export function linesFromMatching(
  matching: OrderMatchingItem,
  describe: (line: MatchingLineItem) => string,
  baseUnitOf: (line: MatchingLineItem) => string | null = () => null,
): InvoiceLineDraft[] {
  return [...matching.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((line) => {
      const toInvoice = Math.max(0, line.acceptedQtyBase - line.invoicedQtyBase);
      return {
        key: `po:${line.poLineId}`,
        poLineId: line.poLineId,
        productId: line.productId,
        unitCode: baseUnitOf(line),
        description: describe(line),
        quantityText: toInvoice > 0 ? formatDecimal(toInvoice) : '',
        unitPriceText: line.unitPriceXaf === null ? '' : String(line.unitPriceXaf),
        totalText: '',
      };
    });
}

export function freeLine(key: string): InvoiceLineDraft {
  return {
    key,
    poLineId: null,
    productId: null,
    unitCode: null,
    description: '',
    quantityText: '',
    unitPriceText: '',
    totalText: '',
  };
}

export interface ParsedInvoiceLine {
  readonly draft: InvoiceLineDraft;
  readonly quantity: number | null;
  readonly unitPriceXaf: number | null;
  /** Montant calculé (quantité × prix), `null` sans les deux. */
  readonly computedXaf: number | null;
  /** Montant retenu : celui de la facture papier s'il est saisi, sinon le calculé. */
  readonly totalXaf: number | null;
  /** Ligne laissée vide (ni quantité, ni prix, ni montant) : non facturée. */
  readonly empty: boolean;
}

/** Quantité × prix, `null` sans les deux ou au-delà d'un montant représentable (`DomainError`). */
function computedAmount(quantity: number | null, unitPriceXaf: number | null): number | null {
  if (quantity === null || quantity <= 0 || unitPriceXaf === null) return null;
  try {
    return lineAmountXaf(quantityFromDecimal(quantity), xaf(unitPriceXaf)) as number;
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

export function parseInvoiceLine(draft: InvoiceLineDraft): ParsedInvoiceLine {
  const quantity = draft.quantityText.trim() === '' ? null : parseQuantity(draft.quantityText);
  const unitPriceXaf = draft.unitPriceText.trim() === '' ? null : parseXaf(draft.unitPriceText);
  const computedXaf = computedAmount(quantity, unitPriceXaf);
  const typed = draft.totalText.trim() === '' ? null : parseXaf(draft.totalText);
  const empty =
    draft.quantityText.trim() === '' &&
    draft.totalText.trim() === '' &&
    (draft.poLineId !== null || draft.unitPriceText.trim() === '');
  return {
    draft,
    quantity,
    unitPriceXaf,
    computedXaf,
    totalXaf: draft.totalText.trim() === '' ? computedXaf : typed,
    empty,
  };
}

export type InvoiceIssue =
  | 'SUPPLIER'
  | 'REF'
  | 'DUPLICATE'
  | 'DATE'
  | 'DUE_DATE'
  | 'NO_LINE'
  | 'LINE_DESCRIPTION'
  | 'LINE_QUANTITY'
  | 'LINE_PRICE'
  | 'LINE_TOTAL'
  | 'PRINTED_TOTAL'
  | 'TOO_MANY_LINES';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Date du calendrier (« 2026-13-40 » refusée). */
function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Doublon (BR-FIN-030, AV-272) : même référence normalisée parmi les factures non annulées du
 * fournisseur (« FA-0012 » = « fa 0012 ») ; le serveur reste juge (`INVOICE_DUPLICATE`).
 */
export function duplicateInvoice(
  ref: string,
  supplierId: string,
  invoices: readonly Pick<
    SupplierInvoiceItem,
    'supplierId' | 'supplierInvoiceRef' | 'status' | 'docNumber'
  >[],
): Pick<SupplierInvoiceItem, 'docNumber'> | undefined {
  const normalized = normalizedInvoiceRef(ref);
  if (!normalized) return undefined;
  return invoices.find(
    (invoice) =>
      invoice.supplierId === supplierId &&
      invoice.status !== 'CANCELLED' &&
      normalizedInvoiceRef(invoice.supplierInvoiceRef) === normalized,
  );
}

/** Lignes facturées (non vides) du brouillon. */
export function invoicedLines(draft: InvoiceDraft): ParsedInvoiceLine[] {
  return draft.lines.map(parseInvoiceLine).filter((line) => !line.empty);
}

/** Rang, dans le brouillon, de chaque ligne facturée (les lignes laissées vides sont sautées). */
export function invoicedLineIndexes(draft: InvoiceDraft): number[] {
  return draft.lines.flatMap((line, index) => (parseInvoiceLine(line).empty ? [] : [index]));
}

export function invoiceIssues(
  draft: InvoiceDraft,
  invoices: readonly Pick<
    SupplierInvoiceItem,
    'supplierId' | 'supplierInvoiceRef' | 'status' | 'docNumber'
  >[],
): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  if (!draft.supplierId) issues.push('SUPPLIER');
  if (draft.supplierInvoiceRef.trim() === '') issues.push('REF');
  else if (duplicateInvoice(draft.supplierInvoiceRef, draft.supplierId, invoices)) {
    issues.push('DUPLICATE');
  }
  if (!isCalendarDate(draft.invoiceDate)) issues.push('DATE');
  if (draft.dueDate && (!isCalendarDate(draft.dueDate) || draft.dueDate < draft.invoiceDate)) {
    issues.push('DUE_DATE');
  }
  const lines = invoicedLines(draft);
  if (lines.length === 0) issues.push('NO_LINE');
  if (lines.length > MAX_INVOICE_LINES) issues.push('TOO_MANY_LINES');
  for (const line of lines) {
    if (line.draft.description.trim() === '') issues.push('LINE_DESCRIPTION');
    // Ligne de BC : quantité et prix exigés (`INVOICE_LINE_INVALID`).
    if (line.draft.poLineId !== null || line.draft.quantityText.trim() !== '') {
      if (line.quantity === null || line.quantity <= 0) issues.push('LINE_QUANTITY');
    }
    if (line.draft.poLineId !== null || line.draft.unitPriceText.trim() !== '') {
      if (line.unitPriceXaf === null) issues.push('LINE_PRICE');
    }
    if (line.totalXaf === null) issues.push('LINE_TOTAL');
  }
  if (draft.printedTotalText.trim() !== '' && parseXaf(draft.printedTotalText) === null) {
    issues.push('PRINTED_TOTAL');
  }
  return [...new Set(issues)];
}

export interface InvoicePreview {
  readonly match: SupplierInvoiceMatch | null;
  /** Refus que le serveur opposerait (`PO_LINE_MISMATCH`, `INVOICE_LINE_INVALID`…). */
  readonly errorCode: string | null;
  readonly dueDate: string | null;
}

/**
 * Aperçu indicatif (BR-FIN-031) : rapprochement par la règle partagée, avec le BC lu en ligne et les
 * défauts du registre ; échéance (AV-273 : saisie, sinon date + délai du fournisseur, sinon la date).
 * Le rang d'un écart est celui de la ligne dans le brouillon, comme le formulaire les numérote (le
 * serveur ne reçoit que les lignes facturées).
 */
export function invoicePreview(input: {
  readonly draft: InvoiceDraft;
  readonly matching: OrderMatchingItem | null;
  readonly paymentTermsDays: number | null;
}): InvoicePreview {
  const { draft } = input;
  let dueDate: string | null = null;
  try {
    dueDate =
      isCalendarDate(draft.invoiceDate) && (!draft.dueDate || isCalendarDate(draft.dueDate))
        ? supplierInvoiceDueDate({
            invoiceDate: draft.invoiceDate,
            dueDate: draft.dueDate || null,
            paymentTermsDays: input.paymentTermsDays,
          })
        : null;
  } catch {
    dueDate = null;
  }
  const lines = invoicedLines(draft);
  if (
    lines.length === 0 ||
    lines.some((line) => line.totalXaf === null) ||
    !draft.supplierId ||
    (draft.purchaseOrderId !== '' && input.matching === null)
  ) {
    return { match: null, errorCode: null, dueDate };
  }
  const printed = draft.printedTotalText.trim() === '' ? null : parseXaf(draft.printedTotalText);
  try {
    const match = matchSupplierInvoice({
      supplierId: draft.supplierId,
      order: input.matching
        ? {
            supplierId: input.matching.supplierId,
            lines: input.matching.lines.map((line) => ({
              poLineId: line.poLineId,
              productId: line.productId,
              unitPriceXaf: line.unitPriceXaf ?? 0,
              accepted: quantityFromDecimal(line.acceptedQtyBase),
              invoiced: quantityFromDecimal(line.invoicedQtyBase),
            })),
          }
        : null,
      lines: lines.map((line): InvoiceLineInput => ({
        poLineId: line.draft.poLineId,
        productId: line.draft.productId,
        quantity:
          line.quantity !== null && line.quantity > 0 ? quantityFromDecimal(line.quantity) : null,
        unitPriceXaf: line.unitPriceXaf,
        lineTotalXaf: line.totalXaf as number,
      })),
      printedTotalXaf: printed,
      ...INVOICE_PREVIEW_SETTINGS,
    });
    const indexes = invoicedLineIndexes(draft);
    return {
      match: {
        ...match,
        details: match.details.map((detail) =>
          detail.lineIndex === null
            ? detail
            : { ...detail, lineIndex: indexes[detail.lineIndex] ?? detail.lineIndex },
        ),
      },
      errorCode: null,
      dueDate,
    };
  } catch (error) {
    return {
      match: null,
      errorCode: error instanceof DomainError ? error.code : 'INVOICE_LINE_INVALID',
      dueDate,
    };
  }
}

/** Charge utile de `finance.supplier_invoice.record` (`supplierInvoiceRecordPayloadSchema`). */
export function invoiceRecordPayload(draft: InvoiceDraft) {
  const comment = draft.comment.trim();
  const printed = draft.printedTotalText.trim() === '' ? null : parseXaf(draft.printedTotalText);
  return {
    supplierId: draft.supplierId,
    supplierInvoiceRef: draft.supplierInvoiceRef.trim(),
    invoiceDate: draft.invoiceDate,
    ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
    ...(draft.purchaseOrderId ? { purchaseOrderId: draft.purchaseOrderId } : {}),
    ...(printed !== null ? { printedTotalXaf: printed } : {}),
    lines: invoicedLines(draft).map((line) => ({
      ...(line.draft.poLineId ? { poLineId: line.draft.poLineId } : {}),
      ...(line.draft.productId ? { productId: line.draft.productId } : {}),
      description: line.draft.description.trim(),
      ...(line.quantity !== null && line.quantity > 0 ? { quantity: line.quantity } : {}),
      ...(line.unitPriceXaf !== null ? { unitPriceXaf: line.unitPriceXaf } : {}),
      lineTotalXaf: line.totalXaf as number,
    })),
    ...(comment ? { comment } : {}),
  };
}

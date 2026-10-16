/**
 * Paiements fournisseurs (ECR-FIN-04, P8E-06 ; ADR-043 §6-7, ADR-047 §4 ; BR-FIN-012, 032, 033 ;
 * AV-055, AV-275 à AV-277). Logique pure : groupes de statuts, actions (affecter une avance : Finance ;
 * annuler : l'auteur d'un paiement en attente, la Direction d'un paiement décaissé, AV-277), saisie :
 * moyen et compte compatibles (règle du serveur), référence exigée par le moyen, affectations aux
 * factures payables du fournisseur par la règle partagée (`planSupplierPayment`), avance (AV-275),
 * validation de la Direction au-delà du seuil (indicatif : le seuil n'est pas servi à l'appareil),
 * caisse physique jamais négative à l'envoi en ligne.
 */
import {
  DomainError,
  planSupplierPayment,
  supplierPaymentRequiresApproval,
  type PayableInvoice,
} from '@gic/domain';
import { SUPPLIER_PAYMENT_MAX_ALLOCATIONS } from '@gic/contracts';
import { parseXaf } from '../sales/sale-form.js';
import { settingValue } from '../sales/stock.js';
import type { PaymentMethodData, SettingData } from '../sales/types.js';
import type { CashAccountItem, SupplierPaymentItem } from '../treasury/treasury.js';
import type { PayableInvoiceItem, SupplierInvoiceAllocationItem } from './supplier-invoice.js';

/** Longueurs maximales (`supplierPaymentRecordPayloadSchema`). */
export const MAX_PAYMENT_REFERENCE = 80;
export const MAX_PAYMENT_COMMENT = 500;
export const MAX_PAYMENT_REASON = 500;
export const MAX_PAYMENT_ALLOCATIONS = SUPPLIER_PAYMENT_MAX_ALLOCATIONS;

/** Seuil de validation de la Direction (`finance.supplier_payment_approval_xaf`, défaut AV-055). */
export const DEFAULT_SUPPLIER_PAYMENT_THRESHOLD_XAF = 500_000;

/** Avance admise par défaut (`finance.supplier_advance_allowed`, AV-275). */
export const DEFAULT_ADVANCE_ALLOWED = true;

export interface PaymentSettings {
  readonly thresholdXaf: number;
  readonly advanceAllowed: boolean;
}

/**
 * Seuil de la Direction et avance admise (ADR-047 §4) : non servis à l'appareil aujourd'hui (paramètres
 * non visibles), lus dans `me` s'ils le deviennent ; sinon les défauts du registre. L'aperçu reste
 * indicatif, le serveur tranche avec ses paramètres.
 */
export function paymentSettings(settings: readonly SettingData[], now: Date): PaymentSettings {
  const threshold = settingValue(settings, 'finance.supplier_payment_approval_xaf', null, now);
  const advance = settingValue(settings, 'finance.supplier_advance_allowed', null, now);
  return {
    thresholdXaf:
      typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0
        ? threshold
        : DEFAULT_SUPPLIER_PAYMENT_THRESHOLD_XAF,
    advanceAllowed: typeof advance === 'boolean' ? advance : DEFAULT_ADVANCE_ALLOWED,
  };
}

/** Paiement détaillé (`GET /supplier-payments/{id}`). */
export interface SupplierPaymentDetail extends SupplierPaymentItem {
  readonly allocations: readonly SupplierInvoiceAllocationItem[];
}

/** Groupes de la liste, dans l'ordre du choix (SM-SUPPLIER-PAYMENT). */
export const PAYMENT_GROUPS = {
  PENDING: ['PENDING_APPROVAL'],
  RECORDED: ['RECORDED'],
  ADVANCES: ['RECORDED'],
  CLOSED: ['REJECTED', 'CANCELLED'],
} as const satisfies Record<string, readonly string[]>;
export type PaymentGroup = keyof typeof PAYMENT_GROUPS;
export const PAYMENT_GROUP_ORDER: readonly PaymentGroup[] = [
  'PENDING',
  'RECORDED',
  'ADVANCES',
  'CLOSED',
];
export const PAYMENT_PAGE_LIMIT = 200;
export const PAYMENT_MAX_PAGES = 5;

export function paymentListPaths(group: PaymentGroup, supplierId: string): string[] {
  const supplier = supplierId ? `&supplier_id=${encodeURIComponent(supplierId)}` : '';
  return PAYMENT_GROUPS[group].map(
    (status) => `/api/v1/supplier-payments?status=${status}&limit=${PAYMENT_PAGE_LIMIT}${supplier}`,
  );
}

/** Paiements d'un groupe : les avances à affecter seules ; du plus récent au plus ancien. */
export function paymentsOfGroup(
  group: PaymentGroup,
  items: readonly SupplierPaymentItem[],
): SupplierPaymentItem[] {
  return items
    .filter((item) => group !== 'ADVANCES' || item.unallocatedXaf > 0)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
}

export interface PaymentActions {
  readonly allocate: boolean;
  readonly cancel: boolean;
}

/**
 * Actions proposées (ADR-043 §7) : affecter une avance d'un paiement décaissé (Finance,
 * `finance.supplier_payment.record`) ; annuler un paiement en attente (son auteur) ou décaissé (la
 * Direction, `finance.supplier_payment.approve`, AV-277). Le serveur revérifie.
 */
export function paymentActions(
  item: Pick<SupplierPaymentItem, 'status' | 'unallocatedXaf' | 'createdBy'>,
  userId: string,
  rights: { readonly mayRecord: boolean; readonly mayApprove: boolean },
): PaymentActions {
  return {
    allocate: rights.mayRecord && item.status === 'RECORDED' && item.unallocatedXaf > 0,
    cancel:
      (item.status === 'PENDING_APPROVAL' && rights.mayRecord && item.createdBy === userId) ||
      (item.status === 'RECORDED' && rights.mayApprove),
  };
}

/** Moyens de paiement d'un fournisseur : actifs, rattachés à un type de compte. */
export function paymentMethodsFor(methods: readonly PaymentMethodData[]): PaymentMethodData[] {
  return methods
    .filter((method) => method.is_active && method.default_account_type)
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/**
 * Comptes d'où payer avec ce moyen (règle du serveur, `methodFitsAccount`) : espèces vers une caisse,
 * sinon le type de compte du moyen ; actifs ; jamais la caisse personnelle d'un autre (AV-239).
 */
export function accountsForMethod(
  method: Pick<PaymentMethodData, 'default_account_type'> | undefined,
  accounts: readonly CashAccountItem[],
  userId: string,
): CashAccountItem[] {
  if (!method) return [];
  const type = method.default_account_type;
  return accounts
    .filter(
      (account) =>
        account.status === 'ACTIVE' &&
        (account.holderUserId === null || account.holderUserId === userId) &&
        (type.startsWith('CAISSE_')
          ? account.accountType.startsWith('CAISSE_')
          : account.accountType === type),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export interface PaymentDraft {
  readonly supplierId: string;
  readonly amountText: string;
  readonly methodCode: string;
  readonly accountId: string;
  readonly reference: string;
  readonly comment: string;
  /** Montant affecté par facture (texte saisi), par identifiant de facture. */
  readonly allocations: Readonly<Record<string, string>>;
}

export const EMPTY_PAYMENT_DRAFT: PaymentDraft = {
  supplierId: '',
  amountText: '',
  methodCode: '',
  accountId: '',
  reference: '',
  comment: '',
  allocations: {},
};

/** Factures payables d'un fournisseur (dettes), l'échéance la plus proche d'abord. */
export function payableInvoices(invoices: readonly PayableInvoiceItem[]): PayableInvoiceItem[] {
  return invoices
    .filter((invoice) => invoice.balanceXaf > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.docNumber.localeCompare(b.docNumber));
}

/**
 * Affectations du brouillon limitées aux factures encore payables : une facture soldée ou annulée
 * entre-temps quitte les dettes relues, son affectation (sans champ pour la corriger) est écartée.
 */
export function allocationsOnInvoices(
  allocations: Readonly<Record<string, string>>,
  invoices: readonly Pick<PayableInvoiceItem, 'invoiceId'>[],
): Record<string, string> {
  const payable = new Set(invoices.map((invoice) => invoice.invoiceId));
  return Object.fromEntries(
    Object.entries(allocations).filter(([invoiceId]) => payable.has(invoiceId)),
  );
}

/** Montant prévu sur une facture par des paiements en attente de la Direction. */
export interface PlannedOnInvoice {
  readonly amountXaf: number;
  readonly docNumbers: readonly string[];
}

/**
 * Affectations prévues (`PLANNED`) des paiements en attente de la Direction, par facture : le serveur
 * ne les déduit pas du reste dû ; une facture réglée entre-temps ferait refuser l'approbation
 * (`ALLOCATION_EXCEEDS`). Revue de P8E-06.
 */
export function plannedByInvoice(
  pending: readonly Pick<SupplierPaymentDetail, 'docNumber' | 'status' | 'allocations'>[],
): Readonly<Record<string, PlannedOnInvoice>> {
  const result: Record<string, { amountXaf: number; docNumbers: string[] }> = {};
  for (const payment of pending) {
    if (payment.status !== 'PENDING_APPROVAL') continue;
    for (const allocation of payment.allocations) {
      if (allocation.status !== 'PLANNED') continue;
      const entry = (result[allocation.invoiceId] ??= { amountXaf: 0, docNumbers: [] });
      entry.amountXaf += allocation.amountXaf;
      if (!entry.docNumbers.includes(payment.docNumber)) entry.docNumbers.push(payment.docNumber);
    }
  }
  return result;
}

/** Factures au reste dû net des montants prévus (proposition « Répartir » seulement). */
export function netOfPlanned(
  invoices: readonly PayableInvoiceItem[],
  planned: Readonly<Record<string, PlannedOnInvoice>>,
): PayableInvoiceItem[] {
  return invoices.map((invoice) => ({
    ...invoice,
    balanceXaf: Math.max(0, invoice.balanceXaf - (planned[invoice.invoiceId]?.amountXaf ?? 0)),
  }));
}

/** Affectations lues : montants entiers positifs seulement (les autres sont des erreurs de saisie). */
export function parsedAllocations(
  allocations: Readonly<Record<string, string>>,
): { readonly invoiceId: string; readonly amountXaf: number | null }[] {
  return Object.entries(allocations)
    .filter(([, text]) => text.trim() !== '')
    .map(([invoiceId, text]) => ({ invoiceId, amountXaf: parseXaf(text) }));
}

/**
 * Affectation proposée « payer les factures » : le montant couvre les factures dans l'ordre de leur
 * échéance, chacune jusqu'à son solde ; le reste est une avance.
 */
export function autoAllocation(
  invoices: readonly PayableInvoiceItem[],
  amountXaf: number,
): Record<string, string> {
  const result: Record<string, string> = {};
  let left = amountXaf;
  for (const invoice of payableInvoices(invoices)) {
    if (left <= 0 || Object.keys(result).length >= MAX_PAYMENT_ALLOCATIONS) break;
    const part = Math.min(left, invoice.balanceXaf);
    result[invoice.invoiceId] = String(part);
    left -= part;
  }
  return result;
}

export type PaymentIssue =
  | 'SUPPLIER'
  | 'AMOUNT'
  | 'METHOD'
  | 'ACCOUNT'
  | 'REFERENCE'
  | 'ALLOCATION_AMOUNT'
  | 'TOO_MANY_ALLOCATIONS';

export interface PaymentPreview {
  readonly amountXaf: number | null;
  /** Reste non affecté (avance), ou `null` si le plan est refusé. */
  readonly unallocatedXaf: number | null;
  /**
   * Refus de la règle partagée (`ALLOCATION_EXCEEDS`, `SUPPLIER_PAYMENT_EXCEEDS`…) ;
   * `ADVANCE_NOT_ALLOWED` quand le reste serait une avance non admise.
   */
  readonly planError: string | null;
  /** Au-delà du seuil : en attente de la Direction, rien n'est décaissé avant (BR-FIN-033). */
  readonly needsApproval: boolean;
  /** Caisse physique qui deviendrait négative : refusé en ligne (`CASH_INSUFFICIENT`). */
  readonly cashInsufficient: boolean;
}

export function paymentPreview(input: {
  readonly draft: PaymentDraft;
  readonly invoices: readonly PayableInvoiceItem[];
  readonly account: CashAccountItem | undefined;
  readonly thresholdXaf?: number;
  readonly advanceAllowed?: boolean;
}): PaymentPreview {
  const amountXaf = parseXaf(input.draft.amountText);
  const needsApproval =
    amountXaf !== null &&
    supplierPaymentRequiresApproval(
      amountXaf,
      input.thresholdXaf ?? DEFAULT_SUPPLIER_PAYMENT_THRESHOLD_XAF,
    );
  const cashInsufficient =
    amountXaf !== null &&
    !needsApproval &&
    input.account !== undefined &&
    input.account.accountType.startsWith('CAISSE_') &&
    amountXaf > input.account.balanceXaf;
  const allocations = parsedAllocations(input.draft.allocations);
  if (amountXaf === null || amountXaf <= 0 || allocations.some((a) => a.amountXaf === null)) {
    return { amountXaf, unallocatedXaf: null, planError: null, needsApproval, cashInsufficient };
  }
  const invoices = new Map<string, PayableInvoice>(
    input.invoices.map((invoice) => [
      invoice.invoiceId,
      {
        supplierId: input.draft.supplierId,
        status: invoice.paidXaf > 0 ? 'PARTIALLY_PAID' : 'APPROVED',
        balanceXaf: invoice.balanceXaf,
      },
    ]),
  );
  try {
    const plan = planSupplierPayment({
      supplierId: input.draft.supplierId,
      availableXaf: amountXaf,
      allocations: allocations.map((allocation) => ({
        invoiceId: allocation.invoiceId,
        amountXaf: allocation.amountXaf as number,
      })),
      invoices,
      advanceAllowed: input.advanceAllowed ?? DEFAULT_ADVANCE_ALLOWED,
    });
    return {
      amountXaf,
      unallocatedXaf: plan.unallocatedXaf as number,
      planError: null,
      needsApproval,
      cashInsufficient,
    };
  } catch (error) {
    const allocated = allocations.reduce((sum, allocation) => sum + (allocation.amountXaf ?? 0), 0);
    const code = error instanceof DomainError ? error.code : 'ALLOCATION_INVALID';
    return {
      amountXaf,
      unallocatedXaf: null,
      // La règle partagée dit « dépasse » dans les deux cas : la saisie les distingue.
      planError:
        code === 'SUPPLIER_PAYMENT_EXCEEDS' && allocated <= amountXaf
          ? 'ADVANCE_NOT_ALLOWED'
          : code,
      needsApproval,
      cashInsufficient,
    };
  }
}

/**
 * Paiements du fournisseur encore en attente de la Direction (`PENDING_APPROVAL`) : leurs affectations
 * prévues ne sont pas déduites des soldes des factures ; une facture payée deux fois serait refusée à
 * l'approbation (`ALLOCATION_EXCEEDS`).
 */
export function pendingSummary(
  payments: readonly Pick<SupplierPaymentItem, 'status' | 'amountXaf'>[],
): { readonly count: number; readonly totalXaf: number } {
  const pending = payments.filter((payment) => payment.status === 'PENDING_APPROVAL');
  return {
    count: pending.length,
    totalXaf: pending.reduce((sum, payment) => sum + payment.amountXaf, 0),
  };
}

export function paymentIssues(input: {
  readonly draft: PaymentDraft;
  readonly method: Pick<PaymentMethodData, 'requires_reference'> | undefined;
  readonly account: CashAccountItem | undefined;
}): PaymentIssue[] {
  const { draft } = input;
  const issues: PaymentIssue[] = [];
  if (!draft.supplierId) issues.push('SUPPLIER');
  const amount = parseXaf(draft.amountText);
  if (amount === null || amount <= 0) issues.push('AMOUNT');
  if (!input.method) issues.push('METHOD');
  if (!input.account) issues.push('ACCOUNT');
  if (input.method?.requires_reference && draft.reference.trim() === '') issues.push('REFERENCE');
  const allocations = parsedAllocations(draft.allocations);
  if (
    allocations.some((allocation) => allocation.amountXaf === null || allocation.amountXaf <= 0)
  ) {
    issues.push('ALLOCATION_AMOUNT');
  }
  if (allocations.length > MAX_PAYMENT_ALLOCATIONS) issues.push('TOO_MANY_ALLOCATIONS');
  return issues;
}

/** Charge utile de `finance.supplier_payment.record` (`supplierPaymentRecordPayloadSchema`). */
export function paymentRecordPayload(draft: PaymentDraft) {
  const reference = draft.reference.trim();
  const comment = draft.comment.trim();
  return {
    supplierId: draft.supplierId,
    amountXaf: parseXaf(draft.amountText) as number,
    paymentMethodCode: draft.methodCode,
    fromAccountId: draft.accountId,
    ...(reference ? { externalReference: reference } : {}),
    allocations: parsedAllocations(draft.allocations).map((allocation) => ({
      invoiceId: allocation.invoiceId,
      amountXaf: allocation.amountXaf as number,
    })),
    ...(comment ? { comment } : {}),
  };
}

/** Charge utile de `finance.supplier_payment.allocate` (au moins une affectation). */
export function allocatePayload(allocations: Readonly<Record<string, string>>) {
  return {
    allocations: parsedAllocations(allocations).map((allocation) => ({
      invoiceId: allocation.invoiceId,
      amountXaf: allocation.amountXaf as number,
    })),
  };
}

/**
 * Affectation d'une avance (`finance.supplier_payment.allocate`) : au moins une affectation, montants
 * entiers positifs, règle partagée sur le reste non affecté du paiement (le reste demeure une avance).
 */
export function planPreviewForAllocation(input: {
  readonly supplierId: string;
  readonly availableXaf: number;
  readonly allocations: Readonly<Record<string, string>>;
  readonly invoices: readonly PayableInvoiceItem[];
}): { readonly valid: boolean; readonly error: string | null } {
  const allocations = parsedAllocations(input.allocations);
  if (allocations.length === 0) return { valid: false, error: null };
  if (
    allocations.some((allocation) => allocation.amountXaf === null || allocation.amountXaf <= 0)
  ) {
    return { valid: false, error: 'AMOUNT_INVALID' };
  }
  try {
    planSupplierPayment({
      supplierId: input.supplierId,
      availableXaf: input.availableXaf,
      allocations: allocations.map((allocation) => ({
        invoiceId: allocation.invoiceId,
        amountXaf: allocation.amountXaf as number,
      })),
      invoices: new Map<string, PayableInvoice>(
        input.invoices.map((invoice) => [
          invoice.invoiceId,
          {
            supplierId: input.supplierId,
            status: invoice.paidXaf > 0 ? 'PARTIALLY_PAID' : 'APPROVED',
            balanceXaf: invoice.balanceXaf,
          },
        ]),
      ),
      advanceAllowed: true,
    });
    return { valid: true, error: null };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof DomainError ? error.code : 'ALLOCATION_INVALID',
    };
  }
}

export function paymentCancelPayload(reason: string) {
  return { reason: reason.trim() };
}

/**
 * Affectations montrées d'un paiement : celles d'un paiement décaissé sans les lignes contrepassées
 * par le regroupement d'un complément (la ligne active porte le cumul) ; toutes sinon. Texte de la
 * liste vide selon le statut.
 */
export function shownAllocations(detail: Pick<SupplierPaymentDetail, 'status' | 'allocations'>): {
  readonly allocations: readonly SupplierInvoiceAllocationItem[];
  readonly emptyKey: string;
} {
  const allocations =
    detail.status === 'RECORDED'
      ? detail.allocations.filter((allocation) => allocation.status !== 'REVERSED')
      : detail.allocations;
  return {
    allocations,
    emptyKey:
      detail.status === 'RECORDED'
        ? 'no_allocation'
        : detail.status === 'PENDING_APPROVAL'
          ? 'no_allocation_pending'
          : 'no_allocation_closed',
  };
}

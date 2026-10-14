/**
 * Dépenses : règles pures partagées par l'appareil et le serveur (P8 ; ADR-021, ADR-042 ;
 * SM-EXPENSE ; D09 BR-FIN-020 à 022, D05 BR-DIS-013 ; AV-058, AV-264 à AV-270). Sans
 * entrée-sortie : l'appelant fournit la catégorie, le compte, l'objet de coût et les paramètres
 * déjà lus (`finance.expense_approval_threshold_xaf`, `finance.expense_photo_threshold_xaf`,
 * `finance.pos_expense_max_xaf`).
 *
 * - **Seuils** (AV-058) : comparaisons strictes, comme `orderRequiresApproval`.
 * - **Motifs de revue** (ADR-042 §6, AV-265) : une règle que seul le serveur peut juger (catégorie
 *   désactivée ou non autorisée au PDV, plafond du PDV, justificatif, objet de coût clos) refuse la
 *   commande en ligne ({@link EXPENSE_REVIEW_ERROR_CODES}) et place la dépense hors ligne en
 *   validation a posteriori ({@link expenseStatusAtRecord}).
 * - **Coût** (ADR-042 §8, AV-269, AV-270) : {@link expenseCostLine} dit le type de coût et l'espèce
 *   de l'écriture ; {@link expenseCarriesCost} dit si une dépense, dans un statut donné, porte son
 *   écriture (INV-FIN-08).
 */
import { DomainError } from './errors.js';

/** États d'une dépense (SM-EXPENSE). */
export const EXPENSE_STATUSES = [
  'RECORDED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'PAID',
  'PAID_PENDING_APPROVAL',
  'PAID_REJECTED',
  'CANCELLED',
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** Objets de coût d'une dépense (dictionnaire `finance.expenses`, CHECK du registre de coûts). */
export const EXPENSE_COST_OBJECT_TYPES = ['PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE'] as const;
export type ExpenseCostObjectType = (typeof EXPENSE_COST_OBJECT_TYPES)[number];

/** Espèces des frais généraux (ADR-026, AV-104). */
export const EXPENSE_SPECIES_GROUPS = ['VOLAILLE', 'PORC'] as const;
export type ExpenseSpeciesGroup = (typeof EXPENSE_SPECIES_GROUPS)[number];

/**
 * Types de coût qu'une catégorie peut porter vers un lot (AV-270) ; les autres types du registre
 * (`ANIMAUX`, `OEUFS`, `FRAIS_GENERAUX`, `PRODUCTION_TRANSFEREE`, `AJUSTEMENT`) ne viennent jamais
 * d'une dépense.
 */
export const EXPENSE_LOT_COST_TYPES = [
  'VETERINAIRE',
  'ALIMENT',
  'AUTRE_INTRANT',
  'DEPENSE_DIRECTE',
] as const;
export type ExpenseLotCostType = (typeof EXPENSE_LOT_COST_TYPES)[number];

/** Catégorie système d'une dépense rejetée après paiement (BR-FIN-022, AV-268). */
export const UNJUSTIFIED_EXPENSE_CATEGORY_CODE = 'NON_JUSTIFIEE';

/** Motifs de revue d'une dépense (ADR-042 §6). */
export const EXPENSE_REVIEW_REASONS = [
  'CATEGORY_INACTIVE',
  'CATEGORY_NOT_ALLOWED_ON_POS',
  'POS_CAP_EXCEEDED',
  'ATTACHMENT_MISSING',
  'COST_OBJECT_CLOSED',
] as const;
export type ExpenseReviewReason = (typeof EXPENSE_REVIEW_REASONS)[number];

/** Code de refus en ligne de chaque motif (D09 §8 : `ATTACHMENT_REQUIRED`). */
export const EXPENSE_REVIEW_ERROR_CODES: Readonly<Record<ExpenseReviewReason, string>> = {
  CATEGORY_INACTIVE: 'EXPENSE_CATEGORY_INACTIVE',
  CATEGORY_NOT_ALLOWED_ON_POS: 'EXPENSE_CATEGORY_NOT_ALLOWED_ON_POS',
  POS_CAP_EXCEEDED: 'POS_EXPENSE_CAP_EXCEEDED',
  ATTACHMENT_MISSING: 'ATTACHMENT_REQUIRED',
  COST_OBJECT_CLOSED: 'COST_OBJECT_CLOSED',
};

/** BR-FIN-021, AV-058 : validation au-delà du seuil (strictement supérieur). */
export function expenseRequiresApproval(amountXaf: number, thresholdXaf: number): boolean {
  return amountXaf > thresholdXaf;
}

/** BR-FIN-020, AV-058 : justificatif exigé au-delà du seuil (strictement supérieur). */
export function expensePhotoRequired(amountXaf: number, thresholdXaf: number): boolean {
  return amountXaf > thresholdXaf;
}

/** État de l'objet de coût tel que le lit l'appelant (`costObjectStatus` d'`inventory`). */
export type ExpenseCostObjectState = 'NONE' | 'OPEN' | 'CLOSED';

/**
 * Motifs de revue d'une dépense, dans l'ordre de {@link EXPENSE_REVIEW_REASONS} (ADR-042 §5 et §6).
 * Vide : la dépense est conforme. `paidFromPos` : payée depuis une caisse de PDV.
 */
export function expenseReviewReasons(input: {
  readonly category: {
    readonly isActive: boolean;
    readonly isSystem: boolean;
    readonly allowedOnPos: boolean;
  };
  readonly amountXaf: number;
  readonly paidFromPos: boolean;
  readonly posCapXaf: number;
  readonly photoThresholdXaf: number;
  readonly hasAttachment: boolean;
  readonly costObject: ExpenseCostObjectState;
}): readonly ExpenseReviewReason[] {
  const reasons: ExpenseReviewReason[] = [];
  if (!input.category.isActive || input.category.isSystem) reasons.push('CATEGORY_INACTIVE');
  if (input.paidFromPos && !input.category.allowedOnPos)
    reasons.push('CATEGORY_NOT_ALLOWED_ON_POS');
  if (input.paidFromPos && input.amountXaf > input.posCapXaf) reasons.push('POS_CAP_EXCEEDED');
  if (expensePhotoRequired(input.amountXaf, input.photoThresholdXaf) && !input.hasAttachment) {
    reasons.push('ATTACHMENT_MISSING');
  }
  if (input.costObject === 'CLOSED') reasons.push('COST_OBJECT_CLOSED');
  return reasons;
}

/**
 * Statut à l'enregistrement (SM-EXPENSE, BR-FIN-021, ADR-042 §2 et §6, AV-264) : une validation
 * est demandée si une politique est disponible et que le montant dépasse le seuil ou qu'un motif
 * de revue existe ; sans politique, aucune validation.
 */
export function expenseStatusAtRecord(input: {
  readonly paidNow: boolean;
  readonly overThreshold: boolean;
  readonly reviewReasonCount: number;
  readonly policyAvailable: boolean;
}): ExpenseStatus {
  const needsApproval =
    input.policyAvailable && (input.overThreshold || input.reviewReasonCount > 0);
  if (input.paidNow) return needsApproval ? 'PAID_PENDING_APPROVAL' : 'PAID';
  return needsApproval ? 'PENDING_APPROVAL' : 'RECORDED';
}

export type ExpenseAction = 'APPROVE' | 'REJECT' | 'PAY' | 'CANCEL';

/**
 * Transitions de SM-EXPENSE après l'enregistrement ; refus `EXPENSE_STATUS_INVALID` hors table.
 * Une dépense payée ne s'annule pas (son décaissement reste ; le rejet la reclasse).
 */
export function expenseTransition(status: ExpenseStatus, action: ExpenseAction): ExpenseStatus {
  const next = TRANSITIONS[action][status];
  if (next === undefined) {
    throw new DomainError(
      `Action ${action} impossible sur une dépense ${status}.`,
      'EXPENSE_STATUS_INVALID',
    );
  }
  return next;
}

const TRANSITIONS: Readonly<
  Record<ExpenseAction, Partial<Readonly<Record<ExpenseStatus, ExpenseStatus>>>>
> = {
  APPROVE: { PENDING_APPROVAL: 'APPROVED', PAID_PENDING_APPROVAL: 'PAID' },
  REJECT: { PENDING_APPROVAL: 'REJECTED', PAID_PENDING_APPROVAL: 'PAID_REJECTED' },
  PAY: { RECORDED: 'PAID', APPROVED: 'PAID' },
  CANCEL: { RECORDED: 'CANCELLED', PENDING_APPROVAL: 'CANCELLED', APPROVED: 'CANCELLED' },
};

/**
 * BR-FIN-022, INV-FIN-08 : une dépense imputée porte son écriture de coût quand elle est
 * enregistrée sans validation, approuvée, ou payée sans rejet ; jamais en attente, rejetée ou
 * annulée.
 */
export function expenseCarriesCost(status: ExpenseStatus): boolean {
  return status === 'RECORDED' || status === 'APPROVED' || status === 'PAID';
}

/**
 * Écriture de coût d'une dépense imputée (ADR-042 §8, AV-269, AV-270) :
 * - lot ou lot d'incubation : type de la catégorie s'il est admis, sinon `DEPENSE_DIRECTE` ;
 * - site avec espèce : `FRAIS_GENERAUX` de cette espèce (masse répartie, ADR-026) ;
 * - site sans espèce : `DEPENSE_DIRECTE` du site, hors répartition.
 * Une espèce hors d'un site est refusée (`COST_OBJECT_INVALID`).
 */
export function expenseCostLine(input: {
  readonly costObjectType: ExpenseCostObjectType;
  readonly speciesGroup: ExpenseSpeciesGroup | null;
  readonly categoryCostType: string | null;
}): {
  readonly costType: ExpenseLotCostType | 'FRAIS_GENERAUX';
  readonly speciesGroup: ExpenseSpeciesGroup | null;
} {
  if (input.costObjectType !== 'SITE') {
    if (input.speciesGroup !== null) {
      throw new DomainError(
        "L'espèce ne s'indique que pour une dépense imputée à un site (frais généraux).",
        'COST_OBJECT_INVALID',
      );
    }
    const admitted = (EXPENSE_LOT_COST_TYPES as readonly string[]).includes(
      input.categoryCostType ?? '',
    );
    return {
      costType: admitted ? (input.categoryCostType as ExpenseLotCostType) : 'DEPENSE_DIRECTE',
      speciesGroup: null,
    };
  }
  if (input.speciesGroup !== null) {
    return { costType: 'FRAIS_GENERAUX', speciesGroup: input.speciesGroup };
  }
  return { costType: 'DEPENSE_DIRECTE', speciesGroup: null };
}

/**
 * Plafond d'approbation d'une dépense (RC-06, AV-263) : `limits` des droits `finance.expense.approve`
 * de l'approbateur dans la portée de la dépense (`evaluateAccessLimits`), un élément par rôle. Le plus
 * permissif l'emporte : un droit sans limite, ou sans `maxAmountXaf` numérique, n'a pas de plafond.
 * Aucun droit : refus.
 */
export function expenseApprovalWithinLimits(
  amountXaf: number,
  limits: readonly (Readonly<Record<string, unknown>> | null)[],
): boolean {
  return limits.some((limit) => {
    if (limit === null) return true;
    const max = limit.maxAmountXaf;
    return typeof max !== 'number' || amountXaf <= max;
  });
}

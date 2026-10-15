/**
 * Dépenses sur l'appareil (ECR-FIN-02, UC-FIN-08 ; ADR-042, ADR-047 §2 ; AV-265 à AV-269, AV-301).
 * Logique pure : seuils lus dans `me`, catégories proposées, sites de l'utilisateur et imputations,
 * caisses qui paient, contrôles de la saisie, motifs de revue et statut annoncés par les règles
 * partagées avec le serveur (`@gic/domain`, ADR-021), charge utile de `finance.expense.record` ;
 * dépenses de l'utilisateur servies par le jeu `cash` et saisies de l'appareil pas encore relues.
 */
import {
  expensePhotoRequired,
  expenseRequiresApproval,
  expenseReviewReasons,
  expenseStatusAtRecord,
  type ExpenseCostObjectState,
  type ExpenseReviewReason,
  type ExpenseSpeciesGroup,
  type ExpenseStatus,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { ownAccounts } from '../cash/transfers.js';
import { isAccepted, isWaiting, stillInFlight } from '../sales/pending.js';
import { parseXaf } from '../sales/sale-form.js';
import { settingValue } from '../sales/stock.js';
import type {
  ApprovalRequestData,
  CashAccountData,
  ControlPolicyData,
  ExpenseCategoryData,
  ExpenseData,
  IncubationBatchData,
  ProductionLotData,
  RoleAssignmentData,
  SettingData,
  SiteData,
  ZoneData,
} from '../sales/types.js';

/** Longueurs maximales (`expenseRecordPayloadSchema`, `expenseCancelPayloadSchema`). */
export const MAX_EXPENSE_DESCRIPTION = 1000;
export const MAX_PAYEE_NAME = 120;
export const MAX_EXPENSE_CANCEL_REASON = 500;

/**
 * Seuils d'une dépense (AV-058) : paramètres visibles de l'appareil, globaux comme ceux que lit le
 * serveur (`expenseSettingsAt`) ; à défaut, les valeurs du registre des paramètres.
 */
export interface ExpenseThresholds {
  /** Validation au-delà (`finance.expense_approval_threshold_xaf`). */
  readonly approvalXaf: number;
  /** Justificatif exigé au-delà (`finance.expense_photo_threshold_xaf`). */
  readonly photoXaf: number;
  /** Plafond d'une dépense payée par la caisse du PDV (`finance.pos_expense_max_xaf`, AV-266). */
  readonly posCapXaf: number;
}

export const DEFAULT_EXPENSE_THRESHOLDS: ExpenseThresholds = {
  approvalXaf: 50_000,
  photoXaf: 10_000,
  posCapXaf: 50_000,
};

export function expenseThresholds(settings: readonly SettingData[], now: Date): ExpenseThresholds {
  const read = (key: string, fallback: number) => {
    const value = settingValue(settings, key, null, now);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    approvalXaf: read(
      'finance.expense_approval_threshold_xaf',
      DEFAULT_EXPENSE_THRESHOLDS.approvalXaf,
    ),
    photoXaf: read('finance.expense_photo_threshold_xaf', DEFAULT_EXPENSE_THRESHOLDS.photoXaf),
    posCapXaf: read('finance.pos_expense_max_xaf', DEFAULT_EXPENSE_THRESHOLDS.posCapXaf),
  };
}

/**
 * Une validation peut-elle être ouverte (AV-264) ? Comme le serveur (`expensePolicy`) : une politique
 * `EXPENSE` en vigueur qui demande une validation et nomme un approbateur. Aucune politique servie
 * (jeu `policies` jamais tiré) : la politique semée, toujours active (ADR-042 §6), est supposée.
 */
export function expensePolicyAvailable(policies: readonly ControlPolicyData[], now: Date): boolean {
  if (policies.length === 0) return true;
  return policies.some(
    (policy) =>
      policy.operation_type === 'EXPENSE' &&
      policy.requires_approval &&
      policy.approver_permission !== null &&
      new Date(policy.valid_from) <= now &&
      (policy.valid_to === null || new Date(policy.valid_to) > now),
  );
}

/**
 * Catégories proposées (ADR-042 §9, AV-270) : actives, hors catégorie système (`NON_JUSTIFIEE`) ;
 * payée par la caisse d'un PDV, celles permises au PDV seulement (BR-DIS-013).
 */
export function expenseCategoryChoices(
  categories: readonly ExpenseCategoryData[],
  paidFromPos: boolean,
): ExpenseCategoryData[] {
  return categories.filter(
    (category) =>
      category.is_active && !category.is_system && (!paidFromPos || category.allowed_on_pos),
  );
}

const inForce = (
  assignment: Pick<RoleAssignmentData, 'valid_from' | 'valid_to' | 'revoked_at'>,
  now: Date,
) =>
  assignment.revoked_at === null &&
  new Date(assignment.valid_from) <= now &&
  (assignment.valid_to === null || new Date(assignment.valid_to) > now);

/** La zone `zoneId` est-elle `ancestorId` ou l'une de ses sous-zones ? */
function withinZone(
  zoneId: string,
  ancestorId: string,
  zones: ReadonlyMap<string, Pick<ZoneData, 'parent_id'>>,
): boolean {
  let current: string | null | undefined = zoneId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = zones.get(current)?.parent_id;
  }
  return false;
}

/**
 * Sites où l'utilisateur saisit une dépense (AV-301, comme l'intersection de portée du serveur) :
 * ceux de ses affectations en vigueur servies à l'appareil — le site d'une affectation `SITE`, les
 * sites de la zone d'une affectation `ZONE` et de ses sous-zones ; tous les sites actifs pour une
 * affectation `GLOBAL` ou `TEAM`, ou si l'appareil ne connaît aucune de ses affectations. Le serveur
 * reste juge (`FORBIDDEN_SCOPE`).
 */
export function expenseSites(input: {
  readonly assignments: readonly RoleAssignmentData[];
  readonly userId: string;
  readonly sites: ReadonlyMap<string, SiteData>;
  readonly zones: ReadonlyMap<string, Pick<ZoneData, 'parent_id'>>;
  readonly now: Date;
}): SiteData[] {
  const active = [...input.sites.values()]
    .filter((site) => site.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const mine = input.assignments.filter(
    (assignment) => assignment.user_id === input.userId && inForce(assignment, input.now),
  );
  if (
    mine.length === 0 ||
    mine.some(
      (assignment) => assignment.scope_type === 'GLOBAL' || assignment.scope_type === 'TEAM',
    )
  ) {
    return active;
  }
  return active.filter((site) =>
    mine.some((assignment) =>
      assignment.scope_type === 'SITE'
        ? assignment.scope_site_id === site.id
        : assignment.scope_type === 'ZONE' && assignment.scope_zone_id !== null
          ? withinZone(site.zone_id, assignment.scope_zone_id, input.zones)
          : false,
    ),
  );
}

/**
 * Site proposé (AV-301) : celui de la caisse qui paie s'il est l'un des sites de l'utilisateur, sinon
 * son seul site ; plusieurs sites : choix explicite (chaîne vide).
 */
export function defaultExpenseSite(
  candidates: readonly Pick<SiteData, 'id'>[],
  account: Pick<CashAccountData, 'site_id'> | undefined,
): string {
  if (account?.site_id && candidates.some((site) => site.id === account.site_id)) {
    return account.site_id;
  }
  return candidates.length === 1 ? candidates[0]!.id : '';
}

/** Caisses qui paient (comme une remise, AV-239) : actives, sans détenteur ou à l'utilisateur. */
export function expenseAccounts(
  accounts: readonly CashAccountData[],
  userId: string,
): CashAccountData[] {
  return ownAccounts(accounts, userId);
}

/**
 * Imputation d'une dépense (ADR-042 §8, AV-269) : dépense directe du site, frais généraux d'une
 * espèce (ferme), lot de production ou lot d'incubation ouvert du site, ou aucune.
 */
export type ExpenseImputation =
  | { readonly key: 'SITE'; readonly kind: 'SITE' }
  | { readonly key: string; readonly kind: 'OVERHEAD'; readonly speciesGroup: ExpenseSpeciesGroup }
  | {
      readonly key: string;
      readonly kind: 'PRODUCTION_LOT' | 'INCUBATION_BATCH';
      readonly id: string;
      readonly code: string;
    }
  | { readonly key: 'NONE'; readonly kind: 'NONE' };

/** Imputation proposée par défaut (AV-301) : dépense directe du site de la dépense. */
export const EXPENSE_DEFAULT_IMPUTATION: 'SITE' | 'NONE' = 'SITE';

const CLOSED_STATUSES = new Set(['CLOSED', 'CANCELLED']);

/** Imputations possibles sur le site choisi, la proposée par défaut d'abord. */
export function expenseImputations(input: {
  readonly site: Pick<SiteData, 'id' | 'site_type'> | undefined;
  readonly lots: readonly Pick<ProductionLotData, 'id' | 'lot_code' | 'site_id' | 'status'>[];
  readonly batches: readonly Pick<
    IncubationBatchData,
    'id' | 'batch_code' | 'site_id' | 'status'
  >[];
}): ExpenseImputation[] {
  const { site } = input;
  if (!site) return [];
  const direct: ExpenseImputation = { key: 'SITE', kind: 'SITE' };
  const none: ExpenseImputation = { key: 'NONE', kind: 'NONE' };
  const options: ExpenseImputation[] =
    EXPENSE_DEFAULT_IMPUTATION === 'SITE' ? [direct, none] : [none, direct];
  // Frais généraux d'une espèce : sur une ferme seulement (`SITE_NOT_FARM`).
  if (site.site_type === 'FERME') {
    options.push(
      { key: 'OVERHEAD:VOLAILLE', kind: 'OVERHEAD', speciesGroup: 'VOLAILLE' },
      { key: 'OVERHEAD:PORC', kind: 'OVERHEAD', speciesGroup: 'PORC' },
    );
  }
  for (const lot of [...input.lots]
    .filter((lot) => lot.site_id === site.id && !CLOSED_STATUSES.has(lot.status))
    .sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'fr'))) {
    options.push({
      key: `PRODUCTION_LOT:${lot.id}`,
      kind: 'PRODUCTION_LOT',
      id: lot.id,
      code: lot.lot_code,
    });
  }
  for (const batch of [...input.batches]
    .filter((batch) => batch.site_id === site.id && !CLOSED_STATUSES.has(batch.status))
    .sort((a, b) => a.batch_code.localeCompare(b.batch_code, 'fr'))) {
    options.push({
      key: `INCUBATION_BATCH:${batch.id}`,
      kind: 'INCUBATION_BATCH',
      id: batch.id,
      code: batch.batch_code,
    });
  }
  return options;
}

/** Objet de coût de la charge utile (`costObject`), absent pour une dépense non imputée. */
export function imputationCostObject(
  imputation: ExpenseImputation,
  siteId: string,
):
  | {
      readonly type: 'SITE' | 'PRODUCTION_LOT' | 'INCUBATION_BATCH';
      readonly id: string;
      readonly speciesGroup?: ExpenseSpeciesGroup;
    }
  | undefined {
  switch (imputation.kind) {
    case 'NONE':
      return undefined;
    case 'SITE':
      return { type: 'SITE', id: siteId };
    case 'OVERHEAD':
      return { type: 'SITE', id: siteId, speciesGroup: imputation.speciesGroup };
    default:
      return { type: imputation.kind, id: imputation.id };
  }
}

/** État de l'objet de coût pour les motifs de revue : les lots proposés sont ouverts. */
export function imputationState(imputation: ExpenseImputation): ExpenseCostObjectState {
  return imputation.kind === 'NONE' ? 'NONE' : 'OPEN';
}

export interface ExpenseDraft {
  readonly categoryId: string;
  readonly amountText: string;
  readonly description: string;
  readonly payeeName: string;
  readonly supplierId: string;
  /** Site choisi ; vide : le site proposé (`defaultExpenseSite`). */
  readonly siteId: string;
  /** Clé de l'imputation choisie ; vide : l'imputation proposée. */
  readonly imputationKey: string;
  readonly paidNow: boolean;
  /** Caisse choisie ; vide : la seule caisse proposée. */
  readonly accountId: string;
}

export const EMPTY_EXPENSE_DRAFT: ExpenseDraft = {
  categoryId: '',
  amountText: '',
  description: '',
  payeeName: '',
  supplierId: '',
  siteId: '',
  imputationKey: '',
  paidNow: true,
  accountId: '',
};

export type ExpenseIssue = 'CATEGORY' | 'AMOUNT' | 'DESCRIPTION' | 'SITE' | 'ACCOUNT';

/** Champs à compléter avant l'envoi (dans l'ordre du formulaire). */
export function expenseIssues(input: {
  readonly category: ExpenseCategoryData | undefined;
  readonly amountXaf: number | null;
  readonly description: string;
  readonly siteId: string;
  readonly paidNow: boolean;
  readonly account: CashAccountData | undefined;
}): ExpenseIssue[] {
  const issues: ExpenseIssue[] = [];
  if (!input.category) issues.push('CATEGORY');
  if (input.amountXaf === null || input.amountXaf <= 0) issues.push('AMOUNT');
  if (input.description.trim() === '') issues.push('DESCRIPTION');
  if (input.siteId === '') issues.push('SITE');
  if (input.paidNow && !input.account) issues.push('ACCOUNT');
  return issues;
}

/** Montant saisi (XAF entiers), `null` s'il est illisible. */
export function expenseAmount(text: string): number | null {
  return parseXaf(text);
}

export interface ExpensePreview {
  /** Motifs de revue (ADR-042 §6) : refus en ligne, validation a posteriori hors ligne. */
  readonly reasons: readonly ExpenseReviewReason[];
  /** Statut que le serveur donnera, motifs compris. */
  readonly status: ExpenseStatus;
  readonly photoRequired: boolean;
}

/** Ce que le serveur fera de la dépense, par les règles partagées (ADR-021). */
export function expensePreview(input: {
  readonly category: Pick<ExpenseCategoryData, 'is_active' | 'is_system' | 'allowed_on_pos'>;
  readonly amountXaf: number;
  readonly paidNow: boolean;
  readonly paidFromPos: boolean;
  readonly thresholds: ExpenseThresholds;
  readonly hasPhoto: boolean;
  readonly costObject: ExpenseCostObjectState;
  readonly policyAvailable: boolean;
}): ExpensePreview {
  const reasons = expenseReviewReasons({
    category: {
      isActive: input.category.is_active,
      isSystem: input.category.is_system,
      allowedOnPos: input.category.allowed_on_pos,
    },
    amountXaf: input.amountXaf,
    paidFromPos: input.paidFromPos,
    posCapXaf: input.thresholds.posCapXaf,
    photoThresholdXaf: input.thresholds.photoXaf,
    hasAttachment: input.hasPhoto,
    costObject: input.costObject,
  });
  return {
    reasons,
    status: expenseStatusAtRecord({
      paidNow: input.paidNow,
      overThreshold: expenseRequiresApproval(input.amountXaf, input.thresholds.approvalXaf),
      reviewReasonCount: reasons.length,
      policyAvailable: input.policyAvailable,
    }),
    photoRequired: expensePhotoRequired(input.amountXaf, input.thresholds.photoXaf),
  };
}

/** Charge utile de `finance.expense.record` (`expenseRecordPayloadSchema`). */
export function expensePayload(input: {
  readonly categoryId: string;
  readonly amountXaf: number;
  readonly description: string;
  readonly payeeName: string;
  readonly supplierId: string;
  readonly siteId: string;
  readonly imputation: ExpenseImputation;
  readonly paidNow: boolean;
  readonly accountId: string;
}) {
  const payeeName = input.payeeName.trim();
  const costObject = imputationCostObject(input.imputation, input.siteId);
  return {
    categoryId: input.categoryId,
    amountXaf: input.amountXaf,
    description: input.description.trim(),
    ...(payeeName ? { payeeName } : {}),
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    siteId: input.siteId,
    ...(costObject ? { costObject } : {}),
    paidNow: input.paidNow,
    ...(input.paidNow ? { paidFromAccountId: input.accountId } : {}),
  };
}

export function expenseCancelPayload(reason: string) {
  return { reason: reason.trim() };
}

/** Opération de l'appareil sur une dépense : en attente d'envoi, ou acceptée pas encore relue. */
export type ExpenseStep = 'WAITING' | 'SENT' | null;

export interface ExpenseView {
  readonly id: string;
  /** Numéro `DEP-…` : servi, ou renvoyé à l'acceptation ; `null` pour une saisie en attente. */
  readonly docNumber: string | null;
  readonly siteId: string;
  readonly categoryId: string;
  readonly amountXaf: number;
  readonly description: string;
  readonly payeeName: string | null;
  readonly costObjectType: string | null;
  readonly costObjectId: string | null;
  readonly speciesGroup: string | null;
  readonly paidNow: boolean;
  readonly paidFromAccountId: string | null;
  readonly occurredAt: string;
  /** Statut servi, ou renvoyé à l'acceptation ; `null` pour une saisie en attente d'envoi. */
  readonly status: string | null;
  /** Statut servi par le jeu `cash` (les actions en ligne en dépendent) ; `null` sinon. */
  readonly servedStatus: string | null;
  readonly reviewReasons: readonly string[];
  readonly cancelReason: string | null;
  /** Commentaire du valideur d'un refus (demande `EXPENSE`, jeu `comms`). */
  readonly rejectionComment: string | null;
  /** Saisie de l'appareil pas encore relue : en attente d'envoi. */
  readonly recordWaiting: boolean;
  readonly cancelling: ExpenseStep;
}

interface RecordPayloadLike {
  readonly categoryId?: string;
  readonly amountXaf?: number;
  readonly description?: string;
  readonly payeeName?: string;
  readonly siteId?: string;
  readonly costObject?: {
    readonly type?: string;
    readonly id?: string;
    readonly speciesGroup?: string;
  };
  readonly paidNow?: boolean;
  readonly paidFromAccountId?: string;
}

const stepOf = (command: OutboxCommand | undefined): ExpenseStep =>
  command ? (isWaiting(command) ? 'WAITING' : 'SENT') : null;

/**
 * Dépenses de l'utilisateur, de la plus récente à la plus ancienne : celles du jeu `cash`, puis ses
 * saisies pas encore relues (refusées exclues : l'écran de synchronisation les montre), avec ses
 * annulations en cours.
 */
export function myExpenses(input: {
  readonly expenses: readonly ExpenseData[];
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly approvalRequests: readonly ApprovalRequestData[];
  readonly userId: string;
  /**
   * Détenteur des données tirées sur l'appareil (`data_user_id`) : sur une tablette partagée, les fiches
   * servies (ligne `USER`) sont les siennes jusqu'au tirage d'un autre utilisateur (ADR-037 §5) ; elles
   * ne sont montrées qu'à lui (revue de P8E-03).
   */
  readonly servedOwner?: string | undefined;
}): ExpenseView[] {
  const servedMine = input.servedOwner === undefined || input.servedOwner === input.userId;
  const servedExpenses = servedMine ? input.expenses : [];
  const servedRequests = servedMine ? input.approvalRequests : [];
  const inFlight = (type: string, id: string) =>
    input.outbox.find(
      (command) =>
        command.command_type === type &&
        command.aggregate_id === id &&
        stillInFlight(command, input.cashPulledAt),
    );
  const rejectionOf = (expenseId: string) =>
    servedRequests.find(
      (request) =>
        request.subject_type === 'EXPENSE' &&
        request.subject_id === expenseId &&
        request.status === 'REJECTED',
    )?.decision_comment ?? null;
  const served = new Set(servedExpenses.map((expense) => expense.id));
  const views: ExpenseView[] = servedExpenses.map((expense) => ({
    id: expense.id,
    docNumber: expense.doc_number,
    siteId: expense.site_id,
    categoryId: expense.category_id,
    amountXaf: expense.amount_xaf,
    description: expense.description,
    payeeName: expense.payee_name,
    costObjectType: expense.cost_object_type,
    costObjectId: expense.cost_object_id,
    speciesGroup: expense.species_group,
    paidNow: expense.paid_now,
    paidFromAccountId: expense.paid_from_account_id,
    occurredAt: expense.occurred_at,
    status: expense.status,
    servedStatus: expense.status,
    reviewReasons: expense.review_reasons,
    cancelReason: expense.cancel_reason ?? null,
    rejectionComment: rejectionOf(expense.id),
    recordWaiting: false,
    cancelling: stepOf(inFlight('finance.expense.cancel', expense.id)),
  }));
  for (const command of input.outbox) {
    if (command.command_type !== 'finance.expense.record') continue;
    if (command.author_user_id !== input.userId || served.has(command.aggregate_id)) continue;
    if (!stillInFlight(command, input.cashPulledAt)) continue;
    const payload = command.payload as RecordPayloadLike;
    if (!payload.categoryId || !payload.siteId || !payload.amountXaf) continue;
    const accepted = isAccepted(command);
    views.push({
      id: command.aggregate_id,
      docNumber: accepted ? (command.server_refs?.docNumber ?? null) : null,
      siteId: payload.siteId,
      categoryId: payload.categoryId,
      amountXaf: payload.amountXaf,
      description: payload.description ?? '',
      payeeName: payload.payeeName ?? null,
      costObjectType: payload.costObject?.type ?? null,
      costObjectId: payload.costObject?.id ?? null,
      speciesGroup: payload.costObject?.speciesGroup ?? null,
      paidNow: payload.paidNow === true,
      paidFromAccountId: payload.paidFromAccountId ?? null,
      occurredAt: command.occurred_at,
      status: accepted ? (command.server_refs?.status ?? null) : null,
      servedStatus: null,
      reviewReasons: [],
      cancelReason: null,
      rejectionComment: null,
      recordWaiting: isWaiting(command),
      cancelling: null,
    });
  }
  return views.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
}

/** Statuts d'une dépense que son auteur peut encore annuler, en ligne (SM-EXPENSE). */
const CANCELLABLE = new Set(['RECORDED', 'PENDING_APPROVAL', 'APPROVED']);

export function isExpenseCancellable(status: string | null): boolean {
  return status !== null && CANCELLABLE.has(status);
}

/** Dépense servie que son auteur peut annuler : non payée, sans annulation en cours. */
export function canCancelOwnExpense(view: ExpenseView): boolean {
  return isExpenseCancellable(view.servedStatus) && view.cancelling === null;
}

/**
 * Ligne de paiement (revue de P8E-03) : payée par un compte ; à payer (enregistrée, approuvée, ou saisie
 * à payer pas encore relue) ; à payer après validation ; rien pour une dépense refusée ou annulée. Une
 * dépense payée après coup par la Finance garde `paid_now` faux : seul le compte fait foi.
 */
export type ExpensePaymentState = 'PAID_FROM' | 'TO_PAY' | 'TO_PAY_AFTER_APPROVAL' | null;

export function expensePaymentState(input: {
  readonly status: string | null;
  readonly paidFromAccountId: string | null;
}): ExpensePaymentState {
  if (input.paidFromAccountId) return 'PAID_FROM';
  if (input.status === null || input.status === 'RECORDED' || input.status === 'APPROVED') {
    return 'TO_PAY';
  }
  return input.status === 'PENDING_APPROVAL' ? 'TO_PAY_AFTER_APPROVAL' : null;
}

/** Motifs de revue « à revoir » tant que la décision est attendue ; relevés à la saisie ensuite. */
export function reviewStillPending(status: string | null): boolean {
  return status === 'PENDING_APPROVAL' || status === 'PAID_PENDING_APPROVAL';
}

/** Statuts où le justificatif ne sert plus : dépense refusée ou annulée. */
const RECEIPT_CLOSED = new Set(['CANCELLED', 'REJECTED', 'PAID_REJECTED']);

/**
 * Justificatif à joindre (ou à remplacer) par l'auteur : dépense servie, ni refusée ni annulée, placée
 * en validation faute de justificatif, ou dont la photo a été refusée par le serveur (revue de P8E-03,
 * comme la réception, AV-285).
 */
export function receiptToAttach(view: ExpenseView, photoRefused: boolean): boolean {
  if (view.servedStatus === null || RECEIPT_CLOSED.has(view.servedStatus)) return false;
  return awaitsReceiptPhoto(view) || photoRefused;
}

/** Dépense placée en validation faute de justificatif : l'auteur peut joindre la photo du reçu. */
export function awaitsReceiptPhoto(view: ExpenseView): boolean {
  return (
    (view.servedStatus === 'PENDING_APPROVAL' || view.servedStatus === 'PAID_PENDING_APPROVAL') &&
    view.reviewReasons.includes('ATTACHMENT_MISSING')
  );
}

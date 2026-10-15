/**
 * Suivi des dépenses (ECR-FIN-02, vue en ligne ; ADR-047 §2, AV-298). Logique pure : dépenses lues par
 * `GET /expenses`, par groupe de statuts ; comptes d'où la Finance paie une dépense à payer
 * (`finance.expense.pay`) ; qui peut annuler (`finance.expense.cancel` : l'auteur, ou un approbateur).
 * La décision d'une dépense en validation se prend dans la file des validations (ECR-ADM-08).
 */
import { businessDayOf } from '@gic/domain';
import { shiftDay } from '../stock/ledger.js';
import type { CashAccountItem } from '../treasury/treasury.js';
import { isExpenseCancellable } from './expense.js';

/** Pièce d'une dépense, servie avec elle (P8E-03) ; lue par `GET /attachments/{id}/content`. */
export interface ExpenseAttachmentItem {
  readonly id: string;
  readonly kind: string;
  readonly uploadStatus: string;
}

/** Dépense lue en ligne (`ExpenseSummary` de `GET /expenses`). */
export interface ExpenseItem {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryLabel: string;
  readonly amountXaf: number;
  readonly payeeName: string | null;
  readonly supplierId: string | null;
  readonly description: string;
  readonly costObjectType: string | null;
  readonly costObjectId: string | null;
  readonly speciesGroup: string | null;
  readonly paidNow: boolean;
  readonly paidFromAccountId: string | null;
  readonly paidAt: string | null;
  readonly status: string;
  readonly reviewReasons: readonly string[];
  readonly approvalRequestId: string | null;
  readonly reclassifiedCategoryId: string | null;
  readonly responsibilityUserId: string | null;
  readonly cancelReason: string | null;
  readonly occurredAt: string;
  readonly businessDate: string;
  readonly capturedOffline: boolean;
  readonly createdBy: string;
  /** Absent d'un serveur antérieur à P8E-03. */
  readonly attachments?: readonly ExpenseAttachmentItem[];
}

/** Groupes de statuts du suivi, dans l'ordre des onglets (SM-EXPENSE). */
export const EXPENSE_FOLLOW_GROUPS = {
  TO_PAY: ['RECORDED', 'APPROVED'],
  TO_DECIDE: ['PENDING_APPROVAL', 'PAID_PENDING_APPROVAL'],
  PAID: ['PAID'],
  REJECTED: ['REJECTED', 'PAID_REJECTED'],
  CANCELLED: ['CANCELLED'],
} as const satisfies Record<string, readonly string[]>;

export type ExpenseFollowGroup = keyof typeof EXPENSE_FOLLOW_GROUPS;

export const EXPENSE_FOLLOW_GROUP_ORDER: readonly ExpenseFollowGroup[] = [
  'TO_PAY',
  'TO_DECIDE',
  'PAID',
  'REJECTED',
  'CANCELLED',
];

/** Groupes ouverts lus sans période ; les autres sur les derniers jours seulement. */
const OPEN_GROUPS = new Set<ExpenseFollowGroup>(['TO_PAY', 'TO_DECIDE']);

/** Fenêtre des groupes clos (jours métier, aujourd'hui compris), comme le jeu hors ligne. */
export const EXPENSE_FOLLOW_CLOSED_DAYS = 30;

/** Taille d'une page (`OPERATIONS_LIST_MAX_LIMIT`) et pages lues au plus par statut. */
export const EXPENSE_FOLLOW_PAGE_LIMIT = 200;
export const EXPENSE_FOLLOW_MAX_PAGES = 5;

export function isExpenseFollowGroup(value: string | null): value is ExpenseFollowGroup {
  return value !== null && Object.prototype.hasOwnProperty.call(EXPENSE_FOLLOW_GROUPS, value);
}

/** Chemins de lecture d'un groupe : un par statut ; période des groupes clos. */
export function expenseFollowPaths(group: ExpenseFollowGroup, now: Date): string[] {
  const today = businessDayOf(now);
  const period = OPEN_GROUPS.has(group)
    ? ''
    : `&from=${shiftDay(today, -(EXPENSE_FOLLOW_CLOSED_DAYS - 1))}&to=${today}`;
  return EXPENSE_FOLLOW_GROUPS[group].map(
    (status) => `/api/v1/expenses?status=${status}&limit=${EXPENSE_FOLLOW_PAGE_LIMIT}${period}`,
  );
}

/** Dépenses réunies des statuts d'un groupe, de la plus récente à la plus ancienne. */
export function sortExpenses(items: readonly ExpenseItem[]): ExpenseItem[] {
  return [...items].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
  );
}

/**
 * Comptes d'où payer une dépense (`finance.expense.pay`) : actifs, jamais la caisse personnelle d'un
 * autre (`CASH_ACCOUNT_FORBIDDEN`, AV-239). Une caisse de PDV exige une catégorie permise, le plafond
 * et une session ouverte : le serveur en juge.
 */
export function expensePayAccounts(
  accounts: readonly CashAccountItem[],
  userId: string,
): CashAccountItem[] {
  return accounts
    .filter(
      (account) =>
        account.status === 'ACTIVE' &&
        (account.holderUserId === null || account.holderUserId === userId),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Dépense à payer : enregistrée sans validation, ou approuvée (SM-EXPENSE). */
export function isExpensePayable(item: Pick<ExpenseItem, 'status'>): boolean {
  return item.status === 'RECORDED' || item.status === 'APPROVED';
}

/**
 * Annulation proposée (SM-EXPENSE) : dépense non payée, par son auteur ou par un approbateur
 * (`finance.expense.approve` : Direction, Finance, Resp. production) ; le serveur revérifie la portée.
 */
export function mayCancelExpense(
  item: Pick<ExpenseItem, 'status' | 'createdBy'>,
  userId: string,
  isApprover: boolean,
): boolean {
  return isExpenseCancellable(item.status) && (item.createdBy === userId || isApprover);
}

export function expensePayPayload(accountId: string) {
  return { paidFromAccountId: accountId };
}

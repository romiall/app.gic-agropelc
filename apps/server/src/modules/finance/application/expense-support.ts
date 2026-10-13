/**
 * Utilitaires internes des dépenses (P8 ; ADR-060 ; SM-EXPENSE ; D09 §7.3, §17), partagés par les
 * commandes (`expense-commands.ts`) et la décision `EXPENSE` (`expense-decisions.ts`).
 *
 * - Paramètres (règle 8, AV-058, AV-353) : seuils de validation et de justificatif, plafond du PDV,
 *   lus à `occurred_at`, ramenés au défaut s'ils sont absents ou mal formés.
 * - Politique `EXPENSE` : la plus récente qui exige une validation et nomme un approbateur ; hors
 *   ligne, repli sur celle en vigueur à la réception (BR-SYN-007, même règle que les remises).
 * - Coût (ADR-060 §8, BR-FIN-022) : une écriture par dépense imputée, source `EXPENSE`, identifiant
 *   de la dépense ; contrepassée à la date de la dépense quand elle est annulée.
 */
import type { Transaction } from 'kysely';
import {
  expenseCostLine,
  type ExpenseCostObjectType,
  type ExpenseSpeciesGroup,
  type ExpenseStatus,
  type IdGenerator,
} from '@gic/domain';
import type { DB } from '../../../platform/kysely/database.js';
import { jsonValue } from '../../../platform/kysely/json-value.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../organization/application/public/index.js';
import {
  currentPolicies,
  type ActiveControlPolicy,
} from '../../approvals/application/public/index.js';
import { recordCostEntry, reverseCostEntries } from '../../inventory/application/public/index.js';

type Uow = Transaction<DB>;

export const EXPENSE_DOC_TYPE = 'DEP';
export const EXPENSE_RECORD_PERMISSION = 'finance.expense.record';
export const EXPENSE_APPROVE_PERMISSION = 'finance.expense.approve';
export const EXPENSE_PAY_PERMISSION = 'finance.expense.pay';

/** Défauts d'AV-058 et AV-353 si le paramètre est absent ou mal formé. */
const DEFAULT_APPROVAL_THRESHOLD_XAF = 50_000;
const DEFAULT_PHOTO_THRESHOLD_XAF = 10_000;
const DEFAULT_POS_CAP_XAF = 50_000;

async function numberSettingAt(uow: Uow, key: string, at: Date, fallback: number): Promise<number> {
  const value = await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface ExpenseSettings {
  readonly approvalThresholdXaf: number;
  readonly photoThresholdXaf: number;
  readonly posCapXaf: number;
}

export async function expenseSettingsAt(uow: Uow, at: Date): Promise<ExpenseSettings> {
  return {
    approvalThresholdXaf: await numberSettingAt(
      uow,
      'finance.expense_approval_threshold_xaf',
      at,
      DEFAULT_APPROVAL_THRESHOLD_XAF,
    ),
    photoThresholdXaf: await numberSettingAt(
      uow,
      'finance.expense_photo_threshold_xaf',
      at,
      DEFAULT_PHOTO_THRESHOLD_XAF,
    ),
    posCapXaf: await numberSettingAt(uow, 'finance.pos_expense_max_xaf', at, DEFAULT_POS_CAP_XAF),
  };
}

/** Politique `EXPENSE` applicable (AV-351) ; hors ligne, repli sur celle de la réception. */
export async function expensePolicy(
  uow: Uow,
  at: Date,
  offlineFallbackAt?: Date,
): Promise<ActiveControlPolicy | undefined> {
  const pick = async (instant: Date) =>
    (await currentPolicies(uow, 'EXPENSE', instant)).find(
      (policy) => policy.requiresApproval && policy.approverPermission !== null,
    );
  const policy = await pick(at);
  if (policy !== undefined || offlineFallbackAt === undefined) return policy;
  return pick(offlineFallbackAt);
}

export interface ExpenseRow {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly categoryId: string;
  readonly amountXaf: number;
  readonly costObjectType: ExpenseCostObjectType | null;
  readonly costObjectId: string | null;
  readonly speciesGroup: ExpenseSpeciesGroup | null;
  readonly paidNow: boolean;
  readonly paidFromAccountId: string | null;
  readonly status: ExpenseStatus;
  readonly approvalRequestId: string | null;
  readonly occurredAt: Date;
  readonly createdBy: string;
}

/** Dépense lue par identifiant ; `lock: 'update'` la verrouille (rang des documents, ADR-061 §9). */
export async function loadExpense(
  uow: Uow,
  expenseId: string,
  options: { readonly lock?: 'update' } = {},
): Promise<ExpenseRow | undefined> {
  let query = uow
    .selectFrom('finance_expenses')
    .select([
      'id',
      'doc_number',
      'site_id',
      'category_id',
      'amount_xaf',
      'cost_object_type',
      'cost_object_id',
      'species_group',
      'paid_now',
      'paid_from_account_id',
      'status',
      'approval_request_id',
      'occurred_at',
      'created_by',
    ])
    .where('id', '=', toBin(expenseId));
  if (options.lock === 'update') query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    siteId: fromBin(row.site_id),
    categoryId: fromBin(row.category_id),
    amountXaf: Number(row.amount_xaf),
    costObjectType: row.cost_object_type as ExpenseCostObjectType | null,
    costObjectId: fromBinOrNull(row.cost_object_id),
    speciesGroup: row.species_group as ExpenseSpeciesGroup | null,
    paidNow: Boolean(row.paid_now),
    paidFromAccountId: fromBinOrNull(row.paid_from_account_id),
    status: row.status as ExpenseStatus,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    occurredAt: row.occurred_at,
    createdBy: fromBin(row.created_by),
  };
}

export interface ExpenseCategoryRow {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly defaultCostType: string | null;
  readonly allowedOnPos: boolean;
  readonly isSystem: boolean;
  readonly isActive: boolean;
}

export async function loadExpenseCategory(
  uow: Uow,
  categoryId: string,
): Promise<ExpenseCategoryRow | undefined> {
  const row = await uow
    .selectFrom('finance_expense_categories')
    .select([
      'id',
      'code',
      'label',
      'default_cost_type',
      'allowed_on_pos',
      'is_system',
      'is_active',
    ])
    .where('id', '=', toBin(categoryId))
    .executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        code: row.code,
        label: row.label,
        defaultCostType: row.default_cost_type,
        allowedOnPos: Boolean(row.allowed_on_pos),
        isSystem: Boolean(row.is_system),
        isActive: Boolean(row.is_active),
      }
    : undefined;
}

/**
 * Écriture de coût d'une dépense imputée (BR-FIN-022, ADR-060 §8) : par l'API d'`inventory`, à la date
 * de la dépense ; sans objet de coût, rien. Le type de coût vient de la catégorie (lot) ou de l'espèce
 * (site, frais généraux).
 */
export async function writeExpenseCost(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly expense: Pick<
      ExpenseRow,
      | 'id'
      | 'docNumber'
      | 'amountXaf'
      | 'costObjectType'
      | 'costObjectId'
      | 'speciesGroup'
      | 'occurredAt'
    >;
    readonly categoryCostType: string | null;
    readonly createdBy: string;
  },
): Promise<void> {
  const { expense } = input;
  if (expense.costObjectType === null || expense.costObjectId === null) return;
  const line = expenseCostLine({
    costObjectType: expense.costObjectType,
    speciesGroup: expense.speciesGroup,
    categoryCostType: input.categoryCostType,
  });
  await recordCostEntry(uow, deps, {
    costObjectType: expense.costObjectType,
    costObjectId: expense.costObjectId,
    costType: line.costType,
    ...(line.speciesGroup !== null ? { speciesGroup: line.speciesGroup } : {}),
    amountXaf: expense.amountXaf,
    direction: 'DEBIT',
    sourceType: 'EXPENSE',
    sourceId: expense.id,
    occurredAt: expense.occurredAt,
    createdBy: input.createdBy,
    comment: `Dépense ${expense.docNumber}`,
  });
}

/** Contrepassation du coût d'une dépense, à la date de la dépense (même mois de frais généraux). */
export async function reverseExpenseCost(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly expense: Pick<ExpenseRow, 'id' | 'docNumber' | 'occurredAt'>;
    readonly createdBy: string;
  },
): Promise<number> {
  return reverseCostEntries(uow, deps, {
    sourceType: 'EXPENSE',
    sourceIds: [input.expense.id],
    occurredAt: input.expense.occurredAt,
    createdBy: input.createdBy,
    comment: `Annulation de la dépense ${input.expense.docNumber}`,
  });
}

/** Événement nommé d'une dépense (D09 §10 ; outbox, ADR-011). */
export async function insertExpenseEvent(
  uow: Uow,
  idGenerator: IdGenerator,
  input: {
    readonly eventType: 'ExpenseRecorded' | 'ExpensePaid' | 'ExpenseApproved' | 'ExpenseRejected';
    readonly expenseId: string;
    readonly occurredAt: Date;
    readonly commandId: string | null;
    readonly payload: Record<string, unknown>;
  },
): Promise<void> {
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(idGenerator.newId()),
      event_type: input.eventType,
      producer_module: 'finance',
      aggregate_type: 'EXPENSE',
      aggregate_id: toBin(input.expenseId),
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
      ...(input.commandId !== null ? { command_id: toBin(input.commandId) } : {}),
    })
    .execute();
}

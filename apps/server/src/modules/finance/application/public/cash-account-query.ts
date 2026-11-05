/**
 * Lectures des comptes de trésorerie (P4-10 ; 08-api-events/01-architecture-api.md §4.9 :
 * `GET /cash-accounts`, `/cash-accounts/{id}/movements`). Aucune décision d'autorisation ici : le
 * transport `finance-api/` décide de la portée (`finance.cash.read`, RC-04) à partir de
 * `cashAccountResourceOf`. Pagination des mouvements par curseur, du plus récent au plus ancien sur
 * `id` (UUIDv7).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { CashAccountSummary, CashAccountType } from './cash-accounts.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const CASH_LIST_DEFAULT_LIMIT = 50;
export const CASH_LIST_MAX_LIMIT = 200;

/** Ressource d'un compte pour la portée : le détenteur (caisse personnelle) ou le responsable, et le site. */
export function cashAccountResourceOf(account: CashAccountSummary): {
  readonly ownerUserId: string;
  readonly siteId?: string;
} {
  return {
    ownerUserId: account.holderUserId ?? account.responsibleUserId,
    ...(account.siteId !== null ? { siteId: account.siteId } : {}),
  };
}

export async function listCashAccounts(
  executor: Executor,
  filter: {
    readonly siteIds?: readonly string[];
    readonly accountType?: CashAccountType;
    readonly status?: 'ACTIVE' | 'INACTIVE';
  } = {},
): Promise<readonly CashAccountSummary[]> {
  const rows = await executor
    .selectFrom('finance_cash_accounts')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      filter.siteIds!.length === 0
        ? qb.where('site_id', 'is', null)
        : qb.where((eb) =>
            eb.or([
              eb('site_id', 'is', null),
              eb(
                'site_id',
                'in',
                filter.siteIds!.map((id) => toBin(id)),
              ),
            ]),
          ),
    )
    .$if(filter.accountType !== undefined, (qb) =>
      qb.where('account_type', '=', filter.accountType!),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .orderBy('account_type', 'asc')
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    code: row.code,
    name: row.name,
    accountType: row.account_type as CashAccountType,
    siteId: fromBinOrNull(row.site_id),
    holderUserId: fromBinOrNull(row.holder_user_id),
    responsibleUserId: fromBin(row.responsible_user_id),
    externalRef: row.external_ref,
    balanceXaf: Number(row.balance_xaf),
    status: row.status as 'ACTIVE' | 'INACTIVE',
  }));
}

export interface CashMovementLine {
  readonly id: string;
  readonly direction: 'IN' | 'OUT';
  readonly amountXaf: number;
  readonly movementType: string;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  readonly occurredAt: string;
  readonly businessDate: string;
  readonly isReversal: boolean;
  readonly reversesMovementId: string | null;
  readonly createdBy: string;
  /** Session de caisse du mouvement (espèces d'une caisse de PDV, ADR-032), sinon `null`. */
  readonly cashSessionId: string | null;
  /**
   * Détail de la pièce d'origine, pour la feuille de caisse (AV-518) : numéro de pièce, libellé, mode de paiement
   * et référence. Servi ici pour les pièces de `finance` (dépense, paiement fournisseur, remise de fonds) ; les
   * encaissements clients sont complétés par le transport (`sales`), les autres restent `null`.
   */
  readonly docNumber: string | null;
  readonly label: string | null;
  readonly paymentMethodCode: string | null;
  readonly reference: string | null;
}

interface MovementDetail {
  readonly docNumber: string | null;
  readonly label: string | null;
  readonly paymentMethodCode: string | null;
  readonly reference: string | null;
}

const NO_DETAIL: MovementDetail = {
  docNumber: null,
  label: null,
  paymentMethodCode: null,
  reference: null,
};

/** Libellé court d'un mouvement : au plus 120 caractères (la feuille de caisse imprime une ligne). */
const LABEL_MAX = 120;
const clip = (text: string | null): string | null => {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') return null;
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
};

/** Détail des pièces que `finance` possède, par `type:identifiant` de la pièce d'origine. */
async function financeMovementDetails(
  executor: Executor,
  rows: readonly { readonly source_doc_type: string; readonly source_doc_id: Buffer }[],
): Promise<ReadonlyMap<string, MovementDetail>> {
  const details = new Map<string, MovementDetail>();
  const idsOf = (type: string): Buffer[] =>
    [
      ...new Set(
        rows.filter((r) => r.source_doc_type === type).map((r) => fromBin(r.source_doc_id)),
      ),
    ].map((id) => toBin(id));
  const expenseIds = idsOf('EXPENSE');
  if (expenseIds.length > 0) {
    const found = await executor
      .selectFrom('finance_expenses')
      .select(['id', 'doc_number', 'description'])
      .where('id', 'in', expenseIds)
      .execute();
    for (const row of found) {
      details.set(`EXPENSE:${fromBin(row.id)}`, {
        ...NO_DETAIL,
        docNumber: row.doc_number,
        label: clip(row.description),
      });
    }
  }
  const supplierPaymentIds = idsOf('SUPPLIER_PAYMENT');
  if (supplierPaymentIds.length > 0) {
    const found = await executor
      .selectFrom('finance_supplier_payments')
      .select(['id', 'doc_number', 'payment_method_code', 'external_reference', 'comment'])
      .where('id', 'in', supplierPaymentIds)
      .execute();
    for (const row of found) {
      details.set(`SUPPLIER_PAYMENT:${fromBin(row.id)}`, {
        docNumber: row.doc_number,
        label: clip(row.comment),
        paymentMethodCode: row.payment_method_code,
        reference: row.external_reference,
      });
    }
  }
  const transferIds = idsOf('CASH_TRANSFER');
  if (transferIds.length > 0) {
    const found = await executor
      .selectFrom('finance_cash_transfers')
      .select(['id', 'doc_number'])
      .where('id', 'in', transferIds)
      .execute();
    for (const row of found) {
      details.set(`CASH_TRANSFER:${fromBin(row.id)}`, { ...NO_DETAIL, docNumber: row.doc_number });
    }
  }
  return details;
}

export async function listCashMovements(
  executor: Executor,
  cashAccountId: string,
  filter: {
    readonly fromUtc?: Date;
    readonly toUtc?: Date;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<{ readonly items: readonly CashMovementLine[]; readonly nextCursor: string | null }> {
  const rows = await executor
    .selectFrom('finance_cash_movements')
    .selectAll()
    .select(sql<string>`DATE_FORMAT(business_date, '%Y-%m-%d')`.as('business_day'))
    .where('cash_account_id', '=', toBin(cashAccountId))
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('occurred_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  const details = await financeMovementDetails(executor, page);
  return {
    items: page.map((row) => ({
      id: fromBin(row.id),
      direction: row.direction as 'IN' | 'OUT',
      amountXaf: Number(row.amount_xaf),
      movementType: row.movement_type,
      sourceDocType: row.source_doc_type,
      sourceDocId: fromBin(row.source_doc_id),
      occurredAt: row.occurred_at.toISOString(),
      businessDate: row.business_day,
      isReversal: Boolean(row.is_reversal),
      reversesMovementId: fromBinOrNull(row.reverses_movement_id),
      createdBy: fromBin(row.created_by),
      cashSessionId: fromBinOrNull(row.cash_session_id),
      ...(details.get(`${row.source_doc_type}:${fromBin(row.source_doc_id)}`) ?? NO_DETAIL),
    })),
    nextCursor: hasMore ? fromBin(page[page.length - 1]!.id) : null,
  };
}

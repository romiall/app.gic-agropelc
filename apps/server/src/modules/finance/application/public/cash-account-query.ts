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
    })),
    nextCursor: hasMore ? fromBin(page[page.length - 1]!.id) : null,
  };
}

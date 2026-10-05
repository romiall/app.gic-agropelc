/**
 * Comptes de trésorerie : lecture, solde et réconciliation (D09 §7.2 ; BR-FIN-010 ; INV-FIN-02 :
 * « solde d'un compte = Σ `IN` − Σ `OUT` de `cash_movements` ; la projection est exacte »).
 *
 * - `findCashAccount` / `cashAccountBalance` : lecture de la projection `balance_xaf`.
 * - `verifyCashLedger` : compare, pour chaque compte, la projection à Σ `IN` − Σ `OUT` du registre.
 *   Lecture seule, **dans une transaction** : registre et projection sont lus dans le même
 *   instantané (isolation répétable), sinon un mouvement validé pendant la vérification donnerait
 *   un faux écart. Même patron que `inventory.verifyStockLedger`.
 * - `rebuildCashBalances` : remet la projection en accord avec le registre (seule source de
 *   vérité), comptes verrouillés d'abord puis registre lu ; procédure de maintenance déclenchée
 *   par un responsable après analyse d'un écart, jamais par une commande.
 * Les deux acceptent une portée facultative par comptes (`cashAccountIds`).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const CASH_ACCOUNT_TYPES = [
  'CAISSE_PDV',
  'CAISSE_UTILISATEUR',
  'CAISSE_CENTRALE',
  'MOBILE_MONEY',
  'BANQUE',
] as const;
export type CashAccountType = (typeof CASH_ACCOUNT_TYPES)[number];

export interface CashAccountSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: CashAccountType;
  readonly siteId: string | null;
  readonly holderUserId: string | null;
  readonly responsibleUserId: string;
  readonly externalRef: string | null;
  readonly balanceXaf: number;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export async function findCashAccount(
  executor: Executor,
  cashAccountId: string,
): Promise<CashAccountSummary | undefined> {
  const row = await executor
    .selectFrom('finance_cash_accounts')
    .selectAll()
    .where('id', '=', toBin(cashAccountId))
    .executeTakeFirst();
  return row
    ? {
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
      }
    : undefined;
}

/** Solde projeté du compte ; `undefined` si le compte n'existe pas. */
export async function cashAccountBalance(
  executor: Executor,
  cashAccountId: string,
): Promise<number | undefined> {
  const row = await executor
    .selectFrom('finance_cash_accounts')
    .select('balance_xaf')
    .where('id', '=', toBin(cashAccountId))
    .executeTakeFirst();
  return row ? Number(row.balance_xaf) : undefined;
}

export interface CashLedgerScope {
  /** Comptes vérifiés ou reconstruits ; tous si absent. */
  readonly cashAccountIds?: readonly string[];
}

export interface CashLedgerMismatch {
  readonly cashAccountId: string;
  readonly projectedXaf: number;
  readonly ledgerXaf: number;
}

export interface CashLedgerVerification {
  readonly ok: boolean;
  readonly accountsChecked: number;
  readonly mismatches: readonly CashLedgerMismatch[];
}

/** Σ `IN` − Σ `OUT` du registre, par compte (un compte sans mouvement vaut 0). */
async function ledgerTotals(
  executor: Executor,
  scope: CashLedgerScope,
): Promise<ReadonlyMap<string, number>> {
  const rows = await executor
    .selectFrom('finance_cash_movements')
    .select([
      'cash_account_id',
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount_xaf ELSE -amount_xaf END), 0)`.as(
        'total',
      ),
    ])
    .$if(scope.cashAccountIds !== undefined, (qb) =>
      scope.cashAccountIds!.length === 0
        ? qb.where(sql<boolean>`FALSE`)
        : qb.where(
            'cash_account_id',
            'in',
            scope.cashAccountIds!.map((id) => toBin(id)),
          ),
    )
    .groupBy('cash_account_id')
    .execute();
  return new Map(rows.map((row) => [fromBin(row.cash_account_id), Number(row.total)]));
}

async function projectedAccounts(
  executor: Executor,
  scope: CashLedgerScope,
  lock: boolean,
): Promise<readonly { readonly id: string; readonly balance: number }[]> {
  const rows = await executor
    .selectFrom('finance_cash_accounts')
    .select(['id', 'balance_xaf'])
    .$if(scope.cashAccountIds !== undefined, (qb) =>
      scope.cashAccountIds!.length === 0
        ? qb.where(sql<boolean>`FALSE`)
        : qb.where(
            'id',
            'in',
            scope.cashAccountIds!.map((id) => toBin(id)),
          ),
    )
    .$if(lock, (qb) => qb.forUpdate())
    .execute();
  return rows.map((row) => ({ id: fromBin(row.id), balance: Number(row.balance_xaf) }));
}

export async function verifyCashLedger(
  trx: Transaction<DB>,
  scope: CashLedgerScope = {},
): Promise<CashLedgerVerification> {
  const ledger = await ledgerTotals(trx, scope);
  const accounts = await projectedAccounts(trx, scope, false);
  const mismatches: CashLedgerMismatch[] = [];
  for (const account of accounts) {
    const ledgerXaf = ledger.get(account.id) ?? 0;
    if (account.balance !== ledgerXaf) {
      mismatches.push({ cashAccountId: account.id, projectedXaf: account.balance, ledgerXaf });
    }
  }
  return { ok: mismatches.length === 0, accountsChecked: accounts.length, mismatches };
}

/**
 * Reconstruit la projection depuis le registre ; renvoie le nombre de comptes corrigés. Verrouille
 * **d'abord** les comptes, lit **ensuite** le registre : un mouvement en cours attend le verrou et
 * applique son delta après la reconstruction, au lieu d'être écrasé par un registre lu trop tôt.
 */
export async function rebuildCashBalances(
  uow: Transaction<DB>,
  scope: CashLedgerScope = {},
): Promise<number> {
  const accounts = await projectedAccounts(uow, scope, true);
  const ledger = await ledgerTotals(uow, scope);
  let corrected = 0;
  for (const account of accounts) {
    const ledgerXaf = ledger.get(account.id) ?? 0;
    if (account.balance === ledgerXaf) continue;
    await uow
      .updateTable('finance_cash_accounts')
      .set({ balance_xaf: ledgerXaf, version: sql`version + 1` })
      .where('id', '=', toBin(account.id))
      .execute();
    corrected++;
  }
  return corrected;
}

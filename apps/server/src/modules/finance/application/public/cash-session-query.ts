/**
 * Lectures d'une session de caisse pour la couche de transport (P5-14 ; ADR-032 §1 à §3) : la session,
 * et les flux de sa fenêtre `[ouverture, clôture[` tirés du **registre** (hors `SESSION_VARIANCE` et
 * `OPENING_BALANCE`, qui ne comptent pas dans l'attendu). Les encaissements y sont détaillés par
 * document (`source_doc_id`), nets de leurs inverses, pour que le transport les rapporte au vendeur
 * (`sales`, que `finance` n'importe pas) ; les autres flux sont agrégés par type et sens. Lecture sans
 * verrou ni décision d'autorisation : celle-ci revient à l'appelant (route `GET /cash-sessions/{id}`,
 * P5-17).
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { CASH_EXPECTED_EXCLUDED_TYPES } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface CashSessionSummary {
  readonly id: string;
  readonly cashAccountId: string;
  readonly siteId: string;
  readonly status: 'OPEN' | 'PENDING_VALIDATION' | 'VALIDATED';
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly openedBy: string;
  readonly closedBy: string | null;
  readonly openingCountedXaf: number;
  readonly closingCountedXaf: number | null;
  readonly closingExpectedXaf: number | null;
  readonly varianceXaf: number | null;
}

export async function findCashSessionSummary(
  executor: Executor,
  sessionId: string,
): Promise<CashSessionSummary | undefined> {
  const row = await executor
    .selectFrom('finance_cash_sessions')
    .select([
      'id',
      'cash_account_id',
      'site_id',
      'status',
      'opened_at',
      'closed_at',
      'opened_by',
      'closed_by',
      'opening_counted_xaf',
      'closing_counted_xaf',
      'closing_expected_xaf',
      'variance_xaf',
    ])
    .where('id', '=', toBin(sessionId))
    .executeTakeFirst();
  if (!row) return undefined;
  const numberOrNull = (value: number | null) => (value === null ? null : Number(value));
  return {
    id: fromBin(row.id),
    cashAccountId: fromBin(row.cash_account_id),
    siteId: fromBin(row.site_id),
    status: row.status as CashSessionSummary['status'],
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openedBy: fromBin(row.opened_by),
    closedBy: fromBinOrNull(row.closed_by),
    openingCountedXaf: Number(row.opening_counted_xaf),
    closingCountedXaf: numberOrNull(row.closing_counted_xaf),
    closingExpectedXaf: numberOrNull(row.closing_expected_xaf),
    varianceXaf: numberOrNull(row.variance_xaf),
  };
}

export interface CashSessionWindowFlows {
  /** Encaissements de la fenêtre, par document, montant signé net de leurs inverses. */
  readonly payments: readonly { readonly paymentId: string; readonly signedXaf: number }[];
  /** Autres flux (remboursements, remises, dépenses…), agrégés par type et par sens. */
  readonly others: readonly {
    readonly movementType: string;
    readonly direction: 'IN' | 'OUT';
    readonly amountXaf: number;
    readonly count: number;
  }[];
  /** Σ signée de tous les flux de la fenêtre (l'attendu courant = fonds d'ouverture + ce total). */
  readonly netFlowsXaf: number;
}

export async function cashSessionWindowFlows(
  executor: Executor,
  session: Pick<CashSessionSummary, 'cashAccountId' | 'openedAt' | 'closedAt'>,
): Promise<CashSessionWindowFlows> {
  let query = executor
    .selectFrom('finance_cash_movements')
    .select([
      'movement_type',
      'direction',
      'source_doc_type',
      'source_doc_id',
      sql<string>`SUM(amount_xaf)`.as('total'),
      sql<string>`COUNT(*)`.as('count'),
    ])
    .where('cash_account_id', '=', toBin(session.cashAccountId))
    .where('occurred_at', '>=', session.openedAt)
    .where('movement_type', 'not in', [...CASH_EXPECTED_EXCLUDED_TYPES])
    .groupBy(['movement_type', 'direction', 'source_doc_type', 'source_doc_id']);
  if (session.closedAt !== null) query = query.where('occurred_at', '<', session.closedAt);
  const rows = await query.execute();

  const payments = new Map<string, number>();
  const others = new Map<
    string,
    { movementType: string; direction: 'IN' | 'OUT'; amountXaf: number; count: number }
  >();
  let netFlowsXaf = 0;
  for (const row of rows) {
    const amount = Number(row.total);
    const signed = row.direction === 'IN' ? amount : -amount;
    netFlowsXaf += signed;
    if (row.movement_type === 'CUSTOMER_PAYMENT' && row.source_doc_type === 'CUSTOMER_PAYMENT') {
      const paymentId = fromBin(row.source_doc_id);
      payments.set(paymentId, (payments.get(paymentId) ?? 0) + signed);
      continue;
    }
    const key = `${row.movement_type}:${row.direction}`;
    const current = others.get(key) ?? {
      movementType: row.movement_type,
      direction: row.direction as 'IN' | 'OUT',
      amountXaf: 0,
      count: 0,
    };
    current.amountXaf += amount;
    current.count += Number(row.count);
    others.set(key, current);
  }
  return {
    payments: [...payments.entries()].map(([paymentId, signedXaf]) => ({ paymentId, signedXaf })),
    others: [...others.values()].sort(
      (a, b) =>
        a.movementType.localeCompare(b.movementType) || a.direction.localeCompare(b.direction),
    ),
    netFlowsXaf,
  };
}

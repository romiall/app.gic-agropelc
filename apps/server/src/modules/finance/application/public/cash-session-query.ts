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

// --- P5-17 : liste et fiche pour `GET /cash-sessions`, `/cash-sessions/{id}` ----------------------------

/** Session complète (dictionnaire `finance.cash_sessions`), montants en XAF entiers. */
export interface CashSessionDetail {
  readonly id: string;
  readonly cashAccountId: string;
  readonly siteId: string;
  readonly businessDate: string | null;
  readonly status: 'OPEN' | 'PENDING_VALIDATION' | 'VALIDATED';
  readonly openedBy: string;
  readonly openedDeviceId: string | null;
  readonly openedAt: string;
  readonly openingCountedXaf: number;
  readonly openingExpectedXaf: number;
  readonly openingVarianceXaf: number;
  readonly closedBy: string | null;
  readonly closedDeviceId: string | null;
  readonly closedAt: string | null;
  readonly closingCountedXaf: number | null;
  readonly closingExpectedXaf: number | null;
  readonly varianceXaf: number | null;
  readonly forceClosed: boolean;
  readonly forcedBy: string | null;
  readonly autoValidated: boolean;
  readonly validatedBy: string | null;
  readonly validatedAt: string | null;
  readonly varianceReason: string | null;
  /** Demande `CASH_VARIANCE` de la clôture (P5-13), absente sans politique active (AV-183). */
  readonly approvalRequestId: string | null;
  readonly capturedOffline: boolean;
  readonly closeCapturedOffline: boolean;
  readonly clockSuspect: boolean;
  readonly version: number;
}

export interface CashSessionAdjustmentLine {
  readonly id: string;
  readonly cause: string;
  readonly varianceBeforeXaf: number;
  readonly varianceAfterXaf: number;
  readonly deltaXaf: number;
  readonly expectedAfterXaf: number;
  readonly treatment: string;
  readonly status: string;
  readonly appliedAt: string;
  readonly movementId: string;
  readonly triggerMovementId: string | null;
  readonly approvalRequestId: string | null;
  readonly validatedBy: string | null;
  readonly validatedAt: string | null;
  readonly varianceReason: string | null;
}

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();
const xafOrNull = (value: number | null): number | null => (value === null ? null : Number(value));

function selectSessionDetails(executor: Executor) {
  return executor
    .selectFrom('finance_cash_sessions')
    .selectAll()
    .select(sql<string | null>`DATE_FORMAT(business_date, '%Y-%m-%d')`.as('business_day'));
}

type SessionDetailRow = Awaited<
  ReturnType<ReturnType<typeof selectSessionDetails>['execute']>
>[number];

function toSessionDetail(row: SessionDetailRow): CashSessionDetail {
  return {
    id: fromBin(row.id),
    cashAccountId: fromBin(row.cash_account_id),
    siteId: fromBin(row.site_id),
    businessDate: row.business_day,
    status: row.status as CashSessionDetail['status'],
    openedBy: fromBin(row.opened_by),
    openedDeviceId: fromBinOrNull(row.opened_device_id),
    openedAt: row.opened_at.toISOString(),
    openingCountedXaf: Number(row.opening_counted_xaf),
    openingExpectedXaf: Number(row.opening_expected_xaf),
    openingVarianceXaf: Number(row.opening_variance_xaf),
    closedBy: fromBinOrNull(row.closed_by),
    closedDeviceId: fromBinOrNull(row.closed_device_id),
    closedAt: isoOrNull(row.closed_at),
    closingCountedXaf: xafOrNull(row.closing_counted_xaf),
    closingExpectedXaf: xafOrNull(row.closing_expected_xaf),
    varianceXaf: xafOrNull(row.variance_xaf),
    forceClosed: Boolean(row.force_closed),
    forcedBy: fromBinOrNull(row.forced_by),
    autoValidated: Boolean(row.auto_validated),
    validatedBy: fromBinOrNull(row.validated_by),
    validatedAt: isoOrNull(row.validated_at),
    varianceReason: row.variance_reason,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    capturedOffline: Boolean(row.captured_offline),
    closeCapturedOffline: Boolean(row.close_captured_offline),
    clockSuspect: Boolean(row.clock_suspect),
    version: row.version,
  };
}

/**
 * Sessions de caisse, de la plus récente à la plus ancienne (`id`, UUIDv7). `cashAccountIds` :
 * restriction aux caisses visibles de l'appelant (liste vide ⇒ aucune session) ; absent ⇒ toutes.
 * Période sur le jour métier d'ouverture (`business_date`).
 */
export async function listCashSessions(
  executor: Executor,
  filter: {
    readonly cashAccountIds?: readonly string[];
    readonly status?: CashSessionDetail['status'];
    readonly fromDate?: string;
    readonly toDate?: string;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<{ readonly items: readonly CashSessionDetail[]; readonly nextCursor: string | null }> {
  if (filter.cashAccountIds !== undefined && filter.cashAccountIds.length === 0) {
    return { items: [], nextCursor: null };
  }
  const rows = await selectSessionDetails(executor)
    .$if(filter.cashAccountIds !== undefined, (qb) =>
      qb.where(
        'cash_account_id',
        'in',
        filter.cashAccountIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.fromDate !== undefined, (qb) =>
      qb.where(sql<boolean>`business_date >= ${filter.fromDate!}`),
    )
    .$if(filter.toDate !== undefined, (qb) =>
      qb.where(sql<boolean>`business_date <= ${filter.toDate!}`),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    items: page.map(toSessionDetail),
    nextCursor: hasMore ? fromBin(page[page.length - 1]!.id) : null,
  };
}

export async function findCashSessionDetail(
  executor: Executor,
  id: string,
): Promise<CashSessionDetail | null> {
  const row = await selectSessionDetails(executor).where('id', '=', toBin(id)).executeTakeFirst();
  return row ? toSessionDetail(row) : null;
}

/** Ajustements d'une session close (réévaluations par le delta, P5-13), dans l'ordre d'application. */
export async function listCashSessionAdjustments(
  executor: Executor,
  sessionId: string,
): Promise<readonly CashSessionAdjustmentLine[]> {
  const rows = await executor
    .selectFrom('finance_cash_session_adjustments')
    .selectAll()
    .where('session_id', '=', toBin(sessionId))
    .orderBy('applied_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    cause: row.cause,
    varianceBeforeXaf: Number(row.variance_before_xaf),
    varianceAfterXaf: Number(row.variance_after_xaf),
    deltaXaf: Number(row.delta_xaf),
    expectedAfterXaf: Number(row.expected_after_xaf),
    treatment: row.treatment,
    status: row.status,
    appliedAt: row.applied_at.toISOString(),
    movementId: fromBin(row.movement_id),
    triggerMovementId: fromBinOrNull(row.trigger_movement_id),
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    validatedBy: fromBinOrNull(row.validated_by),
    validatedAt: isoOrNull(row.validated_at),
    varianceReason: row.variance_reason,
  }));
}

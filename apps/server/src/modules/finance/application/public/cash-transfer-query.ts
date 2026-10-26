/**
 * Remises de fonds : lectures publiques (P5-15 ; D09 §16 ; ADR-032 §7 ; INV-FIN-01, INV-FIN-02).
 *
 * - `findCashTransfer` : résumé typé d'une remise.
 * - `cashTransfersInTransit` : **indicateur « en transit »** — remises `SENT` (nombre, somme par
 *   `cashInTransitXaf`, envoi le plus ancien, part en retard au-delà du délai d'alerte), détaillées
 *   par compte source et destinataire. Fonction unique, réutilisée par les métriques et l'accueil
 *   (P5-19, P5-20 ; BR-ANA-009).
 * - `verifyCashTransfers` : cohérence du registre et des remises, en lecture seule — une sortie
 *   `TRANSFER_OUT` du montant envoyé ; une entrée `TRANSFER_IN` du montant reçu si et seulement si la
 *   remise a été reçue d'un montant > 0 ; l'inverse de la sortie si et seulement si elle est annulée ;
 *   aucun autre mouvement ne cite la remise (en particulier aucun `SESSION_VARIANCE`, ADR-032 §7) ;
 *   un écart en attente a sa demande `CASH_TRANSFER_DISCREPANCY` en attente, un écart clos sa
 *   demande approuvée. Le branchement dans `finance.cash.reconcile_daily` relève de P5-22.
 */
import { cashInTransitXaf, isTransferUnreceived } from '@gic/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { cashTransferUnreceivedHoursAt } from '../cash-transfer-support.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface CashTransferSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly localRef: string | null;
  readonly siteId: string | null;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountSentXaf: number;
  readonly amountReceivedXaf: number | null;
  readonly discrepancyXaf: number | null;
  readonly status: 'SENT' | 'RECEIVED' | 'DISCREPANCY_PENDING' | 'CLOSED' | 'CANCELLED';
  readonly sentBy: string;
  readonly sentAt: Date;
  readonly carrierUserId: string | null;
  readonly carrierName: string | null;
  readonly receivedBy: string | null;
  readonly receivedAt: Date | null;
  readonly outMovementId: string;
  readonly inMovementId: string | null;
  readonly cancelMovementId: string | null;
  readonly imputation: string | null;
  readonly closingReason: string | null;
  readonly closedBy: string | null;
  readonly closedAt: Date | null;
  readonly approvalRequestId: string | null;
  readonly cancelReason: string | null;
  readonly cancelledBy: string | null;
  readonly cancelledAt: Date | null;
  readonly capturedOffline: boolean;
}

type TransferDbRow = Awaited<ReturnType<typeof selectTransfers>>[number];

function selectTransfers(executor: Executor, ids?: readonly string[]) {
  return executor
    .selectFrom('finance_cash_transfers')
    .selectAll()
    .$if(ids !== undefined, (qb) =>
      ids!.length === 0
        ? qb.where(sql<boolean>`FALSE`)
        : qb.where(
            'id',
            'in',
            ids!.map((id) => toBin(id)),
          ),
    )
    .orderBy('id')
    .execute();
}

function toSummary(row: TransferDbRow): CashTransferSummary {
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    localRef: row.local_ref,
    siteId: fromBinOrNull(row.site_id),
    fromAccountId: fromBin(row.from_account_id),
    toAccountId: fromBin(row.to_account_id),
    amountSentXaf: Number(row.amount_sent_xaf),
    amountReceivedXaf: row.amount_received_xaf === null ? null : Number(row.amount_received_xaf),
    discrepancyXaf: row.discrepancy_xaf === null ? null : Number(row.discrepancy_xaf),
    status: row.status as CashTransferSummary['status'],
    sentBy: fromBin(row.sent_by),
    sentAt: row.sent_at,
    carrierUserId: fromBinOrNull(row.carrier_user_id),
    carrierName: row.carrier_name,
    receivedBy: fromBinOrNull(row.received_by),
    receivedAt: row.received_at,
    outMovementId: fromBin(row.out_movement_id),
    inMovementId: fromBinOrNull(row.in_movement_id),
    cancelMovementId: fromBinOrNull(row.cancel_movement_id),
    imputation: row.imputation,
    closingReason: row.closing_reason,
    closedBy: fromBinOrNull(row.closed_by),
    closedAt: row.closed_at,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    cancelReason: row.cancel_reason,
    cancelledBy: fromBinOrNull(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    capturedOffline: Boolean(row.captured_offline),
  };
}

export async function findCashTransfer(
  executor: Executor,
  transferId: string,
): Promise<CashTransferSummary | undefined> {
  const [row] = await selectTransfers(executor, [transferId]);
  return row ? toSummary(row) : undefined;
}

// --- P5-17 : liste et mouvements pour `GET /cash-transfers`, `/cash-transfers/{id}` ------------------

export const CASH_TRANSFER_STATUSES = [
  'SENT',
  'RECEIVED',
  'DISCREPANCY_PENDING',
  'CLOSED',
  'CANCELLED',
] as const;

/**
 * Remises de fonds, de la plus récente à la plus ancienne (`id`). `accountIds` : remises dont l'un des
 * deux comptes en fait partie (comptes visibles de l'appelant ; liste vide ⇒ aucune) ; absent ⇒ toutes.
 * Période sur l'heure d'envoi (`sent_at`).
 */
export async function listCashTransfers(
  executor: Executor,
  filter: {
    readonly accountIds?: readonly string[];
    readonly status?: CashTransferSummary['status'];
    readonly fromUtc?: Date;
    readonly toUtc?: Date;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<{ readonly items: readonly CashTransferSummary[]; readonly nextCursor: string | null }> {
  if (filter.accountIds !== undefined && filter.accountIds.length === 0) {
    return { items: [], nextCursor: null };
  }
  const accounts = filter.accountIds?.map((id) => toBin(id));
  const rows = await executor
    .selectFrom('finance_cash_transfers')
    .selectAll()
    .$if(accounts !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([eb('from_account_id', 'in', accounts!), eb('to_account_id', 'in', accounts!)]),
      ),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('sent_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('sent_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    items: page.map(toSummary),
    nextCursor: hasMore ? fromBin(page[page.length - 1]!.id) : null,
  };
}

export interface CashTransferMovementLine {
  readonly id: string;
  readonly cashAccountId: string;
  readonly direction: 'IN' | 'OUT';
  readonly amountXaf: number;
  readonly movementType: string;
  readonly occurredAt: string;
  readonly isReversal: boolean;
  readonly reversesMovementId: string | null;
}

/** Mouvements de trésorerie d'une remise (sortie, entrée, inverse d'annulation), dans l'ordre. */
export async function cashTransferMovements(
  executor: Executor,
  transferId: string,
): Promise<readonly CashTransferMovementLine[]> {
  const rows = await executor
    .selectFrom('finance_cash_movements')
    .select([
      'id',
      'cash_account_id',
      'direction',
      'amount_xaf',
      'movement_type',
      'occurred_at',
      'is_reversal',
      'reverses_movement_id',
    ])
    .where('source_doc_type', '=', 'CASH_TRANSFER')
    .where('source_doc_id', '=', toBin(transferId))
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    cashAccountId: fromBin(row.cash_account_id),
    direction: row.direction as 'IN' | 'OUT',
    amountXaf: Number(row.amount_xaf),
    movementType: row.movement_type,
    occurredAt: row.occurred_at.toISOString(),
    isReversal: Boolean(row.is_reversal),
    reversesMovementId: fromBinOrNull(row.reverses_movement_id),
  }));
}

// --- Indicateur « en transit » ------------------------------------------------------------------------

export interface CashTransferAccountTotal {
  readonly accountId: string;
  readonly count: number;
  readonly totalXaf: number;
}

export interface CashTransfersInTransit {
  readonly count: number;
  /** Σ des montants envoyés des remises `SENT` (`cashInTransitXaf`). */
  readonly totalXaf: number;
  readonly oldestSentAt: Date | null;
  /** Délai d'alerte appliqué (heures, `finance.cash_transfer_unreceived_hours`). */
  readonly unreceivedHours: number;
  readonly overdueCount: number;
  readonly overdueXaf: number;
  readonly outgoingByAccount: readonly CashTransferAccountTotal[];
  readonly incomingByAccount: readonly CashTransferAccountTotal[];
}

function totalsBy(
  transfers: readonly { readonly accountId: string; readonly amountSentXaf: number }[],
): CashTransferAccountTotal[] {
  const totals = new Map<string, { count: number; totalXaf: number }>();
  for (const transfer of transfers) {
    const current = totals.get(transfer.accountId) ?? { count: 0, totalXaf: 0 };
    current.count += 1;
    current.totalXaf += transfer.amountSentXaf;
    totals.set(transfer.accountId, current);
  }
  return [...totals.entries()]
    .map(([accountId, total]) => ({ accountId, ...total }))
    .sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
}

/**
 * Remises envoyées et pas encore reçues ni annulées. Filtres facultatifs : comptes (source **ou**
 * destinataire parmi eux) et sites de la remise. `unreceivedHours` absent : paramètre lu à `now`.
 */
export async function cashTransfersInTransit(
  executor: Executor,
  filter: {
    readonly now: Date;
    readonly accountIds?: readonly string[];
    readonly siteIds?: readonly string[];
    readonly unreceivedHours?: number;
  },
): Promise<CashTransfersInTransit> {
  const unreceivedHours =
    filter.unreceivedHours ?? (await cashTransferUnreceivedHoursAt(executor, filter.now));
  const empty = filter.accountIds?.length === 0 || filter.siteIds?.length === 0;
  const rows = empty
    ? []
    : await executor
        .selectFrom('finance_cash_transfers')
        .select(['from_account_id', 'to_account_id', 'amount_sent_xaf', 'sent_at', 'status'])
        .where('status', '=', 'SENT')
        .$if(filter.accountIds !== undefined, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb(
                'from_account_id',
                'in',
                filter.accountIds!.map((id) => toBin(id)),
              ),
              eb(
                'to_account_id',
                'in',
                filter.accountIds!.map((id) => toBin(id)),
              ),
            ]),
          ),
        )
        .$if(filter.siteIds !== undefined, (qb) =>
          qb.where(
            'site_id',
            'in',
            filter.siteIds!.map((id) => toBin(id)),
          ),
        )
        .execute();
  const transfers = rows.map((row) => ({
    status: row.status,
    fromAccountId: fromBin(row.from_account_id),
    toAccountId: fromBin(row.to_account_id),
    amountSentXaf: Number(row.amount_sent_xaf),
    sentAt: row.sent_at,
  }));
  const overdue = transfers.filter((t) =>
    isTransferUnreceived(t.sentAt, filter.now, unreceivedHours),
  );
  const oldest = transfers.reduce<Date | null>(
    (min, t) => (min === null || t.sentAt.getTime() < min.getTime() ? t.sentAt : min),
    null,
  );
  return {
    count: transfers.length,
    totalXaf: cashInTransitXaf(transfers),
    oldestSentAt: oldest,
    unreceivedHours,
    overdueCount: overdue.length,
    overdueXaf: cashInTransitXaf(overdue),
    outgoingByAccount: totalsBy(transfers.map((t) => ({ ...t, accountId: t.fromAccountId }))),
    incomingByAccount: totalsBy(transfers.map((t) => ({ ...t, accountId: t.toAccountId }))),
  };
}

// --- Cohérence registre / remises -------------------------------------------------------------------

export interface CashTransferMismatch {
  readonly transferId: string;
  readonly docNumber: string;
  /** Compte source de la remise : rattache l'écart à un compte pour l'alerte `CASH_MISMATCH` (P9-07). */
  readonly fromAccountId: string;
  /** Code de l'anomalie (ex. `OUT_MOVEMENT_MISMATCH`, `UNEXPECTED_MOVEMENT`). */
  readonly issue: string;
  readonly detail: string;
}

export interface CashTransferVerification {
  readonly ok: boolean;
  readonly transfersChecked: number;
  readonly mismatches: readonly CashTransferMismatch[];
}

interface MovementRow {
  readonly id: string;
  readonly accountId: string;
  readonly direction: string;
  readonly amountXaf: number;
  readonly movementType: string;
  readonly isReversal: boolean;
  readonly reversesMovementId: string | null;
}

/**
 * Vérifie la cohérence des remises (toutes, ou celles de `transferIds`) avec le registre de
 * trésorerie. Lecture seule, **dans une transaction** (remises, mouvements et demandes lus dans le
 * même instantané, comme `verifyCashLedger`).
 */
export async function verifyCashTransfers(
  trx: Transaction<DB>,
  scope: { readonly transferIds?: readonly string[] } = {},
): Promise<CashTransferVerification> {
  const rows = await selectTransfers(trx, scope.transferIds);
  if (rows.length === 0) return { ok: true, transfersChecked: 0, mismatches: [] };
  const ids = rows.map((row) => row.id);

  const movementRows = await trx
    .selectFrom('finance_cash_movements')
    .select([
      'id',
      'cash_account_id',
      'direction',
      'amount_xaf',
      'movement_type',
      'source_doc_id',
      'is_reversal',
      'reverses_movement_id',
    ])
    .where('source_doc_type', '=', 'CASH_TRANSFER')
    .where('source_doc_id', 'in', ids)
    .execute();
  const movementsByTransfer = new Map<string, MovementRow[]>();
  for (const m of movementRows) {
    const key = fromBin(m.source_doc_id);
    const list = movementsByTransfer.get(key) ?? [];
    list.push({
      id: fromBin(m.id),
      accountId: fromBin(m.cash_account_id),
      direction: m.direction,
      amountXaf: Number(m.amount_xaf),
      movementType: m.movement_type,
      isReversal: Boolean(m.is_reversal),
      reversesMovementId: fromBinOrNull(m.reverses_movement_id),
    });
    movementsByTransfer.set(key, list);
  }

  const requestIds = rows
    .map((row) => row.approval_request_id)
    .filter((id): id is Buffer => id !== null);
  const requests = new Map<string, { status: string; operationType: string; subjectId: string }>();
  if (requestIds.length > 0) {
    for (const r of await trx
      .selectFrom('approvals_approval_requests')
      .select(['id', 'status', 'operation_type', 'subject_id'])
      .where('id', 'in', requestIds)
      .execute()) {
      requests.set(fromBin(r.id), {
        status: r.status,
        operationType: r.operation_type,
        subjectId: fromBin(r.subject_id),
      });
    }
  }

  const mismatches: CashTransferMismatch[] = [];
  for (const row of rows) {
    const t = toSummary(row);
    const report = (issue: string, detail: string) =>
      mismatches.push({
        transferId: t.id,
        docNumber: t.docNumber,
        fromAccountId: t.fromAccountId,
        issue,
        detail,
      });
    const movements = movementsByTransfer.get(t.id) ?? [];
    const byId = new Map(movements.map((m) => [m.id, m]));

    const out = byId.get(t.outMovementId);
    if (
      !out ||
      out.accountId !== t.fromAccountId ||
      out.direction !== 'OUT' ||
      out.movementType !== 'TRANSFER_OUT' ||
      out.amountXaf !== t.amountSentXaf ||
      out.isReversal
    ) {
      report(
        'OUT_MOVEMENT_MISMATCH',
        'Sortie TRANSFER_OUT du montant envoyé absente ou différente.',
      );
    }

    const received =
      ['RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED'].includes(t.status) &&
      (t.amountReceivedXaf ?? 0) > 0;
    if (received) {
      const entry = t.inMovementId === null ? undefined : byId.get(t.inMovementId);
      if (
        !entry ||
        entry.accountId !== t.toAccountId ||
        entry.direction !== 'IN' ||
        entry.movementType !== 'TRANSFER_IN' ||
        entry.amountXaf !== t.amountReceivedXaf ||
        entry.isReversal
      ) {
        report('IN_MOVEMENT_MISMATCH', 'Entrée TRANSFER_IN du montant reçu absente ou différente.');
      }
    } else if (t.inMovementId !== null) {
      report(
        'IN_MOVEMENT_UNEXPECTED',
        'Entrée de trésorerie sur une remise non reçue ou reçue à 0.',
      );
    }

    if (t.status === 'CANCELLED') {
      const inverse = t.cancelMovementId === null ? undefined : byId.get(t.cancelMovementId);
      if (
        !inverse ||
        inverse.accountId !== t.fromAccountId ||
        inverse.direction !== 'IN' ||
        inverse.movementType !== 'TRANSFER_OUT' ||
        inverse.amountXaf !== t.amountSentXaf ||
        !inverse.isReversal ||
        inverse.reversesMovementId !== t.outMovementId
      ) {
        report('CANCEL_MOVEMENT_MISMATCH', 'Inverse de la sortie absent ou différent.');
      }
    } else if (t.cancelMovementId !== null) {
      report('CANCEL_MOVEMENT_UNEXPECTED', 'Inverse de la sortie sur une remise non annulée.');
    }

    const known = new Set(
      [t.outMovementId, t.inMovementId, t.cancelMovementId].filter(
        (id): id is string => id !== null,
      ),
    );
    for (const m of movements) {
      if (!known.has(m.id)) {
        report(
          'UNEXPECTED_MOVEMENT',
          `Mouvement ${m.movementType} ${m.direction} ${m.amountXaf} XAF (${m.id}) non rattaché à la remise.`,
        );
      }
    }

    // Sans demande : aucune politique active à la réception, écart clos directement (AV-183, P5-23).
    if (
      (t.status === 'DISCREPANCY_PENDING' || t.status === 'CLOSED') &&
      t.approvalRequestId !== null
    ) {
      const request = requests.get(t.approvalRequestId);
      const expected = t.status === 'DISCREPANCY_PENDING' ? 'PENDING' : 'APPROVED';
      if (
        !request ||
        request.operationType !== 'CASH_TRANSFER_DISCREPANCY' ||
        request.subjectId !== t.id ||
        request.status !== expected
      ) {
        report(
          'DISCREPANCY_REQUEST_MISMATCH',
          `Demande CASH_TRANSFER_DISCREPANCY ${expected} attendue (trouvée : ${request?.status ?? 'aucune'}).`,
        );
      }
    }
  }
  return { ok: mismatches.length === 0, transfersChecked: rows.length, mismatches };
}

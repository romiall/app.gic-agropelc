/**
 * Balayage des sessions de caisse (P5-22 ; INV-FIN-05, INV-FIN-06, INV-FIN-11 ; ADR-032 ; BR-DIS-006) :
 * branché sur `finance.cash.reconcile_daily` et sur le balayage d'invariants des tests. Lectures simples
 * groupées, **sans aucun verrou** (une lecture verrouillante par session poserait des verrous de plage sur
 * le registre et bloquerait les synchronisations de la nuit, `cash-session-ledger.ts`) : toutes les
 * lectures voient l'instantané de la transaction de l'appelant. Même niveau d'ambition que la
 * réconciliation du stock : agrégation complète, acceptable au volume (une passe par l'index
 * `(cash_account_id, occurred_at)` du registre, les fenêtres d'un compte ne se chevauchant pas).
 *
 * Contrôles, session par session :
 * - INV-FIN-06 : au plus une session `OPEN` par compte ; aucune fenêtre d'un compte n'en chevauche une
 *   autre (ADR-032 §2) ;
 * - BR-DIS-006, AV-165 : la session est celle d'une caisse de PDV, sur le site du compte ;
 * - INV-FIN-11 (sessions closes) : Σ signée des `SESSION_VARIANCE` de clôture et d'ajustement de la
 *   session = compté − attendu courant (fonds compté + flux de la fenêtre `[ouverture, clôture[`, hors
 *   écarts et soldes d'ouverture), et = écart enregistré + Σ des deltas d'ajustement ;
 * - INV-FIN-05 : tout `SESSION_VARIANCE` qui cite la session est l'écart d'ouverture, celui de clôture ou
 *   le mouvement d'un ajustement, chacun du montant enregistré ; un ajustement n'existe que sur une session
 *   close, dans le traitement que permet son statut.
 * Ne sont pas contrôlés (valeurs figées par construction, faux positifs légitimes) : l'attendu instantané
 * à l'ouverture et à la clôture (un fait antidaté les déplace), l'index `cash_session_id` du registre.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { cashSessionWindowsOverlap } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { isOpeningVarianceMovement } from '../cash-session-variance-rule.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface CashSessionBreach {
  readonly sessionId: string;
  readonly cashAccountId: string;
  /** Invariant ou règle en cause (`INV-FIN-05`, `INV-FIN-06`, `INV-FIN-11`, `BR-DIS-006`). */
  readonly invariant: string;
  /** Code de l'anomalie (ex. `POSTED_NOT_COUNTED_MINUS_EXPECTED`, `WINDOWS_OVERLAP`). */
  readonly issue: string;
  readonly detail: string;
}

export interface CashSessionVerification {
  readonly ok: boolean;
  readonly sessionsChecked: number;
  readonly breaches: readonly CashSessionBreach[];
}

export interface CashSessionScope {
  readonly cashAccountIds?: readonly string[];
  readonly sessionIds?: readonly string[];
}

interface SessionRow {
  readonly id: string;
  readonly cashAccountId: string;
  readonly siteId: string;
  readonly status: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly openingCountedXaf: number;
  readonly openingVarianceXaf: number;
  readonly closingCountedXaf: number | null;
  readonly varianceXaf: number | null;
  readonly commandId: string | null;
  readonly closeCommandId: string | null;
  readonly accountType: string;
  readonly accountSiteId: string | null;
}

const signed = (direction: string, amount: number) => (direction === 'IN' ? amount : -amount);

export async function verifyCashSessions(
  executor: Executor,
  scope: CashSessionScope = {},
): Promise<CashSessionVerification> {
  if (
    (scope.cashAccountIds !== undefined && scope.cashAccountIds.length === 0) ||
    (scope.sessionIds !== undefined && scope.sessionIds.length === 0)
  ) {
    return { ok: true, sessionsChecked: 0, breaches: [] };
  }
  let sessionQuery = executor
    .selectFrom('finance_cash_sessions as s')
    .innerJoin('finance_cash_accounts as a', 'a.id', 's.cash_account_id')
    .select([
      's.id',
      's.cash_account_id',
      's.site_id',
      's.status',
      's.opened_at',
      's.closed_at',
      's.opening_counted_xaf',
      's.opening_variance_xaf',
      's.closing_counted_xaf',
      's.variance_xaf',
      's.command_id',
      's.close_command_id',
      'a.account_type',
      'a.site_id as account_site_id',
    ]);
  if (scope.cashAccountIds !== undefined) {
    sessionQuery = sessionQuery.where(
      's.cash_account_id',
      'in',
      scope.cashAccountIds.map((id) => toBin(id)),
    );
  }
  if (scope.sessionIds !== undefined) {
    sessionQuery = sessionQuery.where(
      's.id',
      'in',
      scope.sessionIds.map((id) => toBin(id)),
    );
  }
  const sessions: SessionRow[] = (await sessionQuery.execute()).map((row) => ({
    id: fromBin(row.id),
    cashAccountId: fromBin(row.cash_account_id),
    siteId: fromBin(row.site_id),
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openingCountedXaf: Number(row.opening_counted_xaf),
    openingVarianceXaf: Number(row.opening_variance_xaf),
    closingCountedXaf: row.closing_counted_xaf === null ? null : Number(row.closing_counted_xaf),
    varianceXaf: row.variance_xaf === null ? null : Number(row.variance_xaf),
    commandId: fromBinOrNull(row.command_id),
    closeCommandId: fromBinOrNull(row.close_command_id),
    accountType: row.account_type,
    accountSiteId: fromBinOrNull(row.account_site_id),
  }));
  if (sessions.length === 0) return { ok: true, sessionsChecked: 0, breaches: [] };
  const breaches: CashSessionBreach[] = [];
  const breach = (session: SessionRow, invariant: string, issue: string, detail: string): void => {
    breaches.push({
      sessionId: session.id,
      cashAccountId: session.cashAccountId,
      invariant,
      issue,
      detail,
    });
  };

  // INV-FIN-06 et non-chevauchement (ADR-032 §2), compte par compte — sur toutes les sessions du compte,
  // même hors de la portée d'identifiants (une session voisine non demandée peut chevaucher).
  const accountIds = [...new Set(sessions.map((s) => s.cashAccountId))];
  const windows = await executor
    .selectFrom('finance_cash_sessions')
    .select(['id', 'cash_account_id', 'status', 'opened_at', 'closed_at'])
    .where(
      'cash_account_id',
      'in',
      accountIds.map((id) => toBin(id)),
    )
    .orderBy('cash_account_id')
    .orderBy('opened_at')
    .execute();
  const byAccount = new Map<
    string,
    { id: string; status: string; openedAt: Date; closedAt: Date | null }[]
  >();
  for (const row of windows) {
    const accountId = fromBin(row.cash_account_id);
    const list = byAccount.get(accountId) ?? [];
    list.push({
      id: fromBin(row.id),
      status: row.status,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
    });
    byAccount.set(accountId, list);
  }
  const inScope = new Set(sessions.map((s) => s.id));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  for (const [, list] of byAccount) {
    const open = list.filter((w) => w.status === 'OPEN');
    if (open.length > 1) {
      for (const w of open) {
        const session = sessionById.get(w.id);
        if (session)
          breach(
            session,
            'INV-FIN-06',
            'MULTIPLE_OPEN',
            `${open.length} sessions ouvertes sur le compte.`,
          );
      }
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (!cashSessionWindowsOverlap(a, b)) continue;
        for (const w of [a, b]) {
          const session = sessionById.get(w.id);
          if (session && inScope.has(w.id)) {
            breach(
              session,
              'INV-FIN-06',
              'WINDOWS_OVERLAP',
              `Fenêtre chevauchant la session ${w === a ? b.id : a.id}.`,
            );
          }
        }
      }
    }
  }

  // BR-DIS-006, AV-165 : caisse de PDV, sur son site.
  for (const session of sessions) {
    if (session.accountType !== 'CAISSE_PDV') {
      breach(session, 'BR-DIS-006', 'ACCOUNT_NOT_POS', `Compte de type ${session.accountType}.`);
    } else if (session.accountSiteId !== session.siteId) {
      breach(
        session,
        'BR-DIS-006',
        'SITE_MISMATCH',
        'Site de la session différent de celui de la caisse.',
      );
    }
  }

  const sessionIds = sessions.map((s) => toBin(s.id));
  // Flux des fenêtres des sessions closes, hors écarts et soldes d'ouverture (ADR-032 §3).
  const closedIds = sessions.filter((s) => s.status !== 'OPEN').map((s) => toBin(s.id));
  const flows = new Map<string, number>();
  if (closedIds.length > 0) {
    const rows = await executor
      .selectFrom('finance_cash_sessions as s')
      .innerJoin('finance_cash_movements as m', (join) =>
        join
          .onRef('m.cash_account_id', '=', 's.cash_account_id')
          .onRef('m.occurred_at', '>=', 's.opened_at')
          .onRef('m.occurred_at', '<', 's.closed_at'),
      )
      .select([
        's.id',
        sql<string>`SUM(CASE WHEN m.direction = 'IN' THEN m.amount_xaf ELSE -m.amount_xaf END)`.as(
          'flow',
        ),
      ])
      .where('s.id', 'in', closedIds)
      .where('m.movement_type', 'not in', ['SESSION_VARIANCE', 'OPENING_BALANCE'])
      .groupBy('s.id')
      .execute();
    for (const row of rows) flows.set(fromBin(row.id), Number(row.flow));
  }

  // Écarts qui citent les sessions, et ajustements.
  const varianceMoves = await executor
    .selectFrom('finance_cash_movements')
    .select([
      'id',
      'source_doc_id',
      'cash_account_id',
      'direction',
      'amount_xaf',
      'command_id',
      'occurred_at',
    ])
    .where('movement_type', '=', 'SESSION_VARIANCE')
    .where('source_doc_type', '=', 'CASH_SESSION')
    .where('source_doc_id', 'in', sessionIds)
    .execute();
  const adjustments = await executor
    .selectFrom('finance_cash_session_adjustments')
    .select(['id', 'session_id', 'movement_id', 'delta_xaf', 'treatment', 'status'])
    .where('session_id', 'in', sessionIds)
    .execute();
  const movesBySession = new Map<string, typeof varianceMoves>();
  for (const move of varianceMoves) {
    const key = fromBin(move.source_doc_id!);
    movesBySession.set(key, [...(movesBySession.get(key) ?? []), move]);
  }
  const adjustmentsBySession = new Map<string, typeof adjustments>();
  for (const adjustment of adjustments) {
    const key = fromBin(adjustment.session_id);
    adjustmentsBySession.set(key, [...(adjustmentsBySession.get(key) ?? []), adjustment]);
  }

  for (const session of sessions) {
    const moves = movesBySession.get(session.id) ?? [];
    const sessionAdjustments = adjustmentsBySession.get(session.id) ?? [];
    const adjustmentByMove = new Map(sessionAdjustments.map((a) => [fromBin(a.movement_id), a]));

    // INV-FIN-05 : chaque écart qui cite la session est tracé, au bon compte et du bon montant.
    let openingXaf = 0;
    let closingXaf = 0;
    let closingCount = 0;
    let adjustmentMovesXaf = 0;
    for (const move of moves) {
      const amount = signed(move.direction, Number(move.amount_xaf));
      const moveId = fromBin(move.id);
      if (fromBin(move.cash_account_id) !== session.cashAccountId) {
        breach(
          session,
          'INV-FIN-05',
          'VARIANCE_ON_OTHER_ACCOUNT',
          `Mouvement ${moveId} sur un autre compte.`,
        );
        continue;
      }
      const adjustment = adjustmentByMove.get(moveId);
      if (adjustment) {
        adjustmentMovesXaf += amount;
        if (amount !== Number(adjustment.delta_xaf)) {
          breach(
            session,
            'INV-FIN-05',
            'ADJUSTMENT_MOVEMENT_MISMATCH',
            `Ajustement ${fromBin(adjustment.id)} : mouvement ${amount} ≠ delta ${Number(adjustment.delta_xaf)}.`,
          );
        }
        continue;
      }
      const commandId = fromBinOrNull(move.command_id);
      if (isOpeningVarianceMovement({ commandId, occurredAt: move.occurred_at }, session)) {
        openingXaf += amount;
        continue;
      }
      const isClosing =
        session.status !== 'OPEN' &&
        (session.closeCommandId !== null
          ? commandId === session.closeCommandId
          : move.occurred_at.getTime() >= session.closedAt!.getTime());
      if (isClosing) {
        closingXaf += amount;
        closingCount += 1;
        continue;
      }
      breach(
        session,
        'INV-FIN-05',
        'UNTRACKED_VARIANCE_MOVEMENT',
        `Mouvement ${moveId} (${amount} XAF) ni d'ouverture, ni de clôture, ni d'ajustement.`,
      );
    }
    for (const adjustment of sessionAdjustments) {
      if (!moves.some((move) => fromBin(move.id) === fromBin(adjustment.movement_id))) {
        breach(
          session,
          'INV-FIN-05',
          'ADJUSTMENT_WITHOUT_MOVEMENT',
          `Ajustement ${fromBin(adjustment.id)} sans son mouvement d'écart.`,
        );
      }
      const allowed =
        session.status !== 'OPEN' &&
        !(
          adjustment.treatment === 'INCLUDED_IN_VALIDATION' &&
          adjustment.status === 'PENDING' &&
          session.status !== 'PENDING_VALIDATION'
        ) &&
        !(adjustment.treatment === 'OWN_APPROVAL' && session.status !== 'VALIDATED');
      if (!allowed) {
        breach(
          session,
          'INV-FIN-05',
          'ADJUSTMENT_STATE_INVALID',
          `Ajustement ${fromBin(adjustment.id)} (${adjustment.treatment}, ${adjustment.status}) sur une session ${session.status}.`,
        );
      }
    }
    if (openingXaf !== session.openingVarianceXaf) {
      breach(
        session,
        'INV-FIN-05',
        'OPENING_VARIANCE_MISMATCH',
        `Écart d'ouverture posé ${openingXaf} ≠ enregistré ${session.openingVarianceXaf}.`,
      );
    }
    if (session.status === 'OPEN') continue;

    if (closingCount > 1) {
      breach(
        session,
        'INV-FIN-05',
        'MULTIPLE_CLOSING_MOVEMENTS',
        `${closingCount} écarts de clôture.`,
      );
    }
    if (closingXaf !== (session.varianceXaf ?? 0)) {
      breach(
        session,
        'INV-FIN-05',
        'CLOSING_VARIANCE_MISMATCH',
        `Écart de clôture posé ${closingXaf} ≠ enregistré ${session.varianceXaf ?? 0}.`,
      );
    }
    // INV-FIN-11 : écarts posés et enregistrés = compté − attendu courant.
    const expected = session.openingCountedXaf + (flows.get(session.id) ?? 0);
    const target = (session.closingCountedXaf ?? 0) - expected;
    const posted = closingXaf + adjustmentMovesXaf;
    const recorded =
      (session.varianceXaf ?? 0) +
      sessionAdjustments.reduce((sum, adjustment) => sum + Number(adjustment.delta_xaf), 0);
    if (posted !== target) {
      breach(
        session,
        'INV-FIN-11',
        'POSTED_NOT_COUNTED_MINUS_EXPECTED',
        `Écarts posés ${posted} ≠ compté − attendu courant ${target}.`,
      );
    }
    if (recorded !== target) {
      breach(
        session,
        'INV-FIN-11',
        'RECORDED_NOT_COUNTED_MINUS_EXPECTED',
        `Écart enregistré + ajustements ${recorded} ≠ compté − attendu courant ${target}.`,
      );
    }
  }

  return { ok: breaches.length === 0, sessionsChecked: sessions.length, breaches };
}

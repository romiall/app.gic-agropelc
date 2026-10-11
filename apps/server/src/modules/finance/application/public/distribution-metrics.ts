/**
 * Métriques de distribution de `finance` (P5-19 ; D05 §14, BR-DIS-006 ; AV-165, AV-201) : sessions de
 * caisse des PDV (session ouverte, session du jour, écart courant, sessions et ajustements à valider)
 * et remises de fonds en attente (envoyées ou en écart). Fonctions **partagées** entre le tableau de
 * distribution (P5-20) et l'accueil (BR-ANA-009). Lecture seule ; montants en XAF entiers.
 *
 * Écart **courant** d'une session close (AV-193) : écart de clôture (jamais réécrit, dictionnaire) plus
 * Σ des deltas de ses ajustements de réévaluation (P5-13) — la même définition que la projection
 * hors ligne `CASH_SESSION` ; l'attendu courant = compté de clôture − écart courant.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { cashTransfersInTransit } from './cash-transfer-query.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface CashSessionBrief {
  readonly id: string;
  readonly status: string;
  /** Jour métier d'ouverture. */
  readonly businessDate: string;
  readonly openedAt: Date;
  readonly openedBy: string;
  readonly closedAt: Date | null;
  readonly openingVarianceXaf: number;
  readonly closingCountedXaf: number | null;
  readonly closingExpectedXaf: number | null;
  /** Écart de clôture (valeur figée). */
  readonly varianceXaf: number | null;
  /** Écart courant : clôture + réévaluations (nul tant que la session est ouverte). */
  readonly currentVarianceXaf: number | null;
  readonly currentExpectedXaf: number | null;
  readonly forceClosed: boolean;
}

export interface CashSessionsOverview {
  readonly accounts: readonly {
    readonly cashAccountId: string;
    readonly siteId: string | null;
    /** Session ouverte maintenant (au plus une, INV-FIN-06), quel que soit son jour d'ouverture. */
    readonly openSession: CashSessionBrief | null;
    /** Dernière session ouverte le jour métier demandé (AV-201). */
    readonly sessionOfDay: CashSessionBrief | null;
  }[];
  /** Sessions closes à valider (`PENDING_VALIDATION`), tous jours confondus. */
  readonly pendingValidationCount: number;
  /** Ajustements à valider d'une session déjà validée (`OWN_APPROVAL`, `PENDING`). */
  readonly pendingAdjustmentsCount: number;
}

/**
 * Sessions de caisse des comptes donnés (caisses de PDV : AV-165) pour le jour métier `day`. Un tableau
 * vide ne lit rien.
 */
export async function cashSessionsOverview(
  executor: Executor,
  input: { readonly accountIds: readonly string[]; readonly day: string },
): Promise<CashSessionsOverview> {
  if (input.accountIds.length === 0) {
    return { accounts: [], pendingValidationCount: 0, pendingAdjustmentsCount: 0 };
  }
  const accountIds = input.accountIds.map((id) => toBin(id));
  const accounts = await executor
    .selectFrom('finance_cash_accounts')
    .select(['id', 'site_id'])
    .where('id', 'in', accountIds)
    .execute();
  const sessions = await executor
    .selectFrom('finance_cash_sessions as s')
    .select([
      's.id',
      's.cash_account_id',
      's.status',
      's.opened_at',
      's.opened_by',
      's.closed_at',
      's.opening_variance_xaf',
      's.closing_counted_xaf',
      's.closing_expected_xaf',
      's.variance_xaf',
      's.force_closed',
      sql<string>`DATE_FORMAT(s.business_date, '%Y-%m-%d')`.as('business_day'),
      sql<string | null>`(SELECT SUM(a.delta_xaf) FROM finance_cash_session_adjustments a
        WHERE a.session_id = s.id)`.as('adjustments_xaf'),
    ])
    .where('s.cash_account_id', 'in', accountIds)
    .where((eb) =>
      eb.or([eb('s.status', '=', 'OPEN'), eb(sql`s.business_date`, '=', sql<Date>`${input.day}`)]),
    )
    .orderBy('s.opened_at', 'desc')
    .execute();
  const briefOf = (row: (typeof sessions)[number]): CashSessionBrief => {
    const variance = row.variance_xaf === null ? null : Number(row.variance_xaf);
    const current = variance === null ? null : variance + Number(row.adjustments_xaf ?? 0);
    return {
      id: fromBin(row.id),
      status: row.status,
      businessDate: row.business_day,
      openedAt: row.opened_at,
      openedBy: fromBin(row.opened_by),
      closedAt: row.closed_at,
      openingVarianceXaf: Number(row.opening_variance_xaf),
      closingCountedXaf: row.closing_counted_xaf === null ? null : Number(row.closing_counted_xaf),
      closingExpectedXaf:
        row.closing_expected_xaf === null ? null : Number(row.closing_expected_xaf),
      varianceXaf: variance,
      currentVarianceXaf: current,
      currentExpectedXaf:
        current === null || row.closing_counted_xaf === null
          ? null
          : Number(row.closing_counted_xaf) - current,
      forceClosed: Boolean(row.force_closed),
    };
  };
  const pending = await executor
    .selectFrom('finance_cash_sessions')
    .select(sql<string>`COUNT(*)`.as('count'))
    .where('cash_account_id', 'in', accountIds)
    .where('status', '=', 'PENDING_VALIDATION')
    .executeTakeFirstOrThrow();
  const adjustments = await executor
    .selectFrom('finance_cash_session_adjustments as a')
    .innerJoin('finance_cash_sessions as s', 's.id', 'a.session_id')
    .select(sql<string>`COUNT(*)`.as('count'))
    .where('s.cash_account_id', 'in', accountIds)
    .where('a.treatment', '=', 'OWN_APPROVAL')
    .where('a.status', '=', 'PENDING')
    .executeTakeFirstOrThrow();
  return {
    accounts: accounts.map((account) => {
      const own = sessions.filter((row) => row.cash_account_id.equals(account.id));
      const open = own.find((row) => row.status === 'OPEN');
      const ofDay = own.find((row) => row.business_day === input.day);
      return {
        cashAccountId: fromBin(account.id),
        siteId: fromBinOrNull(account.site_id),
        openSession: open === undefined ? null : briefOf(open),
        sessionOfDay: ofDay === undefined ? null : briefOf(ofDay),
      };
    }),
    pendingValidationCount: Number(pending.count),
    pendingAdjustmentsCount: Number(adjustments.count),
  };
}

export interface PendingCashTransfers {
  /** Remises envoyées, pas encore reçues (`SENT`) : nombre, montant, retard (`cashTransfersInTransit`). */
  readonly inTransit: {
    readonly count: number;
    readonly totalXaf: number;
    readonly oldestSentAt: Date | null;
    readonly unreceivedHours: number;
    readonly overdueCount: number;
    readonly overdueXaf: number;
  };
  /** Remises reçues avec un écart en attente de décision de la Finance (`DISCREPANCY_PENDING`). */
  readonly discrepancyPending: {
    readonly count: number;
    readonly sentXaf: number;
    readonly receivedXaf: number;
  };
  /** Remises en attente (plan P5-19) : en transit + en écart. */
  readonly pendingCount: number;
}

/**
 * Remises de fonds en attente touchant les comptes donnés (source **ou** destinataire). Un tableau vide
 * ne lit rien ; `unreceivedHours` absent : paramètre `finance.cash_transfer_unreceived_hours` à `now`.
 */
export async function pendingCashTransfers(
  executor: Executor,
  input: {
    readonly accountIds: readonly string[];
    readonly now: Date;
    readonly unreceivedHours?: number;
  },
): Promise<PendingCashTransfers> {
  const inTransit = await cashTransfersInTransit(executor, {
    now: input.now,
    accountIds: input.accountIds,
    ...(input.unreceivedHours !== undefined ? { unreceivedHours: input.unreceivedHours } : {}),
  });
  const accountIds = input.accountIds.map((id) => toBin(id));
  const discrepancy =
    accountIds.length === 0
      ? { count: '0', sent: '0', received: '0' }
      : await executor
          .selectFrom('finance_cash_transfers')
          .select([
            sql<string>`COUNT(*)`.as('count'),
            sql<string>`COALESCE(SUM(amount_sent_xaf), 0)`.as('sent'),
            sql<string>`COALESCE(SUM(amount_received_xaf), 0)`.as('received'),
          ])
          .where('status', '=', 'DISCREPANCY_PENDING')
          .where((eb) =>
            eb.or([eb('from_account_id', 'in', accountIds), eb('to_account_id', 'in', accountIds)]),
          )
          .executeTakeFirstOrThrow();
  const discrepancyCount = Number(discrepancy.count);
  return {
    inTransit: {
      count: inTransit.count,
      totalXaf: inTransit.totalXaf,
      oldestSentAt: inTransit.oldestSentAt,
      unreceivedHours: inTransit.unreceivedHours,
      overdueCount: inTransit.overdueCount,
      overdueXaf: inTransit.overdueXaf,
    },
    discrepancyPending: {
      count: discrepancyCount,
      sentXaf: Number(discrepancy.sent),
      receivedXaf: Number(discrepancy.received),
    },
    pendingCount: inTransit.count + discrepancyCount,
  };
}

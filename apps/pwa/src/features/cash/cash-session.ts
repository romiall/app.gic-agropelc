/**
 * Caisse du point de vente sur l'appareil (ECR-DIS-02 ; UC-DIS-02 et 03 ; BR-DIS-005 à 007 ; ADR-032 ;
 * SM-CASH-SESSION). Logique pure : sessions vues par l'appareil (jeu `cash` et saisies en attente),
 * attendu indicatif et décision d'ouverture, sans entrée-sortie.
 *
 * - **Sessions** : le jeu `cash` ne sert que les sessions `OPEN` et `PENDING_VALIDATION` du site ;
 *   une ouverture ou une clôture saisie sur l'appareil compte jusqu'au tirage qui l'inclut (ADR-037
 *   §3). Une ouverture fusionnée par le serveur (hors ligne, AV-154) désigne la session retenue
 *   (`server_refs.cashSessionId`) : la clôture saisie sur l'agrégat de l'appareil la vise, le serveur
 *   lit l'alias.
 * - **Attendu indicatif** (D05 §12) : le serveur seul calcule l'attendu et l'écart (BR-DIS-007).
 *   L'appareil en donne une estimation : le solde du compte servi par le jeu `cash` (republié à chaque
 *   mouvement ; après l'ouverture, il vaut le fonds compté plus les mouvements de la fenêtre, ADR-032
 *   §4), plus les encaissements en espèces et remises de l'appareil encore en attente. Une tablette
 *   d'un PDV partagé ne voit pas les ventes des autres avant leur synchronisation ; les
 *   remboursements d'annulation en attente ne sont pas estimés (montant connu du serveur seul).
 */
import {
  normalizedSessionsPerDay,
  planCashSessionOpen,
  type CashSessionOpenPlan,
  type ExistingCashSession,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { CASH_METHOD_ACCOUNT_TYPE } from '../sales/payment.js';
import { isWaiting, stillInFlight } from '../sales/pending.js';
import type {
  CashAccountData,
  CashSessionData,
  LocationData,
  PaymentMethodData,
} from '../sales/types.js';

/**
 * AV-304 (défaut) : comptage à l'aveugle. L'attendu (indicatif, puis celui du serveur) ne s'affiche
 * qu'après l'enregistrement du comptage, pour que le vendeur compte ce qu'il a, pas ce qu'on attend
 * de lui. `false` : l'attendu indicatif s'affiche sur le formulaire, avant la saisie.
 */
export const CASH_COUNT_BLIND: boolean = true;

/** Longueur maximale du commentaire d'une ouverture ou d'une clôture (`cashSessionOpenPayloadSchema`). */
export const MAX_CASH_COMMENT = 500;

/** Session de caisse telle que l'appareil la voit. */
export interface CashSessionView {
  /** Session du serveur, ou agrégat de l'ouverture saisie sur l'appareil. */
  readonly id: string;
  readonly cashAccountId: string;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly openingCountedXaf: number;
  /**
   * `OPEN` : ouverte ; `CLOSING` : clôture saisie sur l'appareil, sans réponse ; `CLOSED` : close
   * (acceptée en attente du tirage, ou à valider par la Finance).
   */
  readonly state: 'OPEN' | 'CLOSING' | 'CLOSED';
  /** Session servie par le jeu `cash` (le solde du compte inclut alors son ouverture). */
  readonly known: boolean;
  /** Ouverture saisie sur l'appareil encore sans réponse (dépendance de la clôture). */
  readonly openCommandId: string | null;
  readonly closeCommandId: string | null;
  readonly closedAt: string | null;
  readonly closingCountedXaf: number | null;
}

interface OpenPayload {
  readonly cashAccountId?: string;
  readonly countedXaf?: number;
}

/** Sessions d'une caisse vues par l'appareil, la plus ancienne d'abord. */
export function deviceCashSessions(input: {
  readonly cashAccountId: string;
  readonly sessions: readonly CashSessionData[];
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
}): CashSessionView[] {
  const views = new Map<string, CashSessionView>();
  for (const session of input.sessions) {
    if (session.cash_account_id !== input.cashAccountId) continue;
    views.set(session.id, {
      id: session.id,
      cashAccountId: session.cash_account_id,
      openedAt: session.opened_at,
      openedBy: session.opened_by,
      openingCountedXaf: session.opening_counted_xaf,
      state: session.status === 'OPEN' ? 'OPEN' : 'CLOSED',
      known: true,
      openCommandId: null,
      closeCommandId: null,
      closedAt: session.closed_at,
      closingCountedXaf: session.closing_counted_xaf,
    });
  }
  // Agrégat de l'appareil → session retenue par le serveur (ouverture fusionnée, AV-154).
  const alias = new Map<string, string>();
  const inFlight = input.outbox
    .filter(
      (command) =>
        command.command_type.startsWith('finance.cash_session.') &&
        stillInFlight(command, input.cashPulledAt),
    )
    .sort((a, b) => a.device_seq - b.device_seq);
  for (const command of inFlight) {
    if (command.command_type === 'finance.cash_session.open') {
      const payload = command.payload as OpenPayload;
      if (payload.cashAccountId !== input.cashAccountId) continue;
      const retained = command.server_refs?.cashSessionId;
      if (retained && retained !== command.aggregate_id) alias.set(command.aggregate_id, retained);
      if (views.has(command.aggregate_id) || (retained !== undefined && views.has(retained))) {
        continue;
      }
      views.set(command.aggregate_id, {
        id: command.aggregate_id,
        cashAccountId: input.cashAccountId,
        openedAt: command.occurred_at,
        openedBy: command.author_user_id,
        openingCountedXaf: payload.countedXaf ?? 0,
        state: 'OPEN',
        known: false,
        openCommandId: isWaiting(command) ? command.command_id : null,
        closeCommandId: null,
        closedAt: null,
        closingCountedXaf: null,
      });
    } else if (command.command_type === 'finance.cash_session.close') {
      const view =
        views.get(alias.get(command.aggregate_id) ?? command.aggregate_id) ??
        views.get(command.aggregate_id);
      if (!view || view.state === 'CLOSED') continue;
      views.set(view.id, {
        ...view,
        state: isWaiting(command) ? 'CLOSING' : 'CLOSED',
        closeCommandId: command.command_id,
        closedAt: command.occurred_at,
        closingCountedXaf: (command.payload as { countedXaf?: number }).countedXaf ?? null,
      });
    }
  }
  return [...views.values()].sort(
    (a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id),
  );
}

/** Session ouverte de la caisse (la plus ancienne si l'appareil en voit plusieurs), sinon `undefined`. */
export function openSession(sessions: readonly CashSessionView[]): CashSessionView | undefined {
  return sessions.find((session) => session.state === 'OPEN');
}

/** Caisses de point de vente actives vues par l'appareil (une par PDV du périmètre), par nom. */
export function posCashAccounts(accounts: readonly CashAccountData[]): CashAccountData[] {
  return accounts
    .filter(
      (account) =>
        account.account_type === 'CAISSE_PDV' && account.status === 'ACTIVE' && account.site_id,
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

interface PaymentLike {
  readonly methodCode?: string;
  readonly amountXaf?: number;
  readonly cashAccountId?: string;
}

/**
 * Mouvements de la caisse saisis sur l'appareil et pas encore dans le solde servi (en attente, ou
 * acceptés avant le tirage du jeu `cash` qui les inclut), datés à partir de `from` : encaissements en
 * espèces au point de vente (vente, acompte d'une commande, encaissement hors vente) en entrée,
 * remises de fonds en sortie. Un encaissement en espèces au PDV crédite la caisse du site (DÉDUIT de
 * `cashAccountFor` : emplacement de type `POS`, ou site du PDV pour un encaissement hors vente).
 */
export function pendingCashMovements(input: {
  readonly account: Pick<CashAccountData, 'id' | 'site_id'>;
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly locations: readonly Pick<LocationData, 'id' | 'site_id' | 'location_type'>[];
  readonly paymentMethods: readonly Pick<PaymentMethodData, 'code' | 'default_account_type'>[];
  readonly from?: string;
}): { readonly netXaf: number; readonly count: number } {
  const cashMethods = new Set(
    input.paymentMethods
      .filter((method) => method.default_account_type === CASH_METHOD_ACCOUNT_TYPE)
      .map((method) => method.code),
  );
  const locations = new Map(input.locations.map((location) => [location.id, location]));
  const atPos = (locationId: string | undefined) => {
    const location = locationId ? locations.get(locationId) : undefined;
    return location?.location_type === 'POS' && location.site_id === input.account.site_id;
  };
  const cashIn = (payments: readonly PaymentLike[] | undefined) =>
    (payments ?? [])
      .filter(
        (payment) =>
          payment.methodCode !== undefined &&
          cashMethods.has(payment.methodCode) &&
          (payment.cashAccountId === undefined || payment.cashAccountId === input.account.id),
      )
      .reduce((sum, payment) => sum + (payment.amountXaf ?? 0), 0);
  let netXaf = 0;
  let count = 0;
  for (const command of input.outbox) {
    if (!stillInFlight(command, input.cashPulledAt)) continue;
    if (input.from !== undefined && command.occurred_at < input.from) continue;
    const payload = command.payload as Record<string, unknown>;
    let amount = 0;
    switch (command.command_type) {
      case 'sales.sale.record':
        if (atPos(payload.fromLocationId as string | undefined)) {
          amount = cashIn(payload.payments as PaymentLike[] | undefined);
        }
        break;
      case 'sales.order.place':
        if (atPos(payload.fulfilmentLocationId as string | undefined)) {
          amount = cashIn(payload.advancePayments as PaymentLike[] | undefined);
        }
        break;
      case 'sales.payment.record':
        if (payload.siteId === input.account.site_id) {
          amount = cashIn([payload as PaymentLike]);
        }
        break;
      case 'finance.cash_transfer.send':
        if (payload.fromAccountId === input.account.id) {
          amount = -((payload.amountXaf as number | undefined) ?? 0);
        }
        break;
      default:
        break;
    }
    if (amount !== 0) {
      netXaf += amount;
      count += 1;
    }
  }
  return { netXaf, count };
}

/**
 * Attendu indicatif de la session ouverte (D05 §12) : solde servi du compte si la session est connue
 * du serveur (il inclut l'ouverture), sinon le fonds compté à l'ouverture ; plus les mouvements de
 * l'appareil en attente datés de la session. `null` si le solde du compte n'est pas servi.
 */
export function indicativeSessionExpectedXaf(input: {
  readonly session: CashSessionView;
  readonly account: CashAccountData;
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly locations: readonly Pick<LocationData, 'id' | 'site_id' | 'location_type'>[];
  readonly paymentMethods: readonly Pick<PaymentMethodData, 'code' | 'default_account_type'>[];
}): { readonly expectedXaf: number; readonly pendingCount: number } | null {
  const base = input.session.known ? input.account.balance_xaf : input.session.openingCountedXaf;
  if (base === undefined) return null;
  const pending = pendingCashMovements({ ...input, from: input.session.openedAt });
  return { expectedXaf: base + pending.netXaf, pendingCount: pending.count };
}

/**
 * Solde indicatif de la caisse avant une ouverture : solde servi, plus tous les mouvements de
 * l'appareil encore en attente. `null` si le solde du compte n'est pas servi.
 */
export function indicativeBalanceXaf(input: {
  readonly account: CashAccountData;
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly locations: readonly Pick<LocationData, 'id' | 'site_id' | 'location_type'>[];
  readonly paymentMethods: readonly Pick<PaymentMethodData, 'code' | 'default_account_type'>[];
}): { readonly expectedXaf: number; readonly pendingCount: number } | null {
  if (input.account.balance_xaf === undefined) return null;
  const pending = pendingCashMovements(input);
  return { expectedXaf: input.account.balance_xaf + pending.netXaf, pendingCount: pending.count };
}

/**
 * Décision d'ouverture sur l'appareil, par la règle partagée avec le serveur (`planCashSessionOpen`,
 * ADR-021) appliquée aux sessions qu'il voit : en ligne, un refus annoncé ; hors ligne, une fusion
 * annoncée (le serveur rattache le comptage à la session retenue, AV-154). Le serveur décide sur toutes
 * les sessions (le jeu `cash` ne sert pas les sessions validées).
 */
export function cashOpenPlan(input: {
  readonly sessions: readonly CashSessionView[];
  readonly openedAt: Date;
  readonly online: boolean;
  readonly maxSessionsPerDay: unknown;
}): CashSessionOpenPlan {
  const existing: ExistingCashSession[] = input.sessions.map((session) => ({
    id: session.id,
    openedAt: new Date(session.openedAt),
    closedAt: session.closedAt ? new Date(session.closedAt) : null,
    status: session.state === 'OPEN' ? 'OPEN' : 'PENDING_VALIDATION',
  }));
  return planCashSessionOpen({
    openedAt: input.openedAt,
    capturedOffline: !input.online,
    sessions: existing,
    maxSessionsPerDay: normalizedSessionsPerDay(Number(input.maxSessionsPerDay ?? 1)),
  });
}

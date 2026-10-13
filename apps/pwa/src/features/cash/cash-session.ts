/**
 * Caisse du point de vente sur l'appareil (ECR-DIS-02 ; UC-DIS-02 et 03 ; BR-DIS-005 à 007 ; ADR-032 ;
 * SM-CASH-SESSION). Logique pure : sessions vues par l'appareil (jeu `cash` et saisies de l'outbox),
 * attendu indicatif, décision d'ouverture et session exigée à l'encaissement, sans entrée-sortie.
 *
 * - **Sessions** : le jeu `cash` ne sert que les sessions `OPEN` et `PENDING_VALIDATION` du site ;
 *   une ouverture ou une clôture saisie sur l'appareil compte jusqu'au tirage qui l'inclut (ADR-037
 *   §3). Une ouverture fusionnée par le serveur (AV-154) désigne la session retenue
 *   (`server_refs.cashSessionId`) : une clôture saisie sur l'agrégat de l'appareil la vise (le serveur
 *   lit l'alias), même après le tirage de l'ouverture. Une ouverture que le serveur rattache, ou
 *   rattachera, à une session existante n'ouvre aucune caisse sur l'appareil. L'ouverture d'un autre
 *   utilisateur de la tablette, pas encore envoyée, est inconnue du serveur jusqu'à la reconnexion de
 *   son auteur (ADR-052) : elle ne compte ni comme caisse ouverte, ni dans la décision d'ouverture.
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
import { isAccepted, isWaiting, stillInFlight } from '../sales/pending.js';
import type {
  CashAccountData,
  CashTransferData,
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

/**
 * AV-305 (défaut) : encaissement en espèces au PDV sans caisse ouverte vue par l'appareil. L'écran
 * propose d'abord « Ouvrir la caisse » (BR-DIS-005) ; en ligne, l'encaissement est bloqué (le serveur
 * le refuserait, `CASH_SESSION_REQUIRED`) ; hors ligne, `WARN` : enregistré, le serveur l'applique et
 * le signale à la Finance (`CASH_SESSION_MISSING`, AV-184, BR-SYN-007). `BLOCK` : bloqué hors ligne
 * aussi.
 */
export const OFFLINE_CASH_WITHOUT_SESSION: 'WARN' | 'BLOCK' = 'WARN';

/** Longueur maximale du commentaire d'une ouverture ou d'une clôture (`cashSessionOpenPayloadSchema`). */
export const MAX_CASH_COMMENT = 500;

/** Session de caisse telle que l'appareil la voit. */
export interface CashSessionView {
  /** Session du serveur, ou agrégat de l'ouverture saisie sur l'appareil. */
  readonly id: string;
  readonly cashAccountId: string;
  /** Heure d'ouverture retenue (celle du serveur dès sa réponse : décalage d'AV-168). */
  readonly openedAt: string;
  readonly openedBy: string;
  readonly openingCountedXaf: number;
  /**
   * `OPEN` : ouverte ; `CLOSING` : clôture saisie sur l'appareil, sans réponse ; `CLOSED` : close
   * (acceptée en attente du tirage, ou servie à valider).
   */
  readonly state: 'OPEN' | 'CLOSING' | 'CLOSED';
  /** Session servie par le jeu `cash` (le solde du compte inclut alors son ouverture). */
  readonly known: boolean;
  /** Ouverture saisie sur l'appareil encore sans réponse (dépendance de la clôture). */
  readonly openCommandId: string | null;
  readonly closeCommandId: string | null;
  /** Clôture saisie sur l'appareil et pas encore relue (en attente, ou acceptée avant le tirage). */
  readonly closeOnDevice: boolean;
  /** Auteur de la clôture saisie sur l'appareil. */
  readonly closeAuthorId: string | null;
  readonly closedAt: string | null;
  readonly closingCountedXaf: number | null;
  /** Statut après clôture : servi par le jeu, ou renvoyé par le serveur (`server_refs.status`). */
  readonly closedStatus: string | null;
}

/** Ouverture de l'utilisateur rattachée par le serveur, ou qu'il rattachera, à une session existante. */
export interface AttachedOpening {
  readonly commandId: string;
  readonly openedAt: string;
  /** `MERGED` : réponse du serveur ; `WILL_MERGE` : prévu par la règle partagée (hors ligne). */
  readonly reason: 'MERGED' | 'WILL_MERGE';
}

/** Caisse vue par l'appareil pour un utilisateur. */
export interface DeviceCash {
  /** Sessions connues ou saisies par l'utilisateur, la plus ancienne d'abord. */
  readonly sessions: readonly CashSessionView[];
  /** Ouvertures d'autres utilisateurs de la tablette, en attente de la reconnexion de leur auteur. */
  readonly foreignOpenings: readonly CashSessionView[];
  /** Ouvertures de l'utilisateur rattachées à une session existante : aucune caisse ouverte. */
  readonly attached: readonly AttachedOpening[];
  /**
   * Sessions ouvertes par l'appareil puis sorties du jeu `cash` (validées d'office) : le serveur les
   * compte encore dans la limite du jour (AV-154).
   */
  readonly leftDataset: readonly ExistingCashSession[];
}

interface OpenPayload {
  readonly cashAccountId?: string;
  readonly countedXaf?: number;
}

const bySeq = (a: OutboxCommand, b: OutboxCommand) => a.device_seq - b.device_seq;

/**
 * Sessions d'une caisse vues par l'appareil pour l'utilisateur `userId`. `maxSessionsPerDay`
 * (`finance.cash_sessions_per_day_max` du site) sert à prévoir le rattachement d'une ouverture hors
 * ligne encore sans réponse, par la règle partagée avec le serveur (`planCashSessionOpen`).
 */
export function deviceCash(input: {
  readonly cashAccountId: string;
  readonly sessions: readonly CashSessionData[];
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly userId: string;
  readonly maxSessionsPerDay?: unknown;
}): DeviceCash {
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
      closeOnDevice: false,
      closeAuthorId: null,
      closedAt: session.closed_at,
      closingCountedXaf: session.closing_counted_xaf,
      closedStatus: session.status === 'OPEN' ? null : session.status,
    });
  }
  const accountOpens = input.outbox
    .filter(
      (command) =>
        command.command_type === 'finance.cash_session.open' &&
        (command.payload as OpenPayload).cashAccountId === input.cashAccountId,
    )
    .sort(bySeq);
  const accountCloses = input.outbox
    .filter((command) => command.command_type === 'finance.cash_session.close')
    .sort(bySeq);
  // Agrégat de l'appareil → session retenue par le serveur, quel que soit le tirage (une clôture en
  // attente sur l'agrégat d'une ouverture fusionnée la vise encore).
  const alias = new Map<string, string>();
  for (const command of accountOpens) {
    const retained = command.server_refs?.cashSessionId;
    if (isAccepted(command) && retained && retained !== command.aggregate_id) {
      alias.set(command.aggregate_id, retained);
    }
  }
  const foreign = new Map<string, CashSessionView>();
  const attached: AttachedOpening[] = [];
  const attachedAggregates = new Set<string>();
  const leftDataset: ExistingCashSession[] = [];

  for (const command of accountOpens) {
    const refs = command.server_refs ?? {};
    const retained = refs.cashSessionId;
    const inFlight = stillInFlight(command, input.cashPulledAt);
    if (!inFlight) {
      // Session créée par l'appareil, sortie du jeu depuis (validée) : comptée dans la limite du jour.
      if (isAccepted(command) && !refs.mergedInto && !views.has(retained ?? command.aggregate_id)) {
        const close = accountCloses.find(
          (candidate) =>
            isAccepted(candidate) &&
            (alias.get(candidate.aggregate_id) ?? candidate.aggregate_id) ===
              (retained ?? command.aggregate_id),
        );
        if (close) {
          leftDataset.push({
            id: retained ?? command.aggregate_id,
            openedAt: new Date(refs.openedAt ?? command.occurred_at),
            closedAt: new Date(close.occurred_at),
            status: 'VALIDATED',
          });
        }
      }
      continue;
    }
    if (views.has(command.aggregate_id) || (retained !== undefined && views.has(retained))) {
      continue;
    }
    const view: CashSessionView = {
      id: command.aggregate_id,
      cashAccountId: input.cashAccountId,
      openedAt: refs.openedAt ?? command.occurred_at,
      openedBy: command.author_user_id,
      openingCountedXaf: (command.payload as OpenPayload).countedXaf ?? 0,
      state: 'OPEN',
      known: false,
      openCommandId: isWaiting(command) ? command.command_id : null,
      closeCommandId: null,
      closeOnDevice: false,
      closeAuthorId: null,
      closedAt: null,
      closingCountedXaf: null,
      closedStatus: null,
    };
    if (isWaiting(command) && command.author_user_id !== input.userId) {
      // Inconnue du serveur jusqu'à la reconnexion de son auteur (ADR-052).
      foreign.set(command.aggregate_id, view);
      continue;
    }
    if (isAccepted(command) && refs.mergedInto) {
      // Rattachée à une session existante absente du jeu : aucune caisse ouverte (S-48 : le statut de
      // la session retenue n'est pas renvoyé).
      attached.push({ commandId: command.command_id, openedAt: view.openedAt, reason: 'MERGED' });
      attachedAggregates.add(command.aggregate_id);
      continue;
    }
    if (isWaiting(command)) {
      const plan = planCashSessionOpen({
        openedAt: new Date(command.occurred_at),
        capturedOffline: command.captured_offline,
        sessions: [...planSessions(views, input.userId), ...leftDataset],
        maxSessionsPerDay: normalizedSessionsPerDay(Number(input.maxSessionsPerDay ?? 1)),
      });
      if (plan.kind === 'MERGE') {
        attached.push({
          commandId: command.command_id,
          openedAt: command.occurred_at,
          reason: 'WILL_MERGE',
        });
        attachedAggregates.add(command.aggregate_id);
        continue;
      }
      if (plan.kind === 'REJECT') continue;
      views.set(command.aggregate_id, { ...view, openedAt: plan.openedAt.toISOString() });
      continue;
    }
    views.set(command.aggregate_id, view);
  }

  for (const command of accountCloses) {
    if (!stillInFlight(command, input.cashPulledAt)) continue;
    if (attachedAggregates.has(command.aggregate_id)) continue;
    const target = alias.get(command.aggregate_id) ?? command.aggregate_id;
    const pool = views.has(target) ? views : foreign.has(target) ? foreign : null;
    const view = pool?.get(target);
    if (!pool || !view || view.state === 'CLOSED') continue;
    pool.set(target, {
      ...view,
      state: isWaiting(command) ? 'CLOSING' : 'CLOSED',
      closeCommandId: command.command_id,
      closeOnDevice: true,
      closeAuthorId: command.author_user_id,
      closedAt: command.occurred_at,
      closingCountedXaf: (command.payload as { countedXaf?: number }).countedXaf ?? null,
      closedStatus: command.server_refs?.status ?? null,
    });
  }

  const byOpening = (a: CashSessionView, b: CashSessionView) =>
    a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id);
  return {
    sessions: [...views.values()].sort(byOpening),
    foreignOpenings: [...foreign.values()].sort(byOpening),
    attached,
    leftDataset,
  };
}

/**
 * Sessions telles que le serveur les voit, pour la règle d'ouverture : une clôture d'un autre
 * utilisateur pas encore envoyée laisse la session ouverte au serveur.
 */
function planSessions(
  views: ReadonlyMap<string, CashSessionView>,
  userId: string,
): ExistingCashSession[] {
  return [...views.values()].map((session) => {
    const open =
      session.state === 'OPEN' || (session.state === 'CLOSING' && session.closeAuthorId !== userId);
    return {
      id: session.id,
      openedAt: new Date(session.openedAt),
      closedAt: open || !session.closedAt ? null : new Date(session.closedAt),
      status: open || !session.closedAt ? 'OPEN' : 'PENDING_VALIDATION',
    };
  });
}

/** Session ouverte de la caisse (la plus ancienne si l'appareil en voit plusieurs), sinon `undefined`. */
export function openSession(cash: Pick<DeviceCash, 'sessions'>): CashSessionView | undefined {
  return cash.sessions.find((session) => session.state === 'OPEN');
}

/**
 * Clôture d'un autre utilisateur de la tablette pas encore envoyée : la session reste ouverte au
 * serveur jusqu'à la reconnexion de son auteur (ADR-052).
 */
export function foreignClose(
  cash: Pick<DeviceCash, 'sessions'>,
  userId: string,
): CashSessionView | undefined {
  return cash.sessions.find(
    (session) =>
      session.state === 'CLOSING' &&
      session.closeAuthorId !== null &&
      session.closeAuthorId !== userId,
  );
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
 * remises de fonds envoyées en sortie ; avec les remises connues (`transfers`), l'annulation d'une
 * remise en entrée sur sa source (fait nouveau daté de l'annulation, ADR-032 §2) et la réception en
 * entrée sur la destination (montant reçu, BR-FIN-013). Un encaissement en espèces au PDV crédite la
 * caisse du site (DÉDUIT de `cashAccountFor` : emplacement de type `POS`, ou site du PDV pour un
 * encaissement hors vente) ; ailleurs, il crédite la caisse personnelle de celui qui encaisse : pour
 * une caisse personnelle, les espèces encaissées par son détenteur hors d'un emplacement `POS` (vente,
 * acompte) ou hors d'un site point de vente (encaissement hors vente, site absent compris) entrent.
 */
export function pendingCashMovements(input: {
  readonly account: Pick<CashAccountData, 'id' | 'site_id'> &
    Partial<Pick<CashAccountData, 'account_type' | 'holder_user_id'>>;
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly locations: readonly Pick<LocationData, 'id' | 'site_id' | 'location_type'>[];
  readonly paymentMethods: readonly Pick<PaymentMethodData, 'code' | 'default_account_type'>[];
  readonly from?: string | null;
  /** Type de chaque site connu (encaissement hors vente d'une caisse personnelle). */
  readonly siteTypes?: ReadonlyMap<string, string>;
  /** Remises servies par le jeu `cash` (source et destination d'une annulation ou d'une réception). */
  readonly transfers?: readonly Pick<
    CashTransferData,
    'id' | 'from_account_id' | 'to_account_id' | 'amount_sent_xaf'
  >[];
}): { readonly netXaf: number; readonly count: number } {
  const cashMethods = new Set(
    input.paymentMethods
      .filter((method) => method.default_account_type === CASH_METHOD_ACCOUNT_TYPE)
      .map((method) => method.code),
  );
  const locations = new Map(input.locations.map((location) => [location.id, location]));
  // Caisse personnelle : les espèces que son détenteur encaisse hors point de vente.
  const holder =
    input.account.account_type === 'CAISSE_UTILISATEUR'
      ? (input.account.holder_user_id ?? null)
      : null;
  const atPos = (locationId: string | undefined) => {
    const location = locationId ? locations.get(locationId) : undefined;
    return location?.location_type === 'POS' && location.site_id === input.account.site_id;
  };
  const outsidePos = (command: OutboxCommand, locationId: string | undefined) =>
    holder !== null &&
    command.author_user_id === holder &&
    (locationId ? locations.get(locationId)?.location_type : undefined) !== 'POS';
  const outsidePosSite = (command: OutboxCommand, siteId: string | undefined) =>
    holder !== null &&
    command.author_user_id === holder &&
    (siteId ? input.siteTypes?.get(siteId) : undefined) !== 'POINT_DE_VENTE';
  const cashIn = (payments: readonly PaymentLike[] | undefined) =>
    (payments ?? [])
      .filter(
        (payment) =>
          payment.methodCode !== undefined &&
          cashMethods.has(payment.methodCode) &&
          (payment.cashAccountId === undefined || payment.cashAccountId === input.account.id),
      )
      .reduce((sum, payment) => sum + (payment.amountXaf ?? 0), 0);
  // Remise visée par une annulation ou une réception : servie, sinon envoyée par l'appareil.
  const transferOf = (transferId: string) => {
    const served = input.transfers?.find((transfer) => transfer.id === transferId);
    if (served) {
      return {
        fromAccountId: served.from_account_id,
        toAccountId: served.to_account_id,
        amountXaf: served.amount_sent_xaf,
      };
    }
    const send = input.outbox.find(
      (command) =>
        command.command_type === 'finance.cash_transfer.send' &&
        command.aggregate_id === transferId &&
        command.status !== 'REJECTED',
    );
    const payload = send?.payload as
      | {
          readonly fromAccountId?: string;
          readonly toAccountId?: string;
          readonly amountXaf?: number;
        }
      | undefined;
    return payload?.fromAccountId && payload.toAccountId && payload.amountXaf
      ? {
          fromAccountId: payload.fromAccountId,
          toAccountId: payload.toAccountId,
          amountXaf: payload.amountXaf,
        }
      : undefined;
  };
  let netXaf = 0;
  let count = 0;
  for (const command of input.outbox) {
    if (!stillInFlight(command, input.cashPulledAt)) continue;
    if (input.from && command.occurred_at < input.from) continue;
    const payload = command.payload as Record<string, unknown>;
    let amount = 0;
    switch (command.command_type) {
      case 'sales.sale.record': {
        const locationId = payload.fromLocationId as string | undefined;
        if (atPos(locationId) || outsidePos(command, locationId)) {
          amount = cashIn(payload.payments as PaymentLike[] | undefined);
        }
        break;
      }
      case 'sales.order.place': {
        const locationId = payload.fulfilmentLocationId as string | undefined;
        if (atPos(locationId) || outsidePos(command, locationId)) {
          amount = cashIn(payload.advancePayments as PaymentLike[] | undefined);
        }
        break;
      }
      case 'sales.payment.record': {
        const siteId = payload.siteId as string | undefined;
        if (
          (input.account.site_id !== null && siteId === input.account.site_id) ||
          outsidePosSite(command, siteId)
        ) {
          amount = cashIn([payload as PaymentLike]);
        }
        break;
      }
      case 'finance.cash_transfer.send':
        if (payload.fromAccountId === input.account.id) {
          amount = -((payload.amountXaf as number | undefined) ?? 0);
        }
        break;
      case 'finance.cash_transfer.cancel':
        if (
          input.transfers &&
          transferOf(command.aggregate_id)?.fromAccountId === input.account.id
        ) {
          amount = transferOf(command.aggregate_id)?.amountXaf ?? 0;
        }
        break;
      case 'finance.cash_transfer.receive':
        if (input.transfers && transferOf(command.aggregate_id)?.toAccountId === input.account.id) {
          amount = (payload.receivedXaf as number | undefined) ?? 0;
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
  readonly siteTypes?: ReadonlyMap<string, string>;
  readonly transfers?: readonly Pick<
    CashTransferData,
    'id' | 'from_account_id' | 'to_account_id' | 'amount_sent_xaf'
  >[];
}): { readonly expectedXaf: number; readonly pendingCount: number } | null {
  const base = input.session.known ? input.account.balance_xaf : input.session.openingCountedXaf;
  if (base === undefined) return null;
  const pending = pendingCashMovements({ ...input, from: input.session.openedAt });
  return { expectedXaf: base + pending.netXaf, pendingCount: pending.count };
}

/**
 * Solde indicatif de la caisse avant une ouverture. Après une clôture saisie sur l'appareil et pas
 * encore relue, le registre vaudra le compté de cette clôture (son écart y est posé, ADR-032 §4) ;
 * sinon le solde servi. S'y ajoutent les mouvements de l'appareil en attente datés après la dernière
 * clôture (ceux d'une fenêtre close sont neutralisés par sa réévaluation). `null` sans solde connu.
 */
export function indicativeBalanceXaf(input: {
  readonly account: CashAccountData;
  readonly last: CashSessionView | undefined;
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly locations: readonly Pick<LocationData, 'id' | 'site_id' | 'location_type'>[];
  readonly paymentMethods: readonly Pick<PaymentMethodData, 'code' | 'default_account_type'>[];
  readonly siteTypes?: ReadonlyMap<string, string>;
  readonly transfers?: readonly Pick<
    CashTransferData,
    'id' | 'from_account_id' | 'to_account_id' | 'amount_sent_xaf'
  >[];
}): { readonly expectedXaf: number; readonly pendingCount: number } | null {
  const last = input.last && input.last.state !== 'OPEN' ? input.last : undefined;
  const base =
    last?.closeOnDevice && last.closingCountedXaf !== null
      ? last.closingCountedXaf
      : input.account.balance_xaf;
  if (base === undefined) return null;
  const pending = pendingCashMovements({ ...input, from: last?.closedAt ?? null });
  return { expectedXaf: base + pending.netXaf, pendingCount: pending.count };
}

/**
 * Décision d'ouverture sur l'appareil, par la règle partagée avec le serveur (`planCashSessionOpen`,
 * ADR-021) appliquée aux sessions qu'il voit, y compris celles qu'il a ouvertes et qui sont sorties du
 * jeu : en ligne, un refus annoncé ; hors ligne, une fusion annoncée (AV-154). Les sessions validées
 * ouvertes par d'autres appareils ne sont pas servies (S-49) : le serveur décide sur toutes.
 */
export function cashOpenPlan(input: {
  readonly cash: Pick<DeviceCash, 'sessions' | 'leftDataset'>;
  readonly userId: string;
  readonly openedAt: Date;
  readonly online: boolean;
  readonly maxSessionsPerDay: unknown;
}): CashSessionOpenPlan {
  return planCashSessionOpen({
    openedAt: input.openedAt,
    capturedOffline: !input.online,
    sessions: [
      ...planSessions(
        new Map(input.cash.sessions.map((session) => [session.id, session])),
        input.userId,
      ),
      ...input.cash.leftDataset,
    ],
    maxSessionsPerDay: normalizedSessionsPerDay(Number(input.maxSessionsPerDay ?? 1)),
  });
}

/**
 * Session exigée par un encaissement en espèces au PDV (BR-DIS-005). `NONE` : pas au point de vente ;
 * `UNKNOWN` : au point de vente, mais la caisse du PDV n'est pas servie à l'appareil (rôle sans
 * `finance.cash.read` sur le site) : son état n'est pas connu ; `MISSING` : aucune session ouverte vue
 * par l'appareil (l'ouverture d'un autre utilisateur de la tablette, pas encore envoyée, ne compte
 * pas) ; `COVERED` sinon. Une session close par un autre utilisateur, pas encore envoyée, reste
 * ouverte au serveur ; l'ouverture de l'utilisateur part avant l'encaissement, dans l'ordre de la file.
 */
export function cashSessionCoverage(input: {
  readonly atPointOfSale: boolean;
  readonly accounts: readonly CashAccountData[];
  readonly sessions: readonly CashSessionData[];
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
  readonly siteId: string | null | undefined;
  readonly userId: string;
  readonly maxSessionsPerDay?: unknown;
}): CashCoverage {
  if (!input.atPointOfSale || !input.siteId) return 'NONE';
  const account = posCashAccounts(input.accounts).find(
    (candidate) => candidate.site_id === input.siteId,
  );
  if (!account) return 'UNKNOWN';
  const cash = deviceCash({ ...input, cashAccountId: account.id });
  if (openSession(cash) || foreignClose(cash, input.userId)) return 'COVERED';
  return 'MISSING';
}

export type CashCoverage = 'NONE' | 'UNKNOWN' | 'MISSING' | 'COVERED';

/** Encaissement en espèces refusé sur l'appareil faute de caisse ouverte (AV-305). */
export function cashPaymentBlocked(coverage: CashCoverage, online: boolean): boolean {
  return coverage === 'MISSING' && (online || OFFLINE_CASH_WITHOUT_SESSION === 'BLOCK');
}

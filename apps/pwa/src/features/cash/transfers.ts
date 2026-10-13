/**
 * Remises de fonds vues par l'appareil (UC-FIN-07 ; SM-CASH-TRANSFER ; BR-FIN-013 ; ADR-032 §7 ;
 * AV-311). Logique pure : remises servies par le jeu `cash` (envoyées ou en écart ; reçues, closes ou
 * annulées, elles en sortent) et envois de l'appareil pas encore relus ; comptes d'où l'utilisateur
 * remet, destinations admises (`finance.cash_transfer_allowed_pairs`, AV-158), remises qu'il peut
 * recevoir ou annuler ; charges utiles de `finance.cash_transfer.send`, `.receive` et `.cancel`.
 */
import {
  cashTransferPairsFrom,
  isAllowedTransferReceiver,
  isCashTransferPairAllowed,
  type CashTransferPairs,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { isWaiting, stillInFlight } from '../sales/pending.js';
import { settingValue } from '../sales/stock.js';
import type {
  CashAccountData,
  CashTransferData,
  CashTransferTargetData,
  SettingData,
} from '../sales/types.js';

/** Longueurs maximales (`cashTransferSendPayloadSchema`, `cashTransferCancelPayloadSchema`). */
export const MAX_TRANSFER_COMMENT = 500;
export const MAX_CARRIER_NAME = 120;
export const MAX_CANCEL_REASON = 500;

/** Opération sur une remise saisie sur l'appareil : en attente d'envoi, ou acceptée pas encore relue. */
export type TransferStep = 'WAITING' | 'SENT' | null;

export interface TransferView {
  readonly id: string;
  /** Numéro `RMF-…` ; `null` pour un envoi de l'appareil pas encore relu (S-50 : jamais promis). */
  readonly docNumber: string | null;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountSentXaf: number;
  readonly sentBy: string;
  readonly sentAt: string;
  readonly carrierName: string | null;
  /** Statut servi (`SENT`, `DISCREPANCY_PENDING`) ; `null` pour un envoi de l'appareil pas encore relu. */
  readonly status: string | null;
  /** Envoi saisi sur l'appareil, pas encore relu : sa commande. */
  readonly sendCommandId: string | null;
  /** Envoi saisi sur l'appareil, encore en attente d'envoi. */
  readonly sendWaiting: boolean;
  readonly cancelling: TransferStep;
  readonly receiving: TransferStep;
}

interface SendPayloadLike {
  readonly fromAccountId?: string;
  readonly toAccountId?: string;
  readonly amountXaf?: number;
  readonly carrierName?: string;
}

/** Étape d'une opération de l'appareil sur la remise, jusqu'au tirage du jeu `cash` qui l'inclut. */
function stepOf(
  outbox: readonly OutboxCommand[],
  commandType: string,
  transferId: string,
  cashPulledAt: string | undefined,
): TransferStep {
  const command = outbox.find(
    (candidate) =>
      candidate.command_type === commandType &&
      candidate.aggregate_id === transferId &&
      // Refusée : jamais en vol (`stillInFlight`).
      stillInFlight(candidate, cashPulledAt),
  );
  if (!command) return null;
  return isWaiting(command) ? 'WAITING' : 'SENT';
}

/**
 * Remises vues par l'appareil, de la plus récente à la plus ancienne : celles du jeu `cash`, puis
 * les envois de l'appareil pas encore relus (refusés exclus), avec les annulations et réceptions de
 * l'appareil en cours.
 */
export function deviceTransfers(input: {
  readonly transfers: readonly CashTransferData[];
  readonly outbox: readonly OutboxCommand[];
  readonly cashPulledAt: string | undefined;
}): TransferView[] {
  const step = (type: string, id: string) => stepOf(input.outbox, type, id, input.cashPulledAt);
  const served = new Set(input.transfers.map((transfer) => transfer.id));
  const views: TransferView[] = input.transfers.map((transfer) => ({
    id: transfer.id,
    docNumber: transfer.doc_number,
    fromAccountId: transfer.from_account_id,
    toAccountId: transfer.to_account_id,
    amountSentXaf: transfer.amount_sent_xaf,
    sentBy: transfer.sent_by,
    sentAt: transfer.sent_at,
    carrierName: transfer.carrier_name,
    status: transfer.status,
    sendCommandId: null,
    sendWaiting: false,
    cancelling: step('finance.cash_transfer.cancel', transfer.id),
    receiving: step('finance.cash_transfer.receive', transfer.id),
  }));
  for (const command of input.outbox) {
    if (command.command_type !== 'finance.cash_transfer.send') continue;
    if (served.has(command.aggregate_id)) continue;
    // Refusé, ou accepté et déjà relu : hors de la liste.
    if (!stillInFlight(command, input.cashPulledAt)) continue;
    const payload = command.payload as SendPayloadLike;
    if (!payload.fromAccountId || !payload.toAccountId || !payload.amountXaf) continue;
    views.push({
      id: command.aggregate_id,
      docNumber: null,
      fromAccountId: payload.fromAccountId,
      toAccountId: payload.toAccountId,
      amountSentXaf: payload.amountXaf,
      sentBy: command.author_user_id,
      sentAt: command.occurred_at,
      carrierName: payload.carrierName ?? null,
      status: null,
      sendCommandId: command.command_id,
      sendWaiting: isWaiting(command),
      cancelling: step('finance.cash_transfer.cancel', command.aggregate_id),
      receiving: step('finance.cash_transfer.receive', command.aggregate_id),
    });
  }
  return views.sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.id.localeCompare(b.id));
}

/** Paires de types de comptes admises (paramètre visible, défaut d'AV-158 sinon). */
export function transferPairs(settings: readonly SettingData[], now: Date): CashTransferPairs {
  return cashTransferPairsFrom(
    settingValue(settings, 'finance.cash_transfer_allowed_pairs', null, now),
  );
}

/**
 * Caisses où l'utilisateur agit (AV-311) : comptes actifs servis à l'appareil, sans détenteur (caisse
 * de PDV, centrale, banque, mobile money : le serveur contrôle la portée) ou dont il est le détenteur ;
 * jamais la caisse personnelle d'un autre (`CASH_ACCOUNT_FORBIDDEN`).
 */
export function ownAccounts(
  accounts: readonly CashAccountData[],
  userId: string,
): CashAccountData[] {
  return accounts
    .filter(
      (account) =>
        account.status === 'ACTIVE' &&
        (account.holder_user_id === null || account.holder_user_id === userId),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Destinations admises depuis `source` : comptes de remise, autres que la source, paire admise. */
export function targetsFor(
  source: Pick<CashAccountData, 'id' | 'account_type'>,
  targets: readonly CashTransferTargetData[],
  pairs: CashTransferPairs,
): CashTransferTargetData[] {
  return targets
    .filter(
      (target) =>
        target.id !== source.id &&
        isCashTransferPairAllowed(source.account_type, target.account_type, pairs),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Comptes d'où l'utilisateur peut remettre : les siens qui ont au moins une destination admise. */
export function sourceAccounts(
  accounts: readonly CashAccountData[],
  targets: readonly CashTransferTargetData[],
  pairs: CashTransferPairs,
  userId: string,
): CashAccountData[] {
  return ownAccounts(accounts, userId).filter(
    (account) => targetsFor(account, targets, pairs).length > 0,
  );
}

/** Remise que l'utilisateur peut annuler : la sienne, encore en transit, sans autre opération en cours. */
export function canCancel(view: TransferView, userId: string): boolean {
  return (
    view.sentBy === userId &&
    (view.status === 'SENT' || view.status === null) &&
    view.cancelling === null &&
    view.receiving === null
  );
}

/**
 * Remises à recevoir par l'utilisateur : en transit (servies), vers l'une de ses caisses, envoyées par
 * un autre (`CASH_TRANSFER_SELF_RECEIVE`, AV-172), sans annulation ni réception en cours.
 */
export function toReceive(
  views: readonly TransferView[],
  accounts: readonly CashAccountData[],
  userId: string,
): TransferView[] {
  const receivable = new Set(ownAccounts(accounts, userId).map((account) => account.id));
  return views.filter(
    (view) =>
      view.status === 'SENT' &&
      receivable.has(view.toAccountId) &&
      isAllowedTransferReceiver(userId, view.sentBy) &&
      view.cancelling === null &&
      view.receiving === null,
  );
}

/** Remises envoyées par l'utilisateur, en transit ou en écart (les siennes, saisies ou servies). */
export function mySentTransfers(views: readonly TransferView[], userId: string): TransferView[] {
  return views.filter((view) => view.sentBy === userId);
}

/**
 * AV-312 (défaut) : une remise au-delà du solde indicatif est signalée, jamais bloquée sur l'appareil :
 * ce solde ignore les mouvements des autres appareils ; en ligne, le serveur refuse une sortie qui
 * rendrait négative une caisse physique (`CASH_INSUFFICIENT`, BR-FIN-012) ; hors ligne, il l'applique
 * et ouvre `CASH_NEGATIVE` pour la Finance.
 */
export function overIndicativeBalance(
  account: Pick<CashAccountData, 'account_type'>,
  balanceXaf: number | null,
  amountXaf: number,
): boolean {
  return (
    account.account_type.startsWith('CAISSE_') && balanceXaf !== null && amountXaf > balanceXaf
  );
}

export function sendPayload(input: {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountXaf: number;
  readonly carrierName: string;
  readonly comment: string;
}) {
  const carrierName = input.carrierName.trim();
  const comment = input.comment.trim();
  return {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountXaf: input.amountXaf,
    ...(carrierName ? { carrierName } : {}),
    ...(comment ? { comment } : {}),
  };
}

export function receivePayload(input: { readonly receivedXaf: number; readonly comment: string }) {
  const comment = input.comment.trim();
  return { receivedXaf: input.receivedXaf, ...(comment ? { comment } : {}) };
}

export function cancelPayload(reason: string) {
  return { reason: reason.trim() };
}

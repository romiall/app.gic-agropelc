/**
 * Trésorerie de la Finance (ECR-FIN-05 ; ADR-032 ; SM-CASH-SESSION, SM-CASH-TRANSFER ; AV-241).
 * Logique pure sur les lectures en ligne : sessions de caisse à valider (`GET /cash-sessions`, détail
 * avec flux par vendeur et ajustements), remises en transit et écarts à décider (`GET /cash-transfers`),
 * comptes et mouvements (`GET /cash-accounts`). Contrôles de l'appareil alignés sur le serveur
 * (valideur, motif, imputation) et charges utiles de `finance.cash_session.validate` et de la clôture
 * d'un écart de remise (`finance.cash_transfer.close_discrepancy`, avec ou sans demande liée).
 */
import {
  CASH_TRANSFER_IMPUTATIONS,
  isAllowedCashValidator,
  isAllowedTransferValidator,
  isTransferCarrierKnown,
  type CashTransferImputation,
} from '@gic/domain';

/** Session de caisse (`CashSessionDetail`, camelCase). */
export interface CashSessionItem {
  readonly id: string;
  readonly cashAccountId: string;
  readonly siteId: string;
  readonly businessDate: string | null;
  readonly status: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly openingCountedXaf: number;
  readonly openingExpectedXaf: number;
  readonly openingVarianceXaf: number;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly closingCountedXaf: number | null;
  readonly closingExpectedXaf: number | null;
  /** Écart de clôture (compté − attendu) ; jamais réécrit, les ajustements s'y ajoutent. */
  readonly varianceXaf: number | null;
  readonly forceClosed: boolean;
  readonly forcedBy: string | null;
  readonly approvalRequestId: string | null;
  readonly clockSuspect: boolean;
  readonly version: number;
}

export interface CashSessionsPage {
  readonly cash_sessions: readonly CashSessionItem[];
  readonly next_cursor: string | null;
}

export interface CashSessionAdjustment {
  readonly id: string;
  readonly cause: string;
  readonly deltaXaf: number;
  readonly varianceAfterXaf: number;
  readonly treatment: string;
  readonly status: string;
  readonly appliedAt: string;
}

export interface CashSessionFlows {
  readonly window: { readonly from: string; readonly to: string | null };
  readonly sellers: readonly {
    readonly userId: string;
    readonly receivedXaf: number;
    readonly paymentsCount: number;
  }[];
  readonly unattributedReceivedXaf: number;
  readonly otherMovements: readonly {
    readonly movementType: string;
    readonly direction: 'IN' | 'OUT';
    readonly amountXaf: number;
    readonly count: number;
  }[];
  readonly netFlowsXaf: number;
  readonly expectedNowXaf: number;
}

export interface CashSessionDetailResponse {
  readonly cash_session: CashSessionItem;
  readonly adjustments: readonly CashSessionAdjustment[];
  readonly flows: CashSessionFlows | null;
}

/** Remise de fonds (`CashTransferSummary`, camelCase ; dates ISO). */
export interface CashTransferItem {
  readonly id: string;
  readonly docNumber: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountSentXaf: number;
  readonly amountReceivedXaf: number | null;
  /** Reçu − envoyé : négatif = manque. */
  readonly discrepancyXaf: number | null;
  readonly status: string;
  readonly sentBy: string;
  readonly sentAt: string;
  readonly carrierUserId: string | null;
  readonly carrierName: string | null;
  readonly receivedBy: string | null;
  readonly receivedAt: string | null;
  readonly approvalRequestId: string | null;
}

export interface CashTransfersPage {
  readonly cash_transfers: readonly CashTransferItem[];
  readonly next_cursor: string | null;
}

/** Compte de trésorerie (`CashAccountSummary`). */
export interface CashAccountItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  readonly siteId: string | null;
  readonly holderUserId: string | null;
  readonly balanceXaf: number;
  readonly status: string;
}

export interface CashAccountsResponse {
  readonly cash_accounts: readonly CashAccountItem[];
}

export interface CashMovementItem {
  readonly id: string;
  readonly direction: 'IN' | 'OUT';
  readonly amountXaf: number;
  readonly movementType: string;
  readonly occurredAt: string;
  readonly isReversal: boolean;
}

export interface CashMovementsPage {
  readonly movements: readonly CashMovementItem[];
  readonly next_cursor: string | null;
}

/** Longueurs maximales des motifs : validation d'une session, clôture d'un écart de remise (500). */
export const MAX_SESSION_REASON = 500;
export const MAX_DECISION_REASON = 500;

/** Écart courant d'une session : écart de clôture plus les ajustements (réévaluation, ADR-032 §6). */
export function currentVarianceXaf(
  session: Pick<CashSessionItem, 'varianceXaf'>,
  adjustments: readonly Pick<CashSessionAdjustment, 'deltaXaf'>[],
): number {
  return adjustments.reduce(
    (sum, adjustment) => sum + adjustment.deltaXaf,
    session.varianceXaf ?? 0,
  );
}

/**
 * Motif exigé pour valider (BR-DIS-007, comme le serveur, `validateCashSession`) : écart d'ouverture
 * ou de clôture non nul, ou ajustement inclus dans la validation encore en attente.
 */
export function sessionReasonRequired(
  session: Pick<CashSessionItem, 'openingVarianceXaf' | 'varianceXaf'>,
  adjustments: readonly Pick<CashSessionAdjustment, 'treatment' | 'status'>[],
): boolean {
  return (
    session.openingVarianceXaf !== 0 ||
    (session.varianceXaf ?? 0) !== 0 ||
    adjustments.some(
      (adjustment) =>
        adjustment.treatment === 'INCLUDED_IN_VALIDATION' && adjustment.status === 'PENDING',
    )
  );
}

/** Pourquoi une session ne peut pas être validée ici ; `null` si elle le peut. */
export type SessionValidationBlock = 'NOT_PENDING' | 'INVOLVED';

/**
 * Comme le serveur (`validateCashSession`) : la session doit être en attente de validation
 * (`CASH_SESSION_NOT_PENDING`), puis le valideur n'en est ni l'ouvreur, ni le clôtureur, ni l'auteur
 * de la clôture forcée (`CASH_VALIDATOR_INVOLVED`, AV-155, RC-03).
 */
export function sessionValidationBlock(
  session: Pick<CashSessionItem, 'status' | 'openedBy' | 'closedBy' | 'forcedBy'>,
  userId: string,
): SessionValidationBlock | null {
  if (session.status !== 'PENDING_VALIDATION') return 'NOT_PENDING';
  return isAllowedCashValidator(userId, {
    openedBy: session.openedBy,
    closedBy: session.closedBy,
    forcedBy: session.forcedBy,
  })
    ? null
    : 'INVOLVED';
}

export function validatePayload(reason: string) {
  const trimmed = reason.trim();
  return trimmed ? { reason: trimmed } : {};
}

/**
 * Pourquoi un écart de remise ne peut pas être clos ici ; `null` s'il le peut (AV-174). Avec ou sans
 * demande de validation liée, la même commande le clôt (AV-183 harmonisé).
 */
export type TransferDecisionBlock = 'INVOLVED' | 'NOT_PENDING';

export function transferDecisionBlock(
  transfer: Pick<CashTransferItem, 'status' | 'sentBy' | 'receivedBy' | 'carrierUserId'>,
  userId: string,
): TransferDecisionBlock | null {
  if (transfer.status !== 'DISCREPANCY_PENDING') return 'NOT_PENDING';
  return isAllowedTransferValidator(userId, transfer) ? null : 'INVOLVED';
}

/** Imputations proposées (AV-153) ; le porteur seulement s'il est connu (utilisateur ou nom). */
export function imputationOptions(
  transfer: Pick<CashTransferItem, 'carrierUserId' | 'carrierName'>,
): readonly { readonly option: CashTransferImputation; readonly disabled: boolean }[] {
  return CASH_TRANSFER_IMPUTATIONS.map((option) => ({
    option,
    disabled: option === 'CARRIER' && !isTransferCarrierKnown(transfer),
  }));
}

/**
 * Charge utile de `finance.cash_transfer.close_discrepancy` (agrégat de la remise ; en ligne
 * seulement) : imputation et motif (`cashTransferCloseDiscrepancyPayloadSchema`).
 */
export function closeDiscrepancyPayload(input: {
  readonly option: CashTransferImputation;
  readonly reason: string;
}) {
  return { imputation: input.option, reason: input.reason.trim() };
}

/** Libellé court d'un utilisateur (les noms ne sont pas servis, S-28) : « vous » ou `…abcd`. */
export function userLabel(id: string | null, userId: string, you: string): string {
  if (id === null) return '';
  return id === userId ? you : `…${id.slice(-4)}`;
}

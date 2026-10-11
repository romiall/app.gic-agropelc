/** API publique du module `finance` (01-architecture-logicielle.md §3, règle 1) : seul point
 * d'import autorisé depuis un autre module (`sales`, plus tard `procurement`/`production` pour les
 * dépenses et les règlements) et depuis le transport de lecture (P4-10). P4-03 : trésorerie —
 * comptes, mouvements, solde, réconciliation. */
export {
  CASH_MOVEMENT_TYPES,
  CASH_SOURCE_DOC_TYPES,
  CashMovementError,
  recordCashMovement,
} from './cash-movements.js';
export type {
  CashDirection,
  CashMovementType,
  CashSourceDocType,
  RecordCashMovementInput,
  RecordedCashMovement,
} from './cash-movements.js';

export {
  CASH_ACCOUNT_TYPES,
  findCashAccount,
  cashAccountBalance,
  cashPosition,
  verifyCashLedger,
  rebuildCashBalances,
} from './cash-accounts.js';
export type {
  CashAccountType,
  CashAccountSummary,
  CashPosition,
  CashLedgerScope,
  CashLedgerMismatch,
  CashLedgerVerification,
} from './cash-accounts.js';

export { cashAccountFor, findPaymentMethod } from './cash-account-resolution.js';
export type {
  CashAccountContext,
  CashAccountResolution,
  PaymentMethodSummary,
} from './cash-account-resolution.js';

// P4-10 : lectures des comptes de trésorerie.
export {
  CASH_LIST_DEFAULT_LIMIT,
  CASH_LIST_MAX_LIMIT,
  cashAccountResourceOf,
  listCashAccounts,
  listCashMovements,
} from './cash-account-query.js';
export type { CashMovementLine } from './cash-account-query.js';

// P5-12 : sessions de caisse — session couvrant un instant (index `cash_session_id`, ADR-032 §2).
export { findCashSessionCovering } from './cash-sessions.js';
// P5-14 : lectures d'une session pour la couche de transport (sous-totaux par vendeur).
export { cashSessionWindowFlows, findCashSessionSummary } from './cash-session-query.js';
export type { CashSessionSummary, CashSessionWindowFlows } from './cash-session-query.js';
export type { CoveringCashSession } from './cash-sessions.js';
// P5-15 : remises de fonds — résumé, indicateur « en transit », cohérence avec le registre.
export {
  cashTransfersInTransit,
  findCashTransfer,
  verifyCashTransfers,
} from './cash-transfer-query.js';
export type {
  CashTransferAccountTotal,
  CashTransferMismatch,
  CashTransferSummary,
  CashTransfersInTransit,
  CashTransferVerification,
} from './cash-transfer-query.js';
// P5-17 : lectures HTTP des sessions de caisse et des remises de fonds.
export {
  findCashSessionDetail,
  listCashSessionAdjustments,
  listCashSessions,
} from './cash-session-query.js';
export type { CashSessionAdjustmentLine, CashSessionDetail } from './cash-session-query.js';
export {
  CASH_TRANSFER_STATUSES,
  cashTransferMovements,
  listCashTransfers,
} from './cash-transfer-query.js';
export type { CashTransferMovementLine } from './cash-transfer-query.js';
// P5-19 : métriques de distribution partagées (sessions des PDV, remises en attente ; BR-ANA-009).
export { cashSessionsOverview, pendingCashTransfers } from './distribution-metrics.js';
export type {
  CashSessionBrief,
  CashSessionsOverview,
  PendingCashTransfers,
} from './distribution-metrics.js';

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

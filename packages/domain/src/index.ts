// Bibliothèque métier partagée (appareil + serveur), sans entrée-sortie — ADR-021.
// Portée de P0-02 : identifiants, horloge, argent, quantités, jour métier, arrondis.
// P0-11 : géorepère (organization.zones, BR-ADM-012). P1 : moteur de prix (pricing-engine.ts).
// L'évaluation des politiques et les calculs de disponibilité arrivent avec les modules qui
// les motivent (inventory en P2).

export { DomainError, assertSafeInteger } from './errors.js';

export type { Clock } from './clock.js';
export { FixedClock } from './clock.js';
export { SystemClock } from './system-clock.js';

export type { IdGenerator } from './id.js';
export {
  buildUuidv7,
  isUuidv7,
  extractUuidv7Timestamp,
  checkClientProvidedUuidv7,
  uuidToBin,
  binToUuid,
} from './uuid.js';
export type { ClientProvidedIdCheck } from './uuid.js';
export { Uuidv7Generator } from './uuidv7-generator.js';

export type { Xaf } from './money.js';
export {
  xaf,
  ZERO_XAF,
  addXaf,
  differenceXaf,
  splitSignedXaf,
  compareXaf,
  formatXaf,
} from './money.js';

export type { Quantity } from './quantity.js';
export {
  convertToBaseQuantity,
  quantityFromDecimal,
  quantityFromMilli,
  ZERO_QUANTITY,
  quantityMilliUnits,
  quantityToDecimal,
  addQuantity,
  subtractQuantity,
  isPositiveQuantity,
  isZeroQuantity,
  isWholeQuantity,
  compareQuantity,
  formatQuantity,
} from './quantity.js';

export {
  businessDayOf,
  businessDayStartUtc,
  businessDayEndUtc,
  isWithinBusinessDay,
  nextBusinessDay,
  addBusinessDays,
  businessMonthDays,
  periodOfBusinessDay,
  BUSINESS_PERIOD_CODES,
  businessPeriodOf,
  businessPeriodDays,
} from './business-day.js';
export type { BusinessPeriodCode } from './business-day.js';

export { roundHalfUpMilliXafToFranc, lineAmountXaf } from './rounding.js';

export type { Geofence, GeofenceInput } from './geofence.js';
export { buildGeofence } from './geofence.js';

export {
  CLOCK_SKEW_STORED_MAX_MS,
  CLOCK_SKEW_SUSPECT_MS,
  OCCURRED_AT_FUTURE_TOLERANCE_DEFAULT_MS,
  clampClockSkewMs,
  clockSkewThresholdMsFrom,
  futureToleranceMsFrom,
  isClockSkewSuspect,
} from './clock-skew.js';

export type {
  PriceRule,
  PriceContext,
  PriceRuleStatus,
  ResolvedPrice,
  ResolvePriceResult,
} from './pricing-engine.js';
export { resolvePrice, specificityOf, findConflicts } from './pricing-engine.js';

export type {
  LotBalance,
  LotAllocation,
  LotSelectionResult,
  StockThresholdState,
  StockThresholdEvaluation,
} from './stock-engine.js';
export {
  availableOnExclusive,
  availableOnShared,
  selectLotsFifo,
  recalculateCmup,
  roundCmupToXaf,
  stockValueXaf,
  settlementValueXaf,
  evaluateStockThreshold,
} from './stock-engine.js';

export type {
  GeoPoint,
  CheckinResult,
  CheckinEvaluation,
  CheckinSuspicionFlag,
  SessionEndCause,
  VisitFlag,
} from './fieldwork.js';
export {
  assertGeoPoint,
  haversineDistanceM,
  evaluateCheckin,
  canRequestOverride,
  sessionAutoCloseAt,
  resolveSessionEnd,
  detectCheckinSuspicion,
  evaluateVisit,
} from './fieldwork.js';

export type {
  OrderLineProgress,
  ReceivableOrderStatus,
  OrderedRequestStatus,
} from './procurement.js';
export {
  receiptLineQuantities,
  orderLineRemaining,
  overReceiptQuantity,
  orderStatusFromLines,
  requestStatusFromLines,
  orderAmounts,
  orderRequiresApproval,
  receiptAcceptedValueXaf,
  receiptPhotoRequired,
  sumQuantities,
} from './procurement.js';

export type { FieldVersion, FieldCollision } from './crm.js';
export { normalizePhone, mergeFieldPatch } from './crm.js';

export type {
  ProductionLotType,
  ProductionLotStatus,
  LotTypeProfile,
  EggGradeCount,
  EggCollectionInput,
  IncubationCounters,
  MortalityThresholds,
  ProRataShare,
  LotEntrySourceKind,
} from './production.js';
export {
  PRODUCTION_LOT_TYPES,
  lotTypeProfile,
  acceptsDailyEntries,
  acceptsLotEntries,
  lotAcceptsProductSpecies,
  speciesGroupOfProduct,
  checkLotEntry,
  rate4,
  eggCollectionBalance,
  eggsRemaining,
  checkCandling,
  checkHatch,
  incubationBalanced,
  hatchRates,
  mortalityRequiresApproval,
  costPerHeadXaf,
  allocateProRata,
  headDaysInPeriod,
  allocateByWeight,
  checkSlaughter,
  unitCostXaf,
  checkWeighing,
  mortalityRate,
  layingRate,
  averageDailyGainG,
  feedConversionRatio,
  slaughterYield,
} from './production.js';

export type {
  PricingMode,
  SaleLineAmounts,
  SaleTotals,
  PriceOverrideOutcome,
  CreditOutcome,
  PaymentStatus,
  SaleBalances,
  PaymentAllocation,
  AgingBucket,
  SalesOrderLineQuantities,
  SalesOrderLineAdjustment,
  DeliverableSaleLine,
  DeliveryAllocation,
  SalesOrderStatus,
} from './sales.js';
export {
  pricingQuantity,
  discountFromPercentXaf,
  saleLineAmounts,
  saleTotals,
  maxDiscountPctOf,
  priceOverrideCheck,
  creditCheck,
  checkSaleCustomer,
  saleBalances,
  excessPaymentXaf,
  allocatePayment,
  normalizePaymentReference,
  isProbableDuplicatePayment,
  withinCancellationWindow,
  dueDateOf,
  receivableAging,
  lineCancellationAmountXaf,
  salesOrderLineProgress,
  confirmableQuantity,
  salesOrderLineAdjustment,
  salesOrderStatusFromLines,
  deliveryAllocation,
  splitAmountXaf,
} from './sales.js';

// Quotas d'appareil, sessions de caisse, remises de fonds, distribution (P5 ; ADR-032, ADR-033).
export {
  ALLOCATION_ENTRY_TYPES,
  allocationEntrySign,
  signedAllocationEntry,
  allocationRemaining,
  availableForConsumer,
  planQuotaConsumption,
  decideLocalConsumption,
  restorableQuantity,
  checkGrantCapacity,
  allocationValidUntil,
  isAllocationExpired,
  isConsumedAfterRevocation,
  // P5-11 : miroir serveur du blocage local (AT-003) et signal d'AV-166.
  UNALLOCATED_SALE_SIGNALS,
  DEFAULT_UNALLOCATED_SALE_SIGNAL,
  parseUnallocatedSaleSignal,
  offlineAllocationSignal,
} from './allocations.js';
export type {
  AllocationEntryType,
  ConsumerQuotaState,
  CustodyMode,
  LocalConsumptionBlock,
  LocalConsumptionDecision,
  OfflineAllocationSignal,
  QuotaConsumptionPlan,
  UnallocatedSaleSignal,
} from './allocations.js';
export {
  CASH_SESSION_STATUSES,
  CASH_EXPECTED_EXCLUDED_TYPES,
  CASH_TRANSFER_IMPUTATIONS,
  isInCashSessionWindow,
  cashSessionWindowsOverlap,
  expectedCashXaf,
  cashVarianceXaf,
  openingVarianceXaf,
  reevaluationDeltaXaf,
  varianceMovement,
  statusAfterClose,
  varianceSeverity,
  adjustmentTreatment,
  isAllowedCashValidator,
  sellerCashSubtotals,
  transferDiscrepancyXaf,
  transferStatusAfterReceive,
  cashInTransitXaf,
} from './cash-session.js';
export type {
  AdjustmentTreatment,
  CashMovementAmount,
  CashSessionStatus,
  CashSessionWindow,
  CashTransferImputation,
  SellerCashSubtotal,
} from './cash-session.js';
// P5-12 : cycle de vie d'une session de caisse (ouverture, clôture, statut, imputation).
export {
  CASH_SESSION_PREVIOUS_DAY_OVERLAP_MODES,
  CASH_SESSION_PREVIOUS_DAY_OVERLAP_DEFAULT,
  CASH_SESSION_CLOSE_BEFORE_OPEN_MODES,
  CASH_SESSION_CLOSE_BEFORE_OPEN_DEFAULT,
  CASH_SESSION_CLOSE_BEFORE_MOVEMENTS_MODES,
  CASH_SESSION_CLOSE_BEFORE_MOVEMENTS_DEFAULT,
  CASH_FORCED_VARIANCE_IMPUTATIONS,
  CASH_FORCED_VARIANCE_IMPUTATION_DEFAULT,
  normalizedSessionsPerDay,
  planCashSessionOpen,
  countsInOpeningBalance,
  planCashSessionClose,
  checkCashSessionCloseAgainstLedger,
  sessionStatusAfterClose,
  cashSessionOpenLongerThan,
  cashVarianceImputedUser,
} from './cash-session-lifecycle.js';
export type {
  ExistingCashSession,
  CashSessionPreviousDayOverlapMode,
  CashSessionOpenRejection,
  CashSessionMergeReason,
  CashSessionOpenPlan,
  PlanCashSessionOpenInput,
  CashSessionCloseBeforeOpenMode,
  CashSessionClosePlan,
  CashSessionCloseBeforeMovementsMode,
  CashSessionCloseLedgerCheck,
  CashForcedVarianceImputation,
} from './cash-session-lifecycle.js';
// P5-15 : remises de fonds (paires, séparation des tâches, transitions et courses hors ligne).
export {
  CASH_TRANSFER_STATUSES,
  CASH_TRANSFER_ACCOUNT_TYPES,
  CASH_TRANSFER_RACE_CODES,
  CASH_TRANSFER_DEFAULT_SERIES_CODE,
  DEFAULT_CASH_TRANSFER_PAIRS,
  DEFAULT_CASH_TRANSFER_UNRECEIVED_HOURS,
  cashTransferPairsFrom,
  isCashTransferPairAllowed,
  isAllowedTransferReceiver,
  isAllowedTransferValidator,
  checkTransferImputation,
  cashTransferUnreceivedHoursFrom,
  isTransferUnreceived,
  cashTransferSeriesCodeFrom,
  decideCashTransferAction,
} from './cash-transfer.js';
export type {
  CashTransferAccountType,
  CashTransferAction,
  CashTransferDecision,
  CashTransferPairs,
  CashTransferRaceCode,
  CashTransferStatus,
} from './cash-transfer.js';
export { distributionResidual, isDistributionReconciled } from './distribution.js';
export type { DistributionFlows } from './distribution.js';

// Réception sans document, rapprochement et répartition d'une réception (P5-16 ; BR-STK-024, AV-177).
export {
  DEFAULT_TRANSFER_UNMATCHED_HOURS,
  DEFAULT_BLIND_RECEIPT_MATCH_MODE,
  unmatchedHoursOrDefault,
  isUnmatchedOverdue,
  blindReceiptMatchModeOrDefault,
  blindReceiptMatch,
  chooseDispatchForBlindReceipt,
  chooseBlindReceiptForDispatch,
  planTransferReceipt,
  allocateReceivedToLines,
} from './stock-transfers.js';
export type {
  BlindReceiptMatchMode,
  BlindReceiptMatchKind,
  ProductQuantityMilli,
  MatchCandidate,
  ChosenMatch,
  DispatchPiece,
  TransferReceiptLine,
  PlannedTransferMove,
  DispatchedLine,
} from './stock-transfers.js';

// Récurrence des tâches planifiées, heure locale de Douala (P5-16).
export { nextRecurringRun, assertRecurringSchedule, localTimeMinutes } from './recurrence.js';
export type { RecurringSchedule } from './recurrence.js';

// Décision d'une demande de validation par type d'opération ; auto-validation (MP-07, ECR-ADM-08).
export {
  APPROVAL_COMMENT_MAX,
  APPROVAL_DECISION_DATA_MAX,
  APPROVAL_DECISION_SPECS,
  SELF_APPROVAL_ROLE,
  approvalDecisionSpec,
  canSelfApprove,
} from './approval-decisions.js';
export type { ApprovalDecisionOptions, ApprovalDecisionSpec } from './approval-decisions.js';

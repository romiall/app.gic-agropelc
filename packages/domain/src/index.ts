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
  isoWeekdayOfBusinessDay,
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
  CHECKIN_SUSPICION_LABELS,
  checkinSuspicionLabel,
  evaluateVisit,
} from './fieldwork.js';
export type {
  DeviceStaleness,
  DeviceStalenessInput,
  KnownGap,
  SequenceGap,
} from './sync-alerts.js';
export {
  DEFAULT_SYNC_ERROR_EXCLUDED_CODES,
  DEFAULT_SYNC_ERROR_WINDOW_HOURS,
  DEFAULT_SYNC_SEQ_GAP_HOURS,
  DEFAULT_SYNC_STALE_HORIZON_DAYS,
  DEFAULT_SYNC_STALE_HOURS,
  MAX_SYNC_ALERT_HOURS,
  MAX_SYNC_STALE_HORIZON_DAYS,
  agedSequenceGaps,
  clockSkewMinutes,
  deviceStaleness,
  gapsExplainedByPending,
  isSyncErrorAlertable,
  missingSequenceCount,
  nextKnownGaps,
  parseKnownGaps,
  sameSequenceGaps,
  syncErrorAlertWindowHoursOrDefault,
  syncErrorCodeOf,
  syncErrorExcludedCodesOrDefault,
  syncSeqGapAlertHoursOrDefault,
  syncStaleHoursOrDefault,
  syncStaleHorizonDaysOrDefault,
  unsignaledSequenceGaps,
} from './sync-alerts.js';
export type { ConsumerAlarmInput } from './consumer-alerts.js';
export {
  DEFAULT_CONSUMER_FAILURE_WINDOW_HOURS,
  DEFAULT_CONSUMER_LAG_ALERT_SECONDS,
  MAX_CONSUMER_FAILURE_WINDOW_HOURS,
  MAX_CONSUMER_LAG_ALERT_SECONDS,
  consumerFailureWindowHoursOrDefault,
  consumerInAlarm,
  consumerLagAlertSecondsOrDefault,
  consumerLagSeconds,
} from './consumer-alerts.js';

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
  isTransferCarrierKnown,
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
export {
  DEFAULT_CASH_HOLDING_MAX_DAYS,
  DEFAULT_CASH_HOLDING_MAX_XAF,
  assessCashHolding,
  businessDaysBetween,
  cashHeldSince,
  cashHoldingThresholdFrom,
} from './cash-holding.js';
export type { CashHoldingReason, CashInflow } from './cash-holding.js';
export {
  DEFAULT_HIGH_LOSS_ALERT_XAF,
  DEFAULT_HIGH_LOSS_SALES_PCT,
  DEFAULT_LOT_EXPIRING_DAYS,
  DEFAULT_POS_REPLENISH_SCOPE,
  DEFAULT_TRANSFER_NOT_RECEIVED_HOURS,
  POS_REPLENISH_SCOPES,
  elapsedHours,
  highLossAlertXafOrDefault,
  highLossSalesPctOrDefault,
  isHighLossAbsolute,
  isHighLossSalesShare,
  isTransferNotReceived,
  lossSalesSharePct,
  lotDaysLeft,
  MAX_LOT_EXPIRING_DAYS,
  lotExpiringDaysOrDefault,
  lotExpiringHorizonDay,
  needsReplenishment,
  posReplenishScopeOrDefault,
  stockLevelChanges,
  stockLevelOfState,
  stockThresholdStateOf,
  transferNotReceivedHoursOrDefault,
} from './stock-alerts.js';
export type { PosReplenishScope, StockAlertLevel, StockLevelChange } from './stock-alerts.js';

// Alertes de production (P9-09 ; D13 §7.1, AV-121, AV-124, AV-461 à AV-463).
export {
  DEFAULT_DAILY_ENTRY_WORKING_DAYS,
  DEFAULT_HIGH_MORTALITY_ALERT_HEADS,
  DEFAULT_HIGH_MORTALITY_ALERT_PCT,
  DEFAULT_STANDARD_COST_ALERT_LOOKBACK_DAYS,
  dailyEntryExpected,
  dailyEntryWorkingDaysOrDefault,
  highMortalityAlertHeadsOrDefault,
  highMortalityAlertPctOrDefault,
  MAX_STANDARD_COST_ALERT_LOOKBACK_DAYS,
  highMortalityCause,
  highMortalityRatePct,
  isValidHighMortalityThreshold,
  mortalityReferenceHeadcount,
  standardCostAlertLookbackDaysOrDefault,
} from './production-alerts.js';
export type { HighMortalityCause } from './production-alerts.js';
// Alertes d'achats, de validations et de pièces (P9-09 ; BR-APP-015, AV-408, AV-410, AV-407, AV-449).
export {
  DEFAULT_RECEIPT_INCOMPLETE_ALERT_DAYS,
  receiptIncompleteAlertDaysOrDefault,
  receiptIncompleteState,
} from './procurement-alerts.js';
export type {
  ReceiptIncompleteLine,
  ReceiptIncompleteReason,
  ReceiptIncompleteState,
} from './procurement-alerts.js';
export {
  APPROVAL_OPERATION_LABELS,
  DEFAULT_APPROVAL_PENDING_LONG_HOURS,
  approvalOperationLabel,
  MAX_APPROVAL_PENDING_LONG_HOURS,
  approvalPendingHours,
  approvalPendingLongHoursOrDefault,
} from './approval-alerts.js';
export {
  ATTACHMENT_DAY_MS,
  DEFAULT_ATTACHMENT_MISSING_ALERT_DAYS,
  DEFAULT_ATTACHMENT_MISSING_HORIZON_DAYS,
  MAX_ATTACHMENT_ALERT_DAYS,
  attachmentDaysMissing,
  attachmentMissingAlertDaysOrDefault,
  attachmentScanWindow,
  wholeDaysOrDefault,
} from './attachment-alerts.js';
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

// Dépenses (P8 ; ADR-042 ; SM-EXPENSE ; BR-FIN-020 à 022, BR-DIS-013).
export {
  EXPENSE_STATUSES,
  EXPENSE_COST_OBJECT_TYPES,
  EXPENSE_SPECIES_GROUPS,
  EXPENSE_LOT_COST_TYPES,
  EXPENSE_REVIEW_REASONS,
  EXPENSE_REVIEW_ERROR_CODES,
  UNJUSTIFIED_EXPENSE_CATEGORY_CODE,
  expenseRequiresApproval,
  expensePhotoRequired,
  expenseReviewReasons,
  expenseStatusAtRecord,
  expenseTransition,
  expenseCarriesCost,
  expenseCostLine,
  expenseApprovalWithinLimits,
} from './expenses.js';
export type {
  ExpenseStatus,
  ExpenseCostObjectType,
  ExpenseSpeciesGroup,
  ExpenseLotCostType,
  ExpenseReviewReason,
  ExpenseCostObjectState,
  ExpenseAction,
} from './expenses.js';

// Factures et paiements fournisseurs (P8 ; ADR-043 ; BR-FIN-030 à 033, INV-FIN-07).
export {
  SUPPLIER_INVOICE_STATUSES,
  SUPPLIER_PAYMENT_STATUSES,
  SUPPLIER_ALLOCATION_STATUSES,
  INVOICE_WITHOUT_PO_MODES,
  INVOICE_MISMATCH_REASONS,
  invoicedQuantitiesByOrderLine,
  matchSupplierInvoice,
  normalizedInvoiceRef,
  quantityExcessSince,
  supplierInvoiceDueDate,
  supplierInvoiceTransition,
  supplierInvoiceStatusFromPaid,
  supplierPaymentRequiresApproval,
  planSupplierPayment,
  supplierPaymentTransition,
} from './supplier-ledger.js';
export type {
  SupplierInvoiceStatus,
  SupplierPaymentStatus,
  SupplierAllocationStatus,
  InvoiceWithoutPoMode,
  InvoiceMismatchReason,
  InvoiceMismatchDetail,
  InvoiceLineInput,
  MatchedOrderLine,
  SupplierInvoiceMatch,
  SupplierInvoiceAction,
  PayableInvoice,
  SupplierPaymentAction,
} from './supplier-ledger.js';

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

// P9 : alertes (catalogue, traitement d'un événement, rendu, livraison), périodes d'analyse, registre
// des indicateurs et couche sémantique de l'explorateur (ADR-070 à ADR-078).
export {
  ALERT_CATALOG,
  ALERT_DETECTOR_MODULES,
  ALERT_NATURES,
  ALERT_PASS_COMPLETED_EVENT,
  ALERT_RESOLUTION_MODES,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_TYPES,
  OPEN_ALERT_STATUSES,
  alertDedupKey,
  alertDefinitionOf,
  alertSubjectKey,
  compareAlertSeverity,
  enabledByDefault,
  isAlertSeverity,
  isAlertType,
  raisedSeverity,
} from './alerts.js';
export type {
  AlertDetectorModule,
  AlertEventPayload,
  AlertFieldKind,
  AlertMessageField,
  AlertNature,
  AlertResolutionMode,
  AlertSeverity,
  AlertStatus,
  AlertTrigger,
  AlertType,
  AlertTypeDefinition,
} from './alerts.js';
export {
  ALERT_COMMANDS,
  alertFromEvent,
  alertTriggerEventTypes,
  alertPassId,
  alertPassIdPrefix,
  alertsResolvedByPass,
  applyAlertCommand,
  isAlertTriggerEvent,
} from './alert-processing.js';
export type {
  AlertAction,
  AlertCommand,
  AlertEventInput,
  AlertEventIssue,
  AlertFromEventResult,
  AlertPassCompletedAction,
  AlertRaiseAction,
  AlertResolveAction,
  AlertTransition,
  AlertTransitionInput,
  AlertTransitionRefusal,
  OpenAlertForPass,
} from './alert-processing.js';
export { alertCarriesProtectedValue, renderAlertMessage } from './alert-message.js';
export type { RenderAlertMessageOptions, RenderedAlertMessage } from './alert-message.js';
export {
  DEFAULT_ESCALATION_HOURS,
  DEFAULT_PUSH_GROUP_MINUTES,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  escalationDueAt,
  escalationTitle,
  groupedPushBody,
  isEscalationDue,
  notificationChannelsFor,
  pushGroupDecision,
} from './alert-delivery.js';
export {
  FALLBACK_RECIPIENT_ROLE,
  RECIPIENT_ORIGINS,
  effectiveRecipientRoles,
  mergeRecipients,
  planRecipients,
  recipientsToAdd,
} from './alert-recipients.js';
export type { RecipientCandidate, RecipientOrigin, RecipientPlan } from './alert-recipients.js';
export type {
  EscalationCandidate,
  NotificationChannel,
  NotificationKind,
  PushGroupDecision,
} from './alert-delivery.js';
export {
  ANALYTICS_PERIOD_CODES,
  isAnalyticsPeriodCode,
  resolveAnalyticsPeriod,
} from './analytics-period.js';
export type {
  AnalyticsPeriod,
  AnalyticsPeriodCode,
  AnalyticsPeriodWindow,
  ResolveAnalyticsPeriodInput,
} from './analytics-period.js';
export {
  ANALYTICS_CATALOG_VERSION,
  ANALYTICS_DATASETS,
  EXPLORATION_FILTER_OPS,
  EXPLORATION_LIMITS,
  analyticsCatalogIssues,
  datasetOf,
  validateExploration,
} from './analytics-catalog.js';
export type {
  DatasetDefinition,
  DimensionDefinition,
  DimensionType,
  ExplorationContext,
  ExplorationDefinition,
  ExplorationErrorCode,
  ExplorationFilter,
  ExplorationFilterOp,
  ExplorationPlan,
  ExplorationSort,
  ExplorationValidation,
  MeasureAggregate,
  MeasureDefinition,
  MeasureUnit,
  ResolvedFilter,
  ScopeKind,
} from './analytics-catalog.js';
export { KPI_CATALOG, kpiDefinitionOf, kpiHasPreviousPeriod, kpisToCreate } from './kpi-catalog.js';
export type { KpiDefinition, KpiNature, KpiReferenceState } from './kpi-catalog.js';
// Règles d'un nouveau mot de passe (MP-08 ; AV-008, AV-280).
export {
  LOGIN_PASSWORD_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  newPasswordProblem,
} from './password.js';
export type { NewPasswordProblem } from './password.js';
// Audience des notes de direction (P9-11 ; ADR-073, AV-476) : règle pure partagée lecture / accusé / publication.
export {
  NOTE_AUDIENCE_ALL_REF,
  assignmentInAudience,
  expandNoteAudience,
  normalizeNoteAudience,
  noteAudienceEntryOfRow,
  noteAudienceRow,
  userInAudience,
} from './note-audience.js';
export type {
  AudienceAssignment,
  AudienceGeography,
  ExpandedNoteAudience,
  NoteAudienceEntry,
  NoteAudienceType,
} from './note-audience.js';
// Notifications directes d'événements du catalogue (P9-11 (3/3) ; AV-439, AV-480 à AV-482).
export {
  DIRECT_NOTIFICATION_COMMENT_MAX,
  DIRECT_NOTIFICATION_EVENT_TYPES,
  DirectNotificationPayloadError,
  TRANSFER_DISPATCH_PERMISSION,
  TRANSFER_RECEIVE_PERMISSION,
  disabledDirectNotificationTypes,
  isDirectNotificationEventType,
  planDirectNotification,
} from './direct-notifications.js';
export type {
  DirectAudience,
  DirectNotificationEventType,
  DirectNotificationPlan,
  DirectNotificationSourceType,
  DirectPerimeter,
} from './direct-notifications.js';

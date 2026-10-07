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
} from './business-day.js';

export { roundHalfUpMilliXafToFranc, lineAmountXaf } from './rounding.js';

export type { Geofence, GeofenceInput } from './geofence.js';
export { buildGeofence } from './geofence.js';

export { CLOCK_SKEW_SUSPECT_MS, isClockSkewSuspect } from './clock-skew.js';

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
} from './sales.js';

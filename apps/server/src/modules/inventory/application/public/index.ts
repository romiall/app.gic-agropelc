/** API publique du module `inventory` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module (`procurement`, `production`, `sales`…,
 * à partir des phases qui en dépendent — le graphe les y autorise déjà) et depuis le
 * transport `inventory-api/` (lectures HTTP, P2-05). */
export {
  recordStockMove,
  lockStockCouples,
  lockPhysicalStockCouples,
  biologicalLotUnitCostXaf,
  biologicalLotRemainingCostXaf,
  InventoryMoveError,
  MOVE_TYPES,
  SOURCE_DOC_TYPES,
} from './record-move.js';
export type {
  MoveType,
  SourceDocType,
  RecordMoveInput,
  RecordMoveDeps,
  RecordedMove,
} from './record-move.js';

export {
  INVENTORY_LIST_MAX_LIMIT,
  INVENTORY_LIST_DEFAULT_LIMIT,
  COMMERCIAL_LOCATION_TYPES,
  findStockLocation,
  listStockBalances,
  lockSellableQuantity,
  stockBalanceAt,
  listAvailabilityInZone,
  listStockMoves,
  encodeStockMovesCursor,
  decodeStockMovesCursor,
} from './stock-query.js';
export type {
  StockLocationRef,
  StockBalanceLine,
  StockBalanceAtLine,
  AvailabilityLocationLine,
  StockMoveEntry,
  StockMovesCursor,
} from './stock-query.js';

export { verifyStockLedger, rebuildStockBalances } from './ledger-reconciliation.js';
// P5-16 : transit des transferts par document et par paire, INV-STK-08 (réception sans document).
export { transferTransit, pairTransit, verifyTransferTransit } from './transfer-transit.js';
export type {
  TransitLine,
  TransferTransitBreach,
  TransferTransitVerification,
} from './transfer-transit.js';
export type {
  LedgerScope,
  LedgerVerification,
  LedgerMismatch,
  ConservationBreach,
  ToDeliverBreach,
  SettlementBreach,
  AllocationBreach,
  OvercommitBreach,
  NegativeBreach,
} from './ledger-reconciliation.js';

export {
  listTransfers,
  getTransfer,
  listLossDeclarations,
  listConsumptions,
  listInventoryCounts,
  getInventoryCount,
  listStockThresholds,
  listCostEntries,
} from './document-query.js';
export type {
  Page,
  PageRequest,
  TransferSummary,
  TransferLine,
  TransferDetail,
  LossDeclarationSummary,
  ConsumptionSummary,
  InventoryCountSummary,
  InventoryCountLine,
  InventoryCountDetail,
  StockThresholdStatus,
  CostEntry,
} from './document-query.js';

export {
  ensureSupplierLot,
  createStockLot,
  setStockLotStatus,
  setStockLotSellableFromRearing,
  findStockLot,
  listLotBalances,
  stockLotBalance,
} from './stock-lots.js';
export type {
  SupplierLotInput,
  StockLotInput,
  ProducedStockLotOrigin,
  StockLotSummary,
  LotBalanceLine,
} from './stock-lots.js';
export { virtualLocationId } from './virtual-locations.js';

// P4-09 : mouvements de vente d'un ensemble de lots (CA et marge d'un lot).
export { saleMovesOfLots, saleCostsInPeriod } from './sale-moves-query.js';
export type {
  SaleLineMove,
  SaleReturnMove,
  LotSaleMoves,
  SaleCostOfPeriod,
} from './sale-moves-query.js';

// P4-03 : règlement de la marchandise vendue (ADR-029).
export { returnSoldGoods, deliverSoldGoods, soldGoodsPosition } from './sale-settlement.js';
export type {
  SoldGoodsLine,
  SettleSoldGoodsInput,
  SettledMove,
  SoldGoodsPosition,
  SoldGoodsOriginPosition,
} from './sale-settlement.js';

// P7-02 : API de la production (ADR-026, ADR-027 ; 02-modules.md §11).
export {
  COST_OBJECT_TYPES,
  COST_TYPES,
  COST_SOURCE_TYPES,
  SPECIES_GROUPS,
  recordCostEntry,
  costObjectBalance,
  lotCostObjectStatus,
  siteOverheadMonthAllocated,
  lockOverheadPool,
  lockOverheadPools,
  overheadPeriodOf,
} from './cost-entries.js';
export type {
  CostObjectType,
  CostType,
  CostSourceType,
  SpeciesGroup,
  CostEntryInput,
  CostObjectBalance,
  OverheadPoolKey,
} from './cost-entries.js';
export { lotHeadcount, lotHeadDays, lotLostQuantity } from './lot-headcount.js';
export type { HeadcountScope } from './lot-headcount.js';
export {
  LOSS_CATEGORIES,
  LOSS_ATTACHMENT_OWNER_TYPE,
  declareLoss,
  lotMortalitySummary,
  findLossDeclaration,
  lossDeclarationLocator,
  lossesAwaitingPhoto,
} from './loss-declaration.js';
export type {
  LossCategory,
  DeclareLossInput,
  DeclareLossResult,
  LotMortalitySummary,
} from './loss-declaration.js';
export { recordConsumption, consumptionExists } from './consumption.js';
export type { RecordConsumptionInput, RecordConsumptionResult } from './consumption.js';
export {
  reverseDocumentMoves,
  reverseCostEntries,
  documentMoveCount,
} from './document-reversal.js';
export type { ReversedMove } from './document-reversal.js';

// P7-11 : agrégats pour les lectures de la production.
export {
  costObjectBreakdown,
  costObjectMonthly,
  costObjectConsumptionsByDay,
  costObjectConsumptionTotals,
  productionLotMortalityByDay,
} from './production-aggregates.js';
export type {
  CostBreakdownLine,
  MonthlyCostLine,
  ConsumptionLine,
  ConsumptionDayLine,
  MortalityDayLine,
} from './production-aggregates.js';

// Accueil par rôle (ADR-030).
export { stockHealth, recentLosses } from './home-metrics.js';

// P5-19 : métriques de distribution partagées (tableau de P5-20, accueil ; BR-ANA-009, AV-199).
export {
  allocationPositions,
  distributionFlowsOf,
  distributionKpisOf,
  locationFlows,
  sentByDestination,
} from './distribution-metrics.js';
export type {
  AllocationPosition,
  BusinessPeriod,
  DistributionKpis,
  LocationProductFlows,
  SentByDestinationLine,
} from './distribution-metrics.js';
// P5-20 : seuils de plusieurs emplacements (KPI-DIS-07).
export { stockThresholdsOf } from './document-query.js';
export type { StockHealth, RecentLosses } from './home-metrics.js';

// P5-17 : lectures des quotas d'appareil (`GET /allocations`, `/allocations/{id}`).
export {
  ALLOCATION_STATUSES,
  activeAllocationHolderDevices,
  activeAllocationTotals,
  findAllocation,
  listAllocationEntries,
  listAllocations,
} from './allocation-query.js';
export type {
  ActiveAllocationTotal,
  AllocationEntryLine,
  AllocationStatus,
  AllocationSummary,
} from './allocation-query.js';
// P5-17 (AV-190) : anomalies de stock encore présentes, avant la clôture manuelle de leur conflit.
export { hasNegativeStock, isAllocationOvercommitted } from './stock-conflict-conditions.js';

// P8-11 (ADR-044 §3 ; BR-FIN-044, KPI-FIN-08 ; AT-041) : valeur des pertes d'une période.
export { LOSS_SUMMARY_GROUPS, dayLossByLocation, lossValueSummary } from './loss-summary.js';
export type { DayLossLine, LossSummaryGroup, LossSummaryLine } from './loss-summary.js';
export {
  COVERAGE_SALES_DAYS,
  countedMortalityOfLots,
  inventoryVarianceSummary,
  mortalitySummary,
  stockCoverage,
} from './stock-indicators.js';
export type {
  InventoryVariance,
  MortalityDay,
  MortalitySummary,
  StockCoverageLine,
} from './stock-indicators.js';

// P9-27 (AV-462 choix (b), AV-476 ; KPI-PRD-04) : aliment consommé par objet de coût sur une période.
export { feedConsumedByCostObjects } from './feed-consumption.js';

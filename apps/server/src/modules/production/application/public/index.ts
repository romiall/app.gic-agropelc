/** API publique du module `production` (lectures, P7-11 ; transport `production-api/`). */
export {
  PRODUCTION_LIST_DEFAULT_LIMIT,
  PRODUCTION_LIST_MAX_LIMIT,
  PRODUCTION_DAILY_MAX_DAYS,
  listProductionLots,
  getProductionLot,
  productionLotDaily,
  listEggCollections,
  getEggCollection,
  listIncubationBatches,
  getIncubationBatch,
  listSlaughters,
  getSlaughter,
  listOverheadAllocations,
} from './production-query.js';
export type {
  Page,
  ProductionLotSummary,
  ProductionLotDetail,
  ProductionLotFilter,
  LotEntrySummary,
  WeighingSummary,
  LotDay,
  EggCollectionSummary,
  EggCollectionFilter,
  IncubationBatchSummary,
  IncubationBatchDetail,
  IncubationEventSummary,
  IncubationFilter,
  SlaughterSummary,
  SlaughterFilter,
  OverheadAllocationSummary,
  OverheadAllocationFilter,
} from './production-query.js';

export { productionOverview } from './home-metrics.js';
export type { ProductionOverview } from './home-metrics.js';

// P8-11 (ADR-044 §1, AV-279) : lots de stock des produits d'abattage d'un lot (CA de la marge de lot).
export { slaughterStockLotIds } from './lot-sale-lots.js';
export {
  REARING_LOT_STATUSES,
  cumulativeMortalityRate,
  eggSummary,
  hatchRate,
} from './production-indicators.js';
export type { CumulativeMortality, EggSummary, HatchRate } from './production-indicators.js';

// P9-27 (AV-462 choix (b), AV-475 à AV-478 ; KPI-PRD-04, 05 et 09) : aliment consommé, poids moyen, coût par tête.
export {
  costPerHead,
  feedConsumption,
  latestWeighing,
  referenceLotType,
} from './lot-indicators.js';
export type {
  CostPerHead,
  CostPerHeadLot,
  CostPerHeadType,
  FeedConsumption,
  LatestWeighing,
  LatestWeighingLot,
  LatestWeighingType,
} from './lot-indicators.js';

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

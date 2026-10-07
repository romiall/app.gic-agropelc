/** API publique du module `catalog` (01-architecture-logicielle.md §3, règle 1). */
export {
  listProducts,
  listUnits,
  findUnit,
  findProductUnit,
  findSalesChannel,
  listReasonCodes,
  findReasonCode,
  findReasonCodeByCode,
  findProductForPricing,
  findProductLotTracking,
  findProduct,
  findProductByCode,
  findStandardUnitCostXaf,
} from './catalog-query.js';
export type {
  ProductSummary,
  ProductUnitSummary,
  UnitSummary,
  ReasonCodeSummary,
  SalesChannelSummary,
} from './catalog-query.js';

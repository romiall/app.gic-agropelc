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
  listStandardCosts,
  SYSTEM_SALES_CHANNEL_CODES,
} from './catalog-query.js';
export type {
  StandardCostVersion,
  ProductSummary,
  ProductUnitSummary,
  UnitSummary,
  ReasonCodeSummary,
  SalesChannelSummary,
} from './catalog-query.js';

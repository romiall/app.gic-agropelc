/** API publique du module `catalog` (01-architecture-logicielle.md §3, règle 1). */
export {
  listProducts,
  listUnits,
  listReasonCodes,
  findProductForPricing,
} from './catalog-query.js';
export type { ProductSummary, UnitSummary, ReasonCodeSummary } from './catalog-query.js';

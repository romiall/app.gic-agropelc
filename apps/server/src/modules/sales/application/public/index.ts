/**
 * API publique du module `sales` (01-architecture-logicielle.md §3, règle 1) : seul point d'import
 * autorisé depuis un autre module ou depuis le transport de lecture (P4-10). P4-04 : encours client.
 */
export { customerOutstandingXaf } from './receivables.js';
export {
  cashedSummary,
  receivablesSummary,
  recentSales,
  salesDailySeries,
  salesPeriodSummary,
  suspectPaymentsCount,
} from './home-metrics.js';
export type {
  CashedSummary,
  ReceivablesSummary,
  RecentSale,
  SalesDay,
  SalesPeriodSummary,
} from './home-metrics.js';

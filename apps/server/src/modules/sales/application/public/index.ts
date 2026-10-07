/**
 * API publique du module `sales` (01-architecture-logicielle.md §3, règle 1) : seul point d'import
 * autorisé depuis un autre module ou depuis le transport de lecture (P4-10). P4-04 : encours client.
 */
export { customerOutstandingXaf, listReceivables, summarizeReceivables } from './receivables.js';
export type { ReceivableLine, ReceivableFilter, ReceivableAgingSummary } from './receivables.js';
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
// P4-09 : chiffre d'affaires, coût des ventes et marges (BR-FIN-042, 043).
export { lotRevenue, periodRevenue, periodProductQuantity } from './revenue.js';
export type { LotRevenue, LotRevenueMonth, PeriodRevenue, RevenueFilter } from './revenue.js';
// P4-10 : lectures des commandes, ventes, livraisons et encaissements.
export {
  SALES_LIST_DEFAULT_LIMIT,
  SALES_LIST_MAX_LIMIT,
  getOrder,
  getPayment,
  getSale,
  listDeliveryNotes,
  listOrders,
  listPayments,
  listSales,
} from './sales-query.js';
export type {
  DeliveryNoteSummary,
  OrderDetail,
  OrderLineView,
  OrderSummary,
  PaymentDetail,
  PaymentSummary,
  SaleCancellationView,
  SaleDetail,
  SaleLineView,
  SalePaymentView,
  SaleSummary,
  SalesPage,
  ListScope,
  SalesResource,
} from './sales-query.js';

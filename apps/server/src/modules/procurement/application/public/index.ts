/** API publique du module `procurement`. */
export { listSuppliers } from './supplier-query.js';
export type { SupplierSummary } from './supplier-query.js';

export {
  PROCUREMENT_LIST_DEFAULT_LIMIT,
  PROCUREMENT_LIST_MAX_LIMIT,
  listPurchaseRequests,
  getPurchaseRequest,
  listPurchaseOrders,
  getPurchaseOrder,
  purchaseOrderMatching,
  listGoodsReceipts,
  getGoodsReceipt,
} from './document-query.js';
export type {
  Page,
  PurchaseRequestLine,
  PurchaseRequestSummary,
  PurchaseRequestFilter,
  PurchaseOrderLine,
  PurchaseOrderSummary,
  PurchaseOrderFilter,
  OrderMatchingLine,
  OrderMatching,
  GoodsReceiptLine,
  GoodsReceiptSummary,
  GoodsReceiptFilter,
} from './document-query.js';

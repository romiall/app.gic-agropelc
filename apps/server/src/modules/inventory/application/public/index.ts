/** API publique du module `inventory` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module (`procurement`, `production`, `sales`…,
 * à partir des phases qui en dépendent — le graphe les y autorise déjà) et depuis le
 * transport `inventory-api/` (lectures HTTP, P2-05). */
export {
  recordStockMove,
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
export type {
  LedgerScope,
  LedgerVerification,
  LedgerMismatch,
  ConservationBreach,
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

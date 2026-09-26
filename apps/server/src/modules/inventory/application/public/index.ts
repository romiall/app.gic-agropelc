/** API publique du module `inventory` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module (`procurement`, `production`, `sales`…,
 * à partir des phases qui en dépendent — le graphe les y autorise déjà). */
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

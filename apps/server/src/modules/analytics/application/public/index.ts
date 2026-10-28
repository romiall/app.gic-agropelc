/**
 * API publique du module `analytics` (P9-14) : l'étendue exacte des lignes lisibles et sa compilation en clause
 * `WHERE`, le compilateur et l'exécution de l'explorateur, ses limites et son journal. Le module lit les autres par
 * des vues `analytics_f_*` ; personne ne l'appelle hors de la couche de transport (`analytics-api/`) et des tâches
 * d'instantanés et d'export.
 */
export {
  DEFAULT_MAX_SCOPE_CANDIDATES,
  EMPTY_SCOPE,
  SCOPE_PROBE_ID,
  resolveExactScope,
} from '../scope/exact-scope.js';
export type {
  ExactScope,
  ExactScopeInput,
  ExactScopeOptions,
  ScopeClause,
} from '../scope/exact-scope.js';
export { scopeCondition, scopeConditions } from '../scope/scope-sql.js';
export type { ScopedDataset } from '../scope/scope-sql.js';
export { compileExploration, escapeLike } from '../query/compile-exploration.js';
export type {
  CompiledColumn,
  CompiledExploration,
  CompileOptions,
  ExplorationValue,
} from '../query/compile-exploration.js';
export {
  DEFAULT_EXPLORER_LIMITS,
  EXPLORER_SETTING_KEYS,
  readExplorerLimits,
} from '../query/limits.js';
export type { ExplorerLimits } from '../query/limits.js';
export { recordQueryLog } from '../query/query-log.js';
export type { QueryLogEntry, QueryOutcome } from '../query/query-log.js';
export { acquireQuerySlot, querySlotName, releaseQuerySlot } from '../query/query-slots.js';
export {
  ExplorationLimitError,
  executeExploration,
  runExploration,
} from '../query/run-exploration.js';
export type { ExplorationLimit, ExplorationResult } from '../query/run-exploration.js';
export {
  KPI_DATASET,
  KPI_ENTITY_TYPE,
  SNAPSHOT_PERIOD_KEYS,
  SNAPSHOT_REPUBLISH_MS,
  activeSnapshotUsers,
  deleteSnapshotsExcept,
  deleteSnapshotsOfInactiveUsers,
  listSnapshotsOf,
  readSnapshot,
  saveSnapshot,
  snapshotEntityId,
  snapshotPair,
} from '../snapshots/snapshot-store.js';
export type {
  SnapshotKey,
  SnapshotPeriodKey,
  StoredSnapshot,
} from '../snapshots/snapshot-store.js';

// P9-19 : vues sauvegardées (lecture avec exécutabilité) ; P9-20 : exports (lecture du demandeur, clé du fichier).
export { VIEWS_LIST_LIMIT, listReadableViews, readReadableView } from '../views/view-read.js';
export type { ReadableView, ViewExecutability } from '../views/view-read.js';
export { exportStorageKey, exportsPage, readExport } from '../exports/export-store.js';
export type { ExportFormat, ExportStatus, StoredExport } from '../exports/export-store.js';
// P9-25 (EX-3) : réglages des exports et droits revérifiés au téléchargement.
export { readExportSettings } from '../exports/export-settings.js';
export { missingDownloadPermission } from '../exports/export-download-rights.js';
export { explorationDefinitionFrom } from '../query/exploration-definition.js';

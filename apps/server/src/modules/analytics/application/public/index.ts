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

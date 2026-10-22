/**
 * API publique du module `analytics` (P9-14) : l'étendue exacte des lignes lisibles et sa compilation en clause
 * `WHERE`. Le module lit les autres par des vues `analytics_f_*` ; personne ne l'appelle hors de la couche de
 * transport (`analytics-api/`) et des tâches d'instantanés.
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

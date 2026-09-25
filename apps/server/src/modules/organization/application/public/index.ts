/**
 * API publique du module `organization` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module. P0-11 : lecture des paramètres système
 * historisés seulement — les tables sites/zones/emplacements/équipes sont lues directement
 * par clé étrangère par les modules qui en dépendent (`identity`, 03-graphe-dependances.md
 * note 1), sans détour par ce module pour de simples jointures.
 */
export { listSettingHistory, currentSettingValue } from './setting-query.js';
export type { SettingScopeType, SettingVersion, SettingFilter } from './setting-query.js';

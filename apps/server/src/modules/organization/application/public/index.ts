/**
 * API publique du module `organization` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module. P0-11 : lecture des paramètres système
 * historisés seulement — les tables sites/zones/emplacements/équipes sont lues directement
 * par clé étrangère par les modules qui en dépendent (`identity`, 03-graphe-dependances.md
 * note 1), sans détour par ce module pour de simples jointures.
 */
export { listSettingHistory, currentSettingValue } from './setting-query.js';
export type { SettingScopeType, SettingVersion, SettingFilter } from './setting-query.js';
export { listSiteIdsInZones } from './site-query.js';
export {
  findPosConfigBySite,
  findPosConfigBySalesLocation,
  findPosConfigByDesignatedDevice,
} from './pos-query.js';
export type { PosConfig } from './pos-query.js';
export { listTeamMembersAt, listManagedTeamMembersAt, listTeamsOfUserAt } from './team-query.js';

// P5-05 : gardes de désactivation d'un emplacement (INV-STK-07), inversion de dépendance.
export { LOCATION_DEACTIVATION_GUARD_REGISTRY } from '../deactivation-guard-registry.provider.js';
export { LocationDeactivationGuardRegistry } from '../deactivation-guard-registry.js';
export type {
  LocationDeactivationBlock,
  LocationDeactivationGuard,
} from '../deactivation-guard-registry.js';

// P4-03 : emplacement « à livrer » d'un site (ADR-028 §1).
export { ensureToDeliverLocation, ToDeliverLocationError } from './to-deliver-location.js';
export type { ToDeliverLocation } from './to-deliver-location.js';

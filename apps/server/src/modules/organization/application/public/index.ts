/**
 * API publique du module `organization` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module. P0-11 : lecture des paramètres système
 * historisés seulement — les tables sites/zones/emplacements/équipes sont lues directement
 * par clé étrangère par les modules qui en dépendent (`identity`, 03-graphe-dependances.md
 * note 1), sans détour par ce module pour de simples jointures.
 */
export { listSettingHistory, currentSettingValue } from './setting-query.js';
export { siteThenGlobalSetting } from './site-setting.js';
export type { SettingScopeType, SettingVersion, SettingFilter } from './setting-query.js';
export { listSiteIdsInZones, listZoneIdsWithDescendants } from './site-query.js';
// P5-17 : lectures de la structure pour la couche de transport (`GET /sites`, `/locations`, `/points-of-sale`).
export { findSite, listLocations, listPointsOfSale, listSites } from './structure-query.js';
export type { LocationSummary, PointOfSaleSummary, SiteSummary } from './structure-query.js';
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

// P5-23 (AV-195 (2), ADR-040) : garde d'un emplacement à un instant (historique des gardes).
export { custodyAt } from './custody-query.js';
export type { CustodyAt } from './custody-query.js';

// P5-23 (AV-195, AV-230) : gardes de configuration d'un PDV, même inversion de dépendance.
export { POS_CONFIGURATION_GUARD_REGISTRY } from '../pos-configuration-guard-registry.provider.js';
export { PosConfigurationGuardRegistry } from '../pos-configuration-guard-registry.js';
export type {
  PosConfigurationBlock,
  PosConfigurationChange,
  PosConfigurationGuard,
  PosCustody,
} from '../pos-configuration-guard-registry.js';

// P4-03 : emplacement « à livrer » d'un site (ADR-028 §1).
export { ensureToDeliverLocation, ToDeliverLocationError } from './to-deliver-location.js';
export type { ToDeliverLocation } from './to-deliver-location.js';

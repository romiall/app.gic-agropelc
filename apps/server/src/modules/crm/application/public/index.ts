/**
 * API publique du module `crm` (01-architecture-logicielle.md §3, règle 1) : seul point
 * d'import autorisé depuis un autre module (`sales`, `integrations`) ou un transport (`crm-api/`).
 * P3-04 : conversion prospect → client, appelée par `sales` à la confirmation d'une vente (P4) ;
 * P3-06 : lectures des comptes, visites, interactions, objectifs et de l'effort commercial.
 */
export { convertOnConfirmedSale, markConversionReverted } from './conversion.js';
export type { ConversionOutcome } from './conversion.js';

export {
  CRM_LIST_DEFAULT_LIMIT,
  CRM_LIST_MAX_LIMIT,
  absorbedCustomerIds,
  customerResourceOf,
  findCustomerByPhone,
  getCustomer,
  listCustomerAssignments,
  listCustomerStageHistory,
  listCustomers,
} from './customer-query.js';
export type {
  AssignmentPeriod,
  CustomerListFilter,
  CustomerSummary,
  Page,
  StageChange,
} from './customer-query.js';
export {
  hasCommercialRoleAt,
  lockCustomerAccount,
  ownerOfCustomerAt,
} from './customer-attribution.js';
export { portfolioHealth } from './home-metrics.js';
export type { PortfolioHealth } from './home-metrics.js';
export { commercialEffort, listInteractions, listTargets, listVisits } from './activity-query.js';
export type {
  ActivityFilter,
  CommercialEffort,
  InteractionSummary,
  TargetSummary,
  VisitSummary,
} from './activity-query.js';
/** P4-11 : l'encours d'un compte change avec ses ventes et encaissements (jeu `customers`). */
export { emitCustomerChange } from '../sync-changes.js';

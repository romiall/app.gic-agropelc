/**
 * API publique du module `crm` (01-architecture-logicielle.md §3, règle 1) : seul point
 * d'import autorisé depuis un autre module (`sales`, `integrations`). P3-04 : conversion
 * prospect → client, appelée par `sales` à la confirmation d'une vente (P4).
 */
export { convertOnConfirmedSale, markConversionReverted } from './conversion.js';
export type { ConversionOutcome } from './conversion.js';

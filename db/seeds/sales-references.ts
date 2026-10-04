/**
 * Politiques de contrôle par défaut des ventes et des encaissements (P4-02 2/2). Le seed
 * n'insère que les codes absents — jamais de réécriture d'une politique modifiée depuis. Sans
 * elles, l'opération concernée serait refusée (`CONTROL_POLICY_MISSING`).
 *
 * - `PRICE_OVERRIDE` : dérogation de prix au-delà du plafond du rôle, validée a posteriori
 *   (AV-026, BR-VEN-015) ;
 * - `SALE_CANCELLATION` : annulation d'une vente hors du délai direct, validée par un responsable
 *   (AV-030, BR-VEN-028) ;
 * - `CREDIT_LIMIT_EXCEEDED` : vente à crédit au-delà du plafond, appliquée hors ligne puis validée
 *   (AV-028, BR-VEN-025) ;
 * - `PAYMENT_CANCELLATION` et `PAYMENT_DUPLICATE` : annulation d'un encaissement, décision de la
 *   Finance sur un doublon `SUSPECT_DUPLICATE` (AV-056) — approbateur `sales.payment.cancel`.
 * Aucune condition par défaut (`{}`) : chaque opération de ces types est soumise à validation ;
 * les seuils éventuels se règlent ensuite dans la politique (DÉDUIT).
 */
import type { ControlPolicySeed } from './production-references.js';

export const SALES_CONTROL_POLICIES: readonly ControlPolicySeed[] = [
  {
    code: 'PRICE_OVERRIDE_DEFAULT',
    operationType: 'PRICE_OVERRIDE',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'sales.price_override.approve',
    approverScope: 'ALL',
    ref: 'AV-026',
  },
  {
    code: 'SALE_CANCELLATION_DEFAULT',
    operationType: 'SALE_CANCELLATION',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'sales.sale_cancel.approve',
    approverScope: 'ALL',
    ref: 'AV-030',
  },
  {
    code: 'CREDIT_LIMIT_EXCEEDED_DEFAULT',
    operationType: 'CREDIT_LIMIT_EXCEEDED',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'sales.credit_limit_exceed.approve',
    approverScope: 'ALL',
    ref: 'AV-028',
  },
  {
    code: 'PAYMENT_CANCELLATION_DEFAULT',
    operationType: 'PAYMENT_CANCELLATION',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'sales.payment.cancel',
    approverScope: 'ALL',
    ref: 'AV-056',
  },
  {
    code: 'PAYMENT_DUPLICATE_DEFAULT',
    operationType: 'PAYMENT_DUPLICATE',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'sales.payment.cancel',
    approverScope: 'ALL',
    ref: 'AV-056',
  },
];

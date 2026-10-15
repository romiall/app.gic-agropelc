/**
 * Politiques de contrôle par défaut des achats (MP-11, revue adverse : sur une base neuve, toute demande
 * d'achat, tout bon de commande au-delà du seuil, toute réception sans bon de commande ou en quarantaine
 * et toute annulation de réception étaient refusés, `CONTROL_POLICY_MISSING`). Le seed n'insère que les
 * codes absents — jamais de réécriture d'une politique modifiée depuis.
 *
 * Valeurs (AV-294, DÉDUIT des règles et des permissions de 01-rbac) : aucune condition (`{}`), chaque
 * opération de ces types est soumise à validation ; le seuil du bon de commande reste le paramètre
 * `procurement.po_approval_threshold_xaf` (BR-APP-005). Approbateurs, portée `ALL` :
 * - `PURCHASE_REQUEST` : `procurement.request.approve` (Direction, Resp. achats ; BR-APP-003) ;
 * - `PURCHASE_ORDER` : `procurement.order.approve` (Direction ; BR-APP-005) ;
 * - `RECEIPT_WITHOUT_PO` et `RECEIPT_QUARANTINE` : `procurement.receipt_exception.approve` (Direction,
 *   Resp. achats ; AV-095, AV-096) ;
 * - `RECEIPT_CANCELLATION` : `procurement.receipt.cancel` (Direction, Resp. achats).
 */
import type { ControlPolicySeed } from './production-references.js';

export const PROCUREMENT_CONTROL_POLICIES: readonly ControlPolicySeed[] = [
  {
    code: 'PURCHASE_REQUEST_DEFAULT',
    operationType: 'PURCHASE_REQUEST',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'procurement.request.approve',
    approverScope: 'ALL',
    ref: 'AV-294',
  },
  {
    code: 'PURCHASE_ORDER_DEFAULT',
    operationType: 'PURCHASE_ORDER',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'procurement.order.approve',
    approverScope: 'ALL',
    ref: 'AV-294',
  },
  {
    code: 'RECEIPT_WITHOUT_PO_DEFAULT',
    operationType: 'RECEIPT_WITHOUT_PO',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'procurement.receipt_exception.approve',
    approverScope: 'ALL',
    ref: 'AV-096',
  },
  {
    code: 'RECEIPT_QUARANTINE_DEFAULT',
    operationType: 'RECEIPT_QUARANTINE',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'procurement.receipt_exception.approve',
    approverScope: 'ALL',
    ref: 'AV-095',
  },
  {
    code: 'RECEIPT_CANCELLATION_DEFAULT',
    operationType: 'RECEIPT_CANCELLATION',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'procurement.receipt.cancel',
    approverScope: 'ALL',
    ref: 'AV-294',
  },
];

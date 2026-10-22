/**
 * Politiques de contrôle par défaut du stock et du pointage (MP-12, AV-318 ; vérification
 * contradictoire du 22/10/2026). Sur une base issue du seul seed, trois opérations étaient refusées
 * `CONTROL_POLICY_MISSING` : la réception d'un transfert avec écart (un fait physique, même hors
 * ligne), un inventaire d'écart non biologique au-dessus du seuil, et la dérogation de pointage. Le
 * seed n'insère que les codes absents — jamais de réécriture d'une politique modifiée depuis.
 *
 * Valeurs (DÉDUIT des permissions de 01-rbac, comme les politiques d'achat d'AV-294) : aucune condition
 * (`{}`), chaque opération de ces types est soumise à validation ; le seuil des inventaires reste le
 * paramètre `inventory.count_approval_threshold_xaf`. Portée `ALL` de la politique : la portée exacte
 * de chaque approbateur est celle de son affectation, jugée par demande (file de validation).
 * - `TRANSFER_DISCREPANCY` : `inventory.transfer_discrepancy.approve` (Direction et Resp. production
 *   partout, Resp. ferme et magasinier sur leur site) ;
 * - `INVENTORY_ADJUSTMENT` : `inventory.count.approve` (Direction, Finance, Resp. production, Resp.
 *   ferme sur son site, Resp. commercial sur sa zone) ;
 * - `CHECKIN_OVERRIDE` : `fieldwork.checkin_override.approve` (Direction, Resp. commercial pour son
 *   équipe ; BR-TER-005).
 */
import type { ControlPolicySeed } from './production-references.js';

export const STOCK_FIELDWORK_CONTROL_POLICIES: readonly ControlPolicySeed[] = [
  {
    code: 'TRANSFER_DISCREPANCY_DEFAULT',
    operationType: 'TRANSFER_DISCREPANCY',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'inventory.transfer_discrepancy.approve',
    approverScope: 'ALL',
    ref: 'AV-318',
  },
  {
    code: 'INVENTORY_ADJUSTMENT_DEFAULT',
    operationType: 'INVENTORY_ADJUSTMENT',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'inventory.count.approve',
    approverScope: 'ALL',
    ref: 'AV-318',
  },
  {
    code: 'CHECKIN_OVERRIDE_DEFAULT',
    operationType: 'CHECKIN_OVERRIDE',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'fieldwork.checkin_override.approve',
    approverScope: 'ALL',
    ref: 'AV-318',
  },
];

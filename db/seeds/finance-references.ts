/**
 * Référentiels de trésorerie initiaux (P4-02) et politiques de contrôle de la caisse (P5-03). Moyens de paiement : décision AV-056 du
 * 30/09/2026 (espèces, Orange Money, MTN MoMo, virement, chèque ; liste modifiable ensuite). Le
 * seed n'insère que les codes absents — jamais de réécriture d'un libellé modifié depuis.
 * Référence exigée et compte crédité par défaut : DÉDUITS (référence de transaction pour le
 * mobile money et le virement, AV-056 ; numéro du chèque ; espèces vers la caisse de
 * l'encaisseur, BR-FIN-002).
 */
import type { ControlPolicySeed } from './production-references.js';
export interface PaymentMethodSeed {
  readonly code: string;
  readonly label: string;
  readonly requiresReference: boolean;
  readonly defaultAccountType:
    'CAISSE_PDV' | 'CAISSE_UTILISATEUR' | 'CAISSE_CENTRALE' | 'MOBILE_MONEY' | 'BANQUE';
}

export const PAYMENT_METHODS: readonly PaymentMethodSeed[] = [
  {
    code: 'ESPECES',
    label: 'Espèces',
    requiresReference: false,
    defaultAccountType: 'CAISSE_UTILISATEUR',
  },
  {
    code: 'MOBILE_MONEY_ORANGE',
    label: 'Orange Money',
    requiresReference: true,
    defaultAccountType: 'MOBILE_MONEY',
  },
  {
    code: 'MOBILE_MONEY_MTN',
    label: 'MTN Mobile Money',
    requiresReference: true,
    defaultAccountType: 'MOBILE_MONEY',
  },
  {
    code: 'VIREMENT',
    label: 'Virement bancaire',
    requiresReference: true,
    defaultAccountType: 'BANQUE',
  },
  { code: 'CHEQUE', label: 'Chèque', requiresReference: true, defaultAccountType: 'BANQUE' },
];

/**
 * Politiques de contrôle de la caisse (P5-03 ; ADR-032, AV-057, AV-153). Sans elles, une session
 * avec écart ou une remise avec écart serait refusée (`CONTROL_POLICY_MISSING`). Le seed n'insère que
 * les codes absents. Aucune condition par défaut (`{}`) : tout écart est soumis à validation de la
 * Finance (AV-057) ; une tolérance se règle par le paramètre `finance.cash_variance_tolerance_xaf`.
 * Approbateur : `finance.cash_session.validate` (Finance et Direction, portée ALL).
 */
export const FINANCE_CONTROL_POLICIES: readonly ControlPolicySeed[] = [
  {
    code: 'CASH_VARIANCE_DEFAULT',
    operationType: 'CASH_VARIANCE',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'finance.cash_session.validate',
    approverScope: 'ALL',
    ref: 'AV-057',
  },
  {
    code: 'CASH_TRANSFER_DISCREPANCY_DEFAULT',
    operationType: 'CASH_TRANSFER_DISCREPANCY',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'finance.cash_session.validate',
    approverScope: 'ALL',
    ref: 'AV-153',
  },
];

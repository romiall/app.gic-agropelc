/**
 * Référentiels de trésorerie initiaux (P4-02). Moyens de paiement : décision AV-056 du
 * 30/09/2026 (espèces, Orange Money, MTN MoMo, virement, chèque ; liste modifiable ensuite). Le
 * seed n'insère que les codes absents — jamais de réécriture d'un libellé modifié depuis.
 * Référence exigée et compte crédité par défaut : DÉDUITS (référence de transaction pour le
 * mobile money et le virement, AV-056 ; numéro du chèque ; espèces vers la caisse de
 * l'encaisseur, BR-FIN-002).
 */
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

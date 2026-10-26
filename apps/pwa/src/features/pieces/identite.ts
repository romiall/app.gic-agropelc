/**
 * Identité de GIC AGROPELC imprimée dans l'en-tête des pièces : copie de
 * `pieces-papier/charte/identite.json` (vérifiée par un test). Une valeur vide donne la ligne
 * pointillée du papier, à compléter à la main ; on n'invente jamais une valeur. Rendre ces valeurs
 * modifiables dans l'application est l'objet d'AV-324.
 */
export interface Identite {
  readonly raison_sociale: string;
  readonly forme_juridique: string;
  readonly siege: string;
  readonly bp: string;
  readonly ville: string;
  readonly telephones: string;
  readonly email: string;
  readonly site_web: string;
  readonly rccm: string;
  readonly niu: string;
  readonly regime_fiscal: string;
  readonly banque: string;
  readonly compte_bancaire: string;
  readonly mobile_money: string;
  readonly capital: string;
  readonly representant_legal: string;
}

export const IDENTITE: Identite = {
  raison_sociale: 'GIC AGROPELC',
  forme_juridique: '',
  siege: '',
  bp: '7633 Douala',
  ville: 'Douala',
  telephones: '+237 699 348 371',
  email: '',
  site_web: '',
  rccm: '24/034CMR/LT/01/GIC/004000/004000002',
  niu: 'M032416655486P',
  regime_fiscal: '',
  banque: '',
  compte_bancaire: '',
  mobile_money: '',
  capital: '',
  representant_legal: '',
};

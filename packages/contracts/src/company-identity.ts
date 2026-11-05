/**
 * Identité de la société imprimée sur les pièces papier (AV-324 (a), AV-451 (c)) : les rubriques de l'en-tête
 * (raison sociale, siège, boîte postale, RCCM, NIU…), les coordonnées de règlement de la facture et le régime de TVA
 * ne sont plus des constantes de la PWA mais des paramètres système (`organization.system_settings`, historisés,
 * visibles des appareils). Une rubrique vide s'imprime en pointillés, à compléter à la main : on n'invente jamais
 * une valeur.
 *
 * Ce fichier est la seule définition de la correspondance entre une rubrique de l'identité et sa clé de paramètre :
 * le catalogue, le semis, l'écran des paramètres et les pièces imprimées s'y réfèrent.
 */

/** Rubrique de l'identité (noms de `pieces-papier/charte/identite.json`) → clé du paramètre qui la porte. */
export const COMPANY_IDENTITY_SETTINGS = {
  raison_sociale: 'company.legal_name',
  forme_juridique: 'company.legal_form',
  siege: 'company.head_office',
  bp: 'company.po_box',
  ville: 'company.city',
  telephones: 'company.phones',
  email: 'company.email',
  site_web: 'company.website',
  rccm: 'company.rccm',
  niu: 'company.niu',
  regime_fiscal: 'company.tax_system',
  banque: 'company.bank',
  compte_bancaire: 'company.bank_account',
  mobile_money: 'company.mobile_money',
  capital: 'company.share_capital',
  representant_legal: 'company.legal_representative',
} as const;

export type CompanyIdentityField = keyof typeof COMPANY_IDENTITY_SETTINGS;

/** Régime de TVA coché sur la facture (AV-451) : `NOT_SET` laisse les deux cases à cocher à la main. */
export const COMPANY_VAT_REGIMES = ['NOT_SET', 'VAT_APPLICABLE', 'VAT_EXEMPT'] as const;
export type CompanyVatRegime = (typeof COMPANY_VAT_REGIMES)[number];

export const COMPANY_VAT_REGIME_SETTING = 'company.vat_regime';
export const COMPANY_VAT_MENTION_SETTING = 'company.vat_exemption_mention';

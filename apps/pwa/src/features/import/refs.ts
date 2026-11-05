/**
 * Ce que le contrôle d'un fichier a besoin de savoir de l'application (RP-2, PP-C ; AV-508) : listes plates, sans
 * dépendance à la base locale ni au réseau, pour que le contrôle soit pur et testable. L'écran les remplit avec les
 * référentiels de l'appareil et les créations encore dans l'outbox (une création en attente occupe déjà son code).
 */
import type { SlipContext } from '../pieces/report-form.js';
import type { CustomerData } from '../sales/types.js';

export interface ImportCategory {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** Zone active proposée pour un client, libellée par son chemin (« ville › quartier »). */
export interface ImportZone {
  readonly id: string;
  readonly label: string;
}

/** Site actif auquel un client peut être rattaché (BR-CRM-003). */
export interface ImportSite {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface ImportRefs {
  /** Utilisateur qui charge : ses identifiants dérivés ne se confondent pas avec ceux d'un autre (`authorImportId`). */
  readonly authorUserId: string;
  /** Codes des unités du catalogue (une unité n'est jamais créée par un chargement de produits). */
  readonly unitCodes: ReadonlySet<string>;
  /** Catégories de produit connues de l'appareil. */
  readonly categories: readonly ImportCategory[];
  /**
   * Catégories dont la création est en attente dans l'outbox : code → identifiant de l'agrégat que cette commande
   * crée (celui d'un chargement précédent, ou celui tiré par l'écran du catalogue — jamais recalculé ici).
   */
  readonly pendingCategoryIds: ReadonlyMap<string, string>;
  /** Codes de produit pris : connus de l'appareil ou dont la création est en attente. */
  readonly productCodes: ReadonlySet<string>;
  /** Codes de fournisseur pris : connus de l'appareil ou dont la création est en attente. */
  readonly supplierCodes: ReadonlySet<string>;
  /** Zones actives, avec leur chemin. */
  readonly zones: readonly ImportZone[];
  /** Sites actifs (colonne « Site de rattachement » des clients). */
  readonly sites: readonly ImportSite[];
  /**
   * Site de rattachement des clients du fichier qui n'en nomment pas : celui du point de vente de l'utilisateur,
   * comme à l'écran de saisie. Absent pour un commercial (le compte lui est rattaché) ou sans point de vente.
   */
  readonly defaultHomeSiteId?: string;
  /**
   * Vrai : l'utilisateur n'est pas commercial, un compte créé sans commercial titulaire doit donc être rattaché à un
   * site (BR-CRM-003) — le serveur le refuserait sinon.
   */
  readonly homeSiteRequired: boolean;
  /** Catégories de client actives. */
  readonly customerCategories: readonly ImportCategory[];
  /** Comptes clients de l'appareil (détection des doublons par téléphone, comme à l'écran). */
  readonly customers: readonly CustomerData[];
  /** Téléphones normalisés de comptes dont la création est en attente dans l'outbox. */
  readonly pendingCustomerPhones: ReadonlySet<string>;
  /** Indicatif national des numéros saisis sans indicatif (`crm.phone_default_country_code`, 237 par défaut). */
  readonly phoneCountryCode: string;
  /**
   * Pièces papier (PP-C) : les référentiels de l'appareil tels que les lit l'écran de report, avec l'utilisateur, ses
   * rôles et l'instant du contrôle. Absent : les pièces ne sont pas chargeables (essais sans appareil).
   */
  readonly slipContext?: SlipContext;
  /** Pièces déjà reportées depuis cet appareil et non refusées : `TYPE|numéro` (jamais reportées deux fois). */
  readonly reportedSlips: ReadonlySet<string>;
  /**
   * Feuilles de présence (PP-E) déjà dans l'outbox de l'appareil et non refusées : identifiants de leur agrégat (une
   * feuille de même contenu n'est pas reportée deux fois).
   */
  readonly pendingPresenceSheets: ReadonlySet<string>;
  /** Motif d'antidatage commun, saisi à l'écran, pour les pièces de plus de 24 h dont le fichier n'en donne pas. */
  readonly defaultBackdatedReason?: string;
}

export const EMPTY_IMPORT_REFS: ImportRefs = {
  authorUserId: '',
  unitCodes: new Set(),
  categories: [],
  pendingCategoryIds: new Map(),
  productCodes: new Set(),
  supplierCodes: new Set(),
  zones: [],
  sites: [],
  homeSiteRequired: false,
  customerCategories: [],
  customers: [],
  pendingCustomerPhones: new Set(),
  phoneCountryCode: '237',
  reportedSlips: new Set(),
  pendingPresenceSheets: new Set(),
};

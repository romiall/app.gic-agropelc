/**
 * Types de données chargeables par fichier CSV (RP-2 ; AV-072, AV-508) : catégories de produit, produits,
 * fournisseurs. Chaque type reprend les contrôles et la charge de l'écran de saisie correspondant
 * (`catalog.ts`, `suppliers.ts`) : ce que l'écran refuse, le chargement le refuse ; ce que l'écran envoie, le
 * chargement l'envoie. Les identifiants sont stables (`authorImportId`) : charger deux fois le même fichier ne crée
 * rien de plus.
 */
import { ROLE_SETS } from '../../app/screens.js';
import {
  categoryPayload,
  checkCategory,
  checkProduct,
  LOT_TRACKINGS,
  PRICING_MODES,
  productPayload,
  SPECIES,
  STOCK_FAMILIES,
  type CatalogIssue,
  type ProductForm,
} from '../catalog/catalog.js';
import {
  checkSupplier,
  createPayload as supplierPayload,
  EMPTY_SUPPLIER,
  SUPPLIER_LIMITS,
  type SupplierForm,
  type SupplierIssue,
} from '../procurement/suppliers.js';
import {
  checkProspect,
  CUSTOMER_TYPES,
  LEAD_SOURCES,
  prospectPayload,
  type ProspectDraft,
  type ProspectIssue,
} from '../crm/prospect.js';
import { normalizeHeaderName } from './csv.js';
import { authorImportId } from './ids.js';
import {
  cell,
  entityCode,
  listCode,
  yesNo,
  type ColumnDef,
  type ImportEntity,
  type RowOutcome,
} from './model.js';
import { customersByPhone } from './phones.js';
import { PRESENCE_ENTITY } from './presence-entity.js';
import { RP2_ENTITIES } from './rp2-entities.js';
import { SLIPS_ENTITY } from './slips.js';

const CATALOG_ISSUES: Readonly<Record<CatalogIssue, string>> = {
  CODE_INVALID: 'Code invalide : lettres majuscules, chiffres, tiret et tiret bas seulement.',
  CODE_TAKEN: 'Code déjà pris.',
  NAME_REQUIRED: 'Nom obligatoire.',
  CATEGORY_REQUIRED: 'Catégorie obligatoire.',
  UNIT_REQUIRED: 'Unité de base obligatoire.',
  SPECIES_REQUIRED: 'Espèce obligatoire pour un produit biologique.',
  SERVICE_LOT: 'Un service ne se suit pas par lot.',
  BIO_LOT: 'Un produit biologique se suit par lot (facultatif ou obligatoire).',
  FACTOR_INVALID: 'Facteur invalide.',
  FACTOR_NOT_WHOLE: 'Le facteur doit être un entier.',
  PACKAGING_EXISTS: 'Conditionnement déjà défini.',
};

const SUPPLIER_ISSUES: Readonly<Record<SupplierIssue, string>> = {
  CODE_REQUIRED: 'Code obligatoire.',
  CODE_TAKEN: 'Code déjà pris.',
  NAME_REQUIRED: 'Nom obligatoire.',
  EMAIL_INVALID: 'Adresse e-mail invalide.',
  TERMS_INVALID: 'Délai de paiement invalide : un nombre entier de jours, 3 650 au plus.',
};

/** Synonymes français d'une valeur de liste, ramenés au code attendu par le serveur. */
function pick<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  synonyms: Readonly<Record<string, T>> = {},
): T | null {
  if (value === undefined) return fallback;
  const code = listCode(value);
  const direct = allowed.find((candidate) => candidate === code);
  return direct ?? synonyms[code] ?? null;
}

const yes = (record: Readonly<Record<string, string>>, key: string, fallback: boolean) =>
  yesNo(cell(record, key), fallback);

/** Espèces écrites en toutes lettres, ramenées au code du serveur. */
const SPECIES_SYNONYMS: Readonly<Record<string, string>> = {
  POULET_DE_CHAIR: 'POULET_CHAIR',
  POULETS_DE_CHAIR: 'POULET_CHAIR',
  POULET: 'POULET_CHAIR',
  PONDEUSES: 'PONDEUSE',
  PORCS: 'PORC',
  COCHON: 'PORC',
};

const YES_NO_HINT = 'oui ou non';

// --- Catégories de produit ------------------------------------------------------------------------------------------

const CATEGORY_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'code',
    label: 'Code',
    required: true,
    example: 'VOLAILLE',
    hint: 'Lettres, chiffres, tiret et tiret bas ; 40 caractères au plus.',
  },
  { key: 'nom', label: 'Nom', required: true, example: 'Volaille', hint: 'Libellé affiché.' },
  {
    key: 'parent',
    label: 'Catégorie parente',
    required: false,
    example: '',
    hint: 'Code d’une catégorie existante ou placée plus haut dans ce fichier.',
    aliases: ['categorie_parente', 'parent_code'],
  },
];

export const CATEGORIES_ENTITY: ImportEntity = {
  id: 'categories',
  label: 'Catégories de produit',
  description: 'Classement des produits du catalogue. À charger avant les produits.',
  columns: CATEGORY_COLUMNS,
  order: 10,
  // Bornes du serveur (`catalog.product_category.create`).
  limits: { code: 40, nom: 200 },
  roles: ROLE_SETS.catalog,
  async planRow(record, refs, planned): Promise<RowOutcome> {
    const code = entityCode(cell(record, 'code') ?? '');
    const name = cell(record, 'nom') ?? '';
    const issues = checkCategory({ code, name }, [])
      .map((issue) => CATALOG_ISSUES[issue])
      .filter(Boolean);
    const exists =
      refs.categories.some((category) => category.code === code) ||
      refs.pendingCategoryIds.has(code);
    let parentId = '';
    const parent = cell(record, 'parent');
    if (parent !== undefined) {
      const parentCode = entityCode(parent);
      const known = refs.categories.find((category) => category.code === parentCode);
      const pending = refs.pendingCategoryIds.get(parentCode);
      if (known !== undefined) parentId = known.id;
      else if (pending !== undefined) parentId = pending;
      else if (planned.get('category')?.has(parentCode)) {
        parentId = await authorImportId(refs.authorUserId, 'category', parentCode);
      } else {
        issues.push(
          `Catégorie parente « ${parentCode} » inconnue : elle doit exister ou précéder cette ligne dans le fichier.`,
        );
      }
    }
    if (issues.length > 0 || code === '') return { key: code, issues, commands: [] };
    return {
      key: code,
      issues,
      exists,
      provides: [{ kind: 'category', key: code }],
      commands: [
        {
          commandType: 'catalog.product_category.create',
          aggregateType: 'PRODUCT_CATEGORY',
          aggregateId: await authorImportId(refs.authorUserId, 'category', code),
          payload: categoryPayload({ code, name, parentId }),
        },
      ],
    };
  },
};

// --- Produits -------------------------------------------------------------------------------------------------------

const PRODUCT_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'code',
    label: 'Code',
    required: true,
    example: 'POULET-CHAIR-1KG',
    hint: 'Lettres, chiffres, tiret et tiret bas ; 40 caractères au plus.',
    aliases: ['reference'],
  },
  {
    key: 'nom',
    label: 'Nom',
    required: true,
    example: 'Poulet de chair 1 kg',
    hint: 'Libellé affiché.',
  },
  {
    key: 'categorie',
    label: 'Catégorie',
    required: true,
    example: 'VOLAILLE',
    hint: 'Code d’une catégorie existante ou chargée avant.',
    aliases: ['categorie_code'],
  },
  {
    key: 'unite_de_base',
    label: 'Unité de base',
    required: true,
    example: 'KG',
    hint: 'Code d’une unité du catalogue. Ne se modifie plus ensuite.',
    aliases: ['unite', 'unite_code'],
  },
  {
    key: 'famille_de_stock',
    label: 'Famille de stock',
    required: false,
    example: 'MARCHANDISE',
    hint: `${STOCK_FAMILIES.join(', ')} (défaut MARCHANDISE).`,
    aliases: ['famille'],
  },
  {
    key: 'suivi_de_lot',
    label: 'Suivi de lot',
    required: false,
    example: 'NONE',
    hint: `${LOT_TRACKINGS.join(', ')} (défaut NONE ; aucun, facultatif et obligatoire sont compris).`,
    aliases: ['suivi_lot'],
  },
  {
    key: 'suivi_de_peremption',
    label: 'Suivi de péremption',
    required: false,
    example: 'non',
    hint: `${YES_NO_HINT} (défaut non).`,
    aliases: ['peremption'],
  },
  {
    key: 'vendable',
    label: 'Vendable',
    required: false,
    example: 'oui',
    hint: `${YES_NO_HINT} (défaut oui).`,
  },
  {
    key: 'achetable',
    label: 'Achetable',
    required: false,
    example: 'non',
    hint: `${YES_NO_HINT} (défaut non).`,
  },
  {
    key: 'fabricable',
    label: 'Fabricable',
    required: false,
    example: 'non',
    hint: `${YES_NO_HINT} (défaut non).`,
    aliases: ['produit_fabrique', 'producible'],
  },
  {
    key: 'consommable',
    label: 'Consommable',
    required: false,
    example: 'non',
    hint: `${YES_NO_HINT} (défaut non).`,
  },
  {
    key: 'mode_de_prix',
    label: 'Mode de prix',
    required: false,
    example: 'PER_UNIT',
    hint: `${PRICING_MODES.join(', ')} (défaut PER_UNIT ; à l’unité ou au poids sont compris).`,
  },
  {
    key: 'espece',
    label: 'Espèce',
    required: false,
    example: '',
    hint: `${SPECIES.join(', ')} ; obligatoire pour un produit biologique.`,
  },
];

export const PRODUCTS_ENTITY: ImportEntity = {
  id: 'products',
  label: 'Produits',
  description: 'Catalogue des produits. Les catégories et les unités citées doivent exister.',
  columns: PRODUCT_COLUMNS,
  order: 20,
  // Bornes du serveur (`catalog.product.create`).
  limits: { code: 40, nom: 200 },
  roles: ROLE_SETS.catalog,
  async planRow(record, refs, planned): Promise<RowOutcome> {
    const issues: string[] = [];
    const code = entityCode(cell(record, 'code') ?? '');

    const categoryCode = entityCode(cell(record, 'categorie') ?? '');
    let categoryId = '';
    if (categoryCode !== '') {
      const known = refs.categories.find((category) => category.code === categoryCode);
      const pending = refs.pendingCategoryIds.get(categoryCode);
      if (known !== undefined) categoryId = known.id;
      else if (pending !== undefined) categoryId = pending;
      else if (planned.get('category')?.has(categoryCode)) {
        categoryId = await authorImportId(refs.authorUserId, 'category', categoryCode);
      } else {
        issues.push(`Catégorie « ${categoryCode} » inconnue : à charger avant les produits.`);
      }
    }

    const unit = entityCode(cell(record, 'unite_de_base') ?? '');
    if (unit !== '' && !refs.unitCodes.has(unit)) {
      issues.push(`Unité « ${unit} » inconnue du catalogue.`);
    }

    const stockFamily = pick(cell(record, 'famille_de_stock'), STOCK_FAMILIES, 'MARCHANDISE');
    if (stockFamily === null) {
      issues.push(`Famille de stock invalide (${STOCK_FAMILIES.join(', ')}).`);
    }
    const lotTracking = pick(cell(record, 'suivi_de_lot'), LOT_TRACKINGS, 'NONE', {
      AUCUN: 'NONE',
      AUCUNE: 'NONE',
      FACULTATIF: 'OPTIONAL',
      OBLIGATOIRE: 'REQUIRED',
    });
    if (lotTracking === null) issues.push('Suivi de lot invalide (NONE, OPTIONAL, REQUIRED).');
    const pricingMode = pick(cell(record, 'mode_de_prix'), PRICING_MODES, 'PER_UNIT', {
      A_L_UNITE: 'PER_UNIT',
      UNITE: 'PER_UNIT',
      AU_POIDS: 'PER_WEIGHT',
      POIDS: 'PER_WEIGHT',
    });
    if (pricingMode === null) issues.push('Mode de prix invalide (PER_UNIT, PER_WEIGHT).');
    const speciesRaw = cell(record, 'espece');
    const species =
      speciesRaw === undefined
        ? ''
        : (SPECIES_SYNONYMS[listCode(speciesRaw)] ?? listCode(speciesRaw));
    if (species !== '' && !(SPECIES as readonly string[]).includes(species)) {
      issues.push(`Espèce invalide (${SPECIES.join(', ')}).`);
    }

    const expiry = yes(record, 'suivi_de_peremption', false);
    const sellable = yes(record, 'vendable', true);
    const purchasable = yes(record, 'achetable', false);
    const producible = yes(record, 'fabricable', false);
    const consumable = yes(record, 'consommable', false);
    for (const [name, value] of [
      ['Suivi de péremption', expiry],
      ['Vendable', sellable],
      ['Achetable', purchasable],
      ['Fabricable', producible],
      ['Consommable', consumable],
    ] as const) {
      if (value === null) issues.push(`${name} : répondre par oui ou non.`);
    }

    if (
      issues.length === 0 &&
      stockFamily !== null &&
      lotTracking !== null &&
      pricingMode !== null &&
      expiry !== null &&
      sellable !== null &&
      purchasable !== null &&
      producible !== null &&
      consumable !== null
    ) {
      const form: ProductForm = {
        code,
        name: cell(record, 'nom') ?? '',
        categoryId,
        stockFamily,
        baseUnitCode: unit,
        lotTracking,
        expiryTracking: expiry,
        isSellable: sellable,
        isPurchasable: purchasable,
        isProducible: producible,
        isConsumable: consumable,
        pricingMode,
        species,
      };
      // Le code déjà pris n'est pas une erreur : le produit est déjà là, la ligne n'est pas rechargée.
      for (const issue of checkProduct(form, [])) issues.push(CATALOG_ISSUES[issue]);
      if (issues.length === 0) {
        return {
          key: code,
          issues,
          exists: refs.productCodes.has(code),
          commands: [
            {
              commandType: 'catalog.product.create',
              aggregateType: 'PRODUCT',
              aggregateId: await authorImportId(refs.authorUserId, 'product', code),
              payload: productPayload(form),
            },
          ],
        };
      }
    }
    return { key: code, issues, commands: [] };
  },
};

// --- Fournisseurs ---------------------------------------------------------------------------------------------------

const SUPPLIER_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'code',
    label: 'Code',
    required: true,
    example: 'F-PROVENDERIE',
    hint: 'Identifiant du fournisseur ; 40 caractères au plus.',
  },
  {
    key: 'nom',
    label: 'Nom',
    required: true,
    example: 'Provenderie du Littoral',
    hint: 'Raison sociale.',
  },
  {
    key: 'contact',
    label: 'Contact',
    required: false,
    example: 'M. Nkoulou',
    hint: 'Nom du contact.',
    aliases: ['nom_du_contact'],
  },
  {
    key: 'telephone',
    label: 'Téléphone',
    required: false,
    example: '+237 677 12 34 56',
    hint: '20 caractères au plus.',
    aliases: ['tel'],
  },
  {
    key: 'email',
    label: 'E-mail',
    required: false,
    example: '',
    hint: 'Adresse électronique valide.',
    aliases: ['courriel'],
  },
  { key: 'adresse', label: 'Adresse', required: false, example: 'Bonabéri, Douala', hint: '' },
  {
    key: 'numero_fiscal',
    label: 'Numéro fiscal',
    required: false,
    example: '',
    hint: '40 caractères au plus.',
    aliases: ['niu', 'nif'],
  },
  {
    key: 'delai_de_paiement',
    label: 'Délai de paiement (jours)',
    required: false,
    example: '30',
    hint: 'Nombre entier de jours, 3 650 au plus.',
    aliases: ['delai', 'delai_paiement'],
  },
  { key: 'notes', label: 'Notes', required: false, example: '', hint: '' },
];

export const SUPPLIERS_ENTITY: ImportEntity = {
  id: 'suppliers',
  label: 'Fournisseurs',
  description: 'Fiches des fournisseurs de GIC.',
  columns: SUPPLIER_COLUMNS,
  order: 30,
  // Bornes du serveur, que l'écran des fournisseurs applique à la frappe (`SUPPLIER_LIMITS`).
  limits: {
    code: SUPPLIER_LIMITS.code,
    nom: SUPPLIER_LIMITS.name,
    contact: SUPPLIER_LIMITS.contactName,
    telephone: SUPPLIER_LIMITS.phone,
    email: SUPPLIER_LIMITS.email,
    adresse: SUPPLIER_LIMITS.address,
    numero_fiscal: SUPPLIER_LIMITS.taxId,
    notes: SUPPLIER_LIMITS.notes,
  },
  roles: ROLE_SETS.suppliers,
  async planRow(record, refs): Promise<RowOutcome> {
    const code = (cell(record, 'code') ?? '').trim();
    const form: SupplierForm = {
      ...EMPTY_SUPPLIER,
      code,
      name: cell(record, 'nom') ?? '',
      contactName: cell(record, 'contact') ?? '',
      phone: cell(record, 'telephone') ?? '',
      email: cell(record, 'email') ?? '',
      address: cell(record, 'adresse') ?? '',
      taxId: cell(record, 'numero_fiscal') ?? '',
      paymentTermsText: cell(record, 'delai_de_paiement') ?? '',
      notes: cell(record, 'notes') ?? '',
    };
    const issues = checkSupplier(form, { creating: true, takenCodes: new Set() }).map(
      (issue) => SUPPLIER_ISSUES[issue],
    );
    if (issues.length > 0) return { key: code, issues, commands: [] };
    return {
      key: code,
      issues,
      exists: refs.supplierCodes.has(code),
      commands: [
        {
          commandType: 'procurement.supplier.create',
          aggregateType: 'SUPPLIER',
          aggregateId: await authorImportId(refs.authorUserId, 'supplier', code),
          payload: supplierPayload(form),
        },
      ],
    };
  },
};

// --- Clients --------------------------------------------------------------------------------------------------------

const PROSPECT_ISSUES: Readonly<Record<ProspectIssue, string>> = {
  NAME_REQUIRED: 'Nom obligatoire.',
  PHONE_OR_POSITION_REQUIRED: 'Téléphone ou position (latitude et longitude) obligatoire.',
  PHONE_INVALID: 'Téléphone invalide.',
  ZONE_REQUIRED: 'Zone obligatoire.',
  SOURCE_REQUIRED: 'Source obligatoire.',
};

const CUSTOMER_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'nom',
    label: 'Nom',
    required: true,
    example: 'Restaurant du marché',
    hint: 'Nom du client ou de l’enseigne.',
    aliases: ['client', 'raison_sociale'],
  },
  {
    key: 'telephone',
    label: 'Téléphone',
    required: false,
    example: '677 12 34 56',
    hint: 'Numéro camerounais, avec ou sans +237. Sert à repérer les doublons. Téléphone ou position obligatoire.',
    aliases: ['tel', 'telephone_principal'],
  },
  {
    key: 'zone',
    label: 'Zone',
    required: true,
    example: 'Douala › Bonabéri',
    hint: 'Chemin de la zone tel qu’affiché dans l’application, ou son nom s’il est unique.',
    aliases: ['quartier', 'ville'],
  },
  {
    key: 'site',
    label: 'Site de rattachement',
    required: false,
    example: '',
    hint: 'Code ou nom d’un site actif. Un compte sans commercial titulaire doit être rattaché à un site : à défaut de cette colonne, celui de votre point de vente.',
    aliases: ['point_de_vente'],
  },
  {
    key: 'source',
    label: 'Source',
    required: false,
    example: 'PROSPECTION_TERRAIN',
    hint: `${LEAD_SOURCES.join(', ')} (défaut AUTRE).`,
  },
  {
    key: 'type',
    label: 'Type de client',
    required: false,
    example: 'ENTREPRISE',
    hint: 'PARTICULIER ou ENTREPRISE (défaut ENTREPRISE).',
    aliases: ['type_de_client'],
  },
  {
    key: 'contact',
    label: 'Contact',
    required: false,
    example: 'Mme Abena',
    hint: 'Nom de la personne à joindre.',
    aliases: ['nom_du_contact'],
  },
  {
    key: 'activite',
    label: 'Activité',
    required: false,
    example: 'Restauration',
    hint: 'Activité du client.',
    aliases: ['activite_principale'],
  },
  { key: 'adresse', label: 'Adresse', required: false, example: 'Marché Bonabéri', hint: '' },
  {
    key: 'categorie',
    label: 'Catégorie',
    required: false,
    example: '',
    hint: 'Code ou nom d’une catégorie de client existante.',
    aliases: ['categorie_de_client'],
  },
  {
    key: 'latitude',
    label: 'Latitude',
    required: false,
    example: '',
    hint: 'Degrés décimaux, avec la longitude.',
  },
  {
    key: 'longitude',
    label: 'Longitude',
    required: false,
    example: '',
    hint: 'Degrés décimaux, avec la latitude.',
  },
];

const decimal = (value: string | undefined): number | null | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

export const CUSTOMERS_ENTITY: ImportEntity = {
  id: 'customers',
  label: 'Clients',
  description:
    'Comptes clients. Les doublons se repèrent par le téléphone, comme à l’écran de saisie.',
  columns: CUSTOMER_COLUMNS,
  order: 40,
  // Bornes du serveur (`crm.customer.create`).
  limits: { nom: 200, telephone: 30, contact: 200, activite: 200, adresse: 2000 },
  roles: ROLE_SETS.customerCreate,
  async planRow(record, refs): Promise<RowOutcome> {
    const issues: string[] = [];
    const name = cell(record, 'nom') ?? '';

    // Zone : le chemin affiché dans l'application, ou son nom s'il est unique.
    let zoneId = '';
    const zoneText = cell(record, 'zone');
    if (zoneText !== undefined) {
      const wanted = normalizeHeaderName(zoneText);
      const exact = refs.zones.filter((zone) => normalizeHeaderName(zone.label) === wanted);
      const byName = refs.zones.filter(
        (zone) => normalizeHeaderName(zone.label.split(' › ').pop() ?? '') === wanted,
      );
      const matches = exact.length > 0 ? exact : byName;
      if (matches.length === 1) zoneId = matches[0]!.id;
      else if (matches.length > 1) {
        issues.push(
          `Zone « ${zoneText} » ambiguë : écrire son chemin complet (« ville › quartier »).`,
        );
      } else issues.push(`Zone « ${zoneText} » inconnue.`);
    }

    // Site de rattachement : nommé dans le fichier (code, puis nom), sinon celui du point de vente de l'utilisateur.
    // Un compte sans commercial titulaire n'est accepté par le serveur qu'avec un site (BR-CRM-003).
    let homeSiteId: string | undefined;
    const siteText = cell(record, 'site');
    if (siteText !== undefined) {
      const wanted = normalizeHeaderName(siteText);
      const byCode = refs.sites.filter((site) => normalizeHeaderName(site.code) === wanted);
      const matches =
        byCode.length > 0
          ? byCode
          : refs.sites.filter((site) => normalizeHeaderName(site.name) === wanted);
      if (matches.length === 1) homeSiteId = matches[0]!.id;
      else if (matches.length > 1) issues.push(`Site « ${siteText} » ambigu : écrire son code.`);
      else issues.push(`Site « ${siteText} » inconnu.`);
    } else if (refs.defaultHomeSiteId !== undefined) {
      homeSiteId = refs.defaultHomeSiteId;
    } else if (refs.homeSiteRequired) {
      issues.push(
        'Site de rattachement obligatoire : sans commercial titulaire, un compte est rattaché à un site (colonne « Site de rattachement »).',
      );
    }

    const sourceCode = pick(cell(record, 'source'), LEAD_SOURCES, 'AUTRE');
    if (sourceCode === null) issues.push(`Source invalide (${LEAD_SOURCES.join(', ')}).`);
    const customerType = pick(cell(record, 'type'), CUSTOMER_TYPES, 'ENTREPRISE', {
      MENAGE: 'PARTICULIER',
      PROFESSIONNEL: 'ENTREPRISE',
      SOCIETE: 'ENTREPRISE',
    });
    if (customerType === null) issues.push('Type de client invalide (PARTICULIER, ENTREPRISE).');

    let categoryId = '';
    const categoryText = cell(record, 'categorie');
    if (categoryText !== undefined) {
      const wanted = normalizeHeaderName(categoryText);
      const found = refs.customerCategories.find(
        (category) =>
          normalizeHeaderName(category.code) === wanted ||
          normalizeHeaderName(category.name) === wanted,
      );
      if (found === undefined) issues.push(`Catégorie de client « ${categoryText} » inconnue.`);
      else categoryId = found.id;
    }

    const lat = decimal(cell(record, 'latitude'));
    const lng = decimal(cell(record, 'longitude'));
    let position: ProspectDraft['position'] = null;
    if (lat !== undefined || lng !== undefined) {
      if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        issues.push('Position invalide : latitude (−90 à 90) et longitude (−180 à 180) ensemble.');
      } else {
        position = { lat, lng, accuracyM: null };
      }
    }

    const draft: ProspectDraft = {
      displayName: name,
      phone: cell(record, 'telephone') ?? '',
      position,
      zoneId,
      sourceCode: sourceCode ?? '',
      customerType: customerType ?? 'ENTREPRISE',
      contactName: cell(record, 'contact') ?? '',
      businessActivity: cell(record, 'activite') ?? '',
      addressText: cell(record, 'adresse') ?? '',
      categoryId,
    };
    // Le doublon se cherche dans l'index des téléphones, construit une fois par chargement : `checkProspect` balaierait
    // tous les comptes de l'appareil à chaque ligne du fichier.
    const check = checkProspect(draft, [], refs.phoneCountryCode);
    for (const issue of check.issues) {
      // Une zone déjà signalée plus haut (inconnue, ambiguë) ne l'est pas deux fois.
      if (issue === 'ZONE_REQUIRED' && zoneText !== undefined) continue;
      issues.push(PROSPECT_ISSUES[issue]);
    }
    const key = check.normalizedPhone ?? `${normalizeHeaderName(name)}|${zoneId}`;
    if (issues.length > 0) return { key, issues, commands: [] };
    const exists =
      check.normalizedPhone !== null &&
      (customersByPhone(refs.customers, refs.phoneCountryCode).has(check.normalizedPhone) ||
        refs.pendingCustomerPhones.has(check.normalizedPhone));
    return {
      key,
      issues,
      exists,
      commands: [
        {
          commandType: 'crm.customer.create',
          aggregateType: 'CUSTOMER',
          aggregateId: await authorImportId(refs.authorUserId, 'customer', key),
          // Le téléphone part normalisé (E.164) : la clé du doublon est la même des deux côtés.
          payload: prospectPayload(
            { ...draft, phone: check.normalizedPhone ?? draft.phone },
            homeSiteId ? { homeSiteId } : {},
          ),
        },
      ],
    };
  },
};

/** Les types chargeables, dans l'ordre de chargement conseillé. */
export const IMPORT_ENTITIES: readonly ImportEntity[] = [
  CATEGORIES_ENTITY,
  PRODUCTS_ENTITY,
  SUPPLIERS_ENTITY,
  CUSTOMERS_ENTITY,
  SLIPS_ENTITY,
  PRESENCE_ENTITY,
  ...RP2_ENTITIES,
].sort((a, b) => a.order - b.order);

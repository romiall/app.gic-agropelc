/**
 * Suite du chargement de données par fichier (RP-2, AV-072, AV-517) : le stock d'ouverture, les comptes de trésorerie
 * et les règles de prix. Chaque type reprend les contrôles et la charge de la commande que l'écran de saisie envoie
 * (`inventory.opening.post`, `finance.cash_account.create`, `pricing.rule.draft`) : ce que le serveur refuse, le
 * contrôle du fichier le signale d'avance. Les règles de prix ne se chargent qu'en brouillon : l'activation reste à la
 * Direction (AV-062).
 *
 * Les référentiels viennent de l'appareil (`refs.slipContext.refs`, les mêmes que ceux de l'écran de report des
 * pièces) : sans eux, rien n'est chargeable (essais sans appareil).
 */
import { ROLE_SETS } from '../../app/screens.js';
import { parseDecimal } from '../admin/parse.js';
import { doualaInstant } from '../pricing/campaign.js';
import type { SalesReferences } from '../sales/references.js';
import type { LocationData, ProductData } from '../sales/types.js';
import { normalizeHeaderName } from './csv.js';
import { authorImportId } from './ids.js';
import {
  cell,
  entityCode,
  listCode,
  type ColumnDef,
  type FileRecord,
  type ImportEntity,
  type RowOutcome,
} from './model.js';
import type { ImportRefs, ImportSite } from './refs.js';

const NO_REFERENCES =
  'Les référentiels de l’appareil ne sont pas disponibles : réessayez après la synchronisation.';

/** Référentiels de l'appareil et instant du contrôle, ou `undefined` (essais sans appareil). */
const deviceOf = (refs: ImportRefs): { refs: SalesReferences; now: Date } | undefined =>
  refs.slipContext === undefined
    ? undefined
    : { refs: refs.slipContext.refs, now: refs.slipContext.now };

const same = (a: string, b: string): boolean => normalizeHeaderName(a) === normalizeHeaderName(b);

/** Site actif nommé par son code ou son nom (accents et casse ignorés). */
const siteOf = (sites: readonly ImportSite[], text: string): ImportSite | undefined =>
  sites.find((site) => same(site.code, text) || same(site.name, text));

/** Décimal écrit avec un point ou une virgule, trois décimales au plus (colonne `numeric(14,3)`). */
function quantityOf(text: string): number | null {
  const compact = text.replace(/[\s  ]/g, '');
  if (!/^\d{1,11}([.,]\d{1,3})?$/.test(compact)) return null;
  const value = parseDecimal(compact);
  return value !== null && value > 0 ? value : null;
}

/** Francs entiers, espaces tolérés. */
function xafOf(text: string): number | null {
  const digits = text.replace(/[\s  ]/g, '');
  if (!/^\d{1,15}$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

// --- Stock d'ouverture ----------------------------------------------------------------------------------------------

/** Lignes d'un stock d'ouverture au plus par emplacement (schéma de `inventory.opening.post`). */
export const OPENING_MAX_LINES = 500;

export const OPENING_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'site',
    label: 'Site',
    required: true,
    example: 'Magasin central',
    hint: 'Code ou nom d’un site actif.',
  },
  {
    key: 'emplacement',
    label: 'Emplacement',
    required: true,
    example: 'MAG',
    hint: 'Code ou nom d’un emplacement physique actif de ce site. Un seul stock d’ouverture par emplacement.',
  },
  {
    key: 'produit',
    label: 'Produit',
    required: true,
    example: 'OEUF-P',
    hint: 'Code d’un produit actif du catalogue. Les animaux et les produits suivis par lot obligatoire se chargent par leurs lots, pas ici.',
  },
  {
    key: 'quantite',
    label: 'Quantité',
    required: true,
    example: '1200',
    hint: 'En unité de base du produit ; trois décimales au plus.',
    aliases: ['qte', 'quantite_en_unite_de_base'],
  },
  {
    key: 'cout_unitaire',
    label: 'Coût unitaire (F)',
    required: true,
    example: '1850',
    hint: 'Francs entiers par unité de base : ce coût valorise le stock initial.',
    aliases: ['cout', 'prix_de_revient'],
  },
];

const locationOf = (
  refs: SalesReferences,
  siteId: string,
  text: string,
): LocationData | undefined =>
  refs.locations.find(
    (location) =>
      location.site_id === siteId &&
      !location.is_virtual &&
      location.status === 'ACTIVE' &&
      (same(location.code, text) || same(location.name, text)),
  );

const productOfCode = (refs: SalesReferences, text: string): ProductData | undefined =>
  refs.products.find((product) => product.code === entityCode(text));

/** Emplacements qui ont déjà un stock d'ouverture comptabilisé, en attente de validation, ou dans l'outbox. */
function openedLocations(refs: SalesReferences): Set<string> {
  const opened = new Set<string>();
  for (const count of refs.counts) {
    if (count.count_type === 'OPENING' && ['PENDING_APPROVAL', 'POSTED'].includes(count.status)) {
      opened.add(count.location_id);
    }
  }
  for (const command of refs.outbox) {
    if (command.command_type !== 'inventory.opening.post' || command.status === 'REJECTED')
      continue;
    const locationId = (command.payload as { readonly locationId?: unknown }).locationId;
    if (typeof locationId === 'string') opened.add(locationId);
  }
  return opened;
}

async function planOpening(
  group: readonly FileRecord[],
  importRefs: ImportRefs,
): Promise<RowOutcome> {
  const first = group[0]!.record;
  const siteText = cell(first, 'site');
  const locationText = cell(first, 'emplacement');
  const key = `${siteText ?? ''}|${locationText ?? ''}`;
  const device = deviceOf(importRefs);
  if (!device) return { key, issues: [NO_REFERENCES], commands: [] };
  const { refs } = device;

  const issues: string[] = [];
  const site = siteText === undefined ? undefined : siteOf(importRefs.sites, siteText);
  if (siteText === undefined) issues.push('Site manquant.');
  else if (!site) issues.push(`Site inconnu ou inactif : « ${siteText} ».`);
  const location =
    site && locationText !== undefined ? locationOf(refs, site.id, locationText) : undefined;
  if (locationText === undefined) issues.push('Emplacement manquant.');
  else if (site && !location) {
    issues.push(`Emplacement inconnu, virtuel ou inactif dans ce site : « ${locationText} ».`);
  }

  const lines: { productId: string; quantityBase: number; unitCostXaf: number }[] = [];
  const seen = new Set<string>();
  for (const { line, record } of group) {
    const at = `ligne ${line}`;
    const productText = cell(record, 'produit');
    if (productText === undefined) {
      issues.push(`${at} : produit manquant.`);
      continue;
    }
    const product = productOfCode(refs, productText);
    if (!product) {
      issues.push(`${at} : produit inconnu : « ${productText} ».`);
      continue;
    }
    if (product.status !== 'ACTIVE') issues.push(`${at} : « ${product.code} » est désactivé.`);
    else if (
      product.stock_family === 'BIOLOGIQUE' ||
      product.stock_family === 'SERVICE' ||
      product.lot_tracking === 'REQUIRED'
    ) {
      issues.push(
        `${at} : « ${product.code} » ne se charge pas ici (animal, service ou suivi par lot obligatoire).`,
      );
    }
    if (seen.has(product.id))
      issues.push(`${at} : « ${product.code} » figure déjà pour cet emplacement.`);
    seen.add(product.id);
    const quantityText = cell(record, 'quantite');
    const quantity = quantityText === undefined ? null : quantityOf(quantityText);
    if (quantity === null) {
      issues.push(`${at} : quantité invalide (nombre supérieur à 0, trois décimales au plus).`);
    }
    const costText = cell(record, 'cout_unitaire');
    const cost = costText === undefined ? null : xafOf(costText);
    if (cost === null) issues.push(`${at} : coût unitaire invalide (francs entiers).`);
    if (quantity !== null && cost !== null) {
      lines.push({ productId: product.id, quantityBase: quantity, unitCostXaf: cost });
    }
  }
  if (lines.length === 0 && issues.length === 0) issues.push('Aucune ligne de produit.');
  if (group.length > OPENING_MAX_LINES) {
    issues.push(`Plus de ${OPENING_MAX_LINES} lignes pour un emplacement : scinder le fichier.`);
  }
  if (issues.length > 0 || !location) return { key, issues, commands: [] };

  return {
    key: location.id,
    issues,
    exists: openedLocations(refs).has(location.id),
    commands: [
      {
        commandType: 'inventory.opening.post',
        aggregateType: 'INVENTORY_COUNT',
        // L'identifiant dérive de l'emplacement et du contenu : recharger le même fichier ne pose rien deux fois ; un
        // fichier corrigé, chargé après le premier, est refusé par le serveur (un seul stock d'ouverture par emplacement).
        aggregateId: await authorImportId(
          importRefs.authorUserId,
          'opening-stock',
          JSON.stringify([location.id, lines]),
        ),
        payload: { locationId: location.id, lines },
      },
    ],
  };
}

export const OPENING_STOCK_ENTITY: ImportEntity = {
  id: 'opening_stock',
  label: 'Stock d’ouverture',
  description:
    'Stock initial d’un emplacement au démarrage, valorisé au coût déclaré ; il attend la validation avant de compter.',
  columns: OPENING_COLUMNS,
  order: 24,
  // `inventory.opening.post` : l'Admin et la Finance partout (le magasinier, sur son site, le poste à la main).
  roles: ['ADMIN', 'FINANCE'],
  groupKey(record, refs): string | undefined {
    const siteText = cell(record, 'site');
    const locationText = cell(record, 'emplacement');
    if (siteText === undefined || locationText === undefined) return undefined;
    const site = siteOf(refs.sites, siteText);
    const device = deviceOf(refs);
    const location = site && device ? locationOf(device.refs, site.id, locationText) : undefined;
    return location
      ? location.id
      : `${normalizeHeaderName(siteText)}|${normalizeHeaderName(locationText)}`;
  },
  // Une ligne sans site ou sans emplacement n'a pas de groupe : elle ne se charge pas.
  planRow: () => ({ key: '', issues: ['Site et emplacement obligatoires.'], commands: [] }),
  planGroup: planOpening,
};

// --- Comptes de trésorerie ------------------------------------------------------------------------------------------

/** Types de compte, avec leurs formulations françaises courantes. */
const CASH_TYPES = [
  'CAISSE_PDV',
  'CAISSE_UTILISATEUR',
  'CAISSE_CENTRALE',
  'MOBILE_MONEY',
  'BANQUE',
] as const;
const CASH_TYPE_SYNONYMS: Readonly<Record<string, (typeof CASH_TYPES)[number]>> = {
  CAISSE_DU_POINT_DE_VENTE: 'CAISSE_PDV',
  CAISSE_POINT_DE_VENTE: 'CAISSE_PDV',
  CAISSE_PERSONNELLE: 'CAISSE_UTILISATEUR',
  CAISSE_D_UTILISATEUR: 'CAISSE_UTILISATEUR',
  CAISSE_DE_L_UTILISATEUR: 'CAISSE_UTILISATEUR',
  MOBILE: 'MOBILE_MONEY',
  COMPTE_BANCAIRE: 'BANQUE',
  BANCAIRE: 'BANQUE',
};

export const CASH_LIMITS = { code: 40, nom: 200, reference: 60 } as const;

export const CASH_ACCOUNT_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'code',
    label: 'Code',
    required: true,
    example: 'CAISSE-AKWA',
    hint: `Identifiant du compte ; ${CASH_LIMITS.code} caractères au plus.`,
  },
  {
    key: 'nom',
    label: 'Nom',
    required: true,
    example: 'Caisse du point de vente Akwa',
    hint: `${CASH_LIMITS.nom} caractères au plus.`,
  },
  {
    key: 'type',
    label: 'Type',
    required: true,
    example: 'Caisse PDV',
    hint: 'Caisse PDV, Caisse utilisateur, Caisse centrale, Mobile money ou Banque.',
  },
  {
    key: 'site',
    label: 'Site',
    required: false,
    example: 'Point de vente Akwa',
    hint: 'Obligatoire pour une caisse PDV (une caisse active par site) ; code ou nom du site.',
  },
  {
    key: 'titulaire',
    label: 'Titulaire',
    required: false,
    example: 'Paul Essomba',
    hint: 'Obligatoire pour une caisse utilisateur : nom complet d’un utilisateur actif.',
  },
  {
    key: 'responsable',
    label: 'Responsable',
    required: true,
    example: 'Awa Nde',
    hint: 'Nom complet d’un utilisateur actif.',
  },
  {
    key: 'reference_externe',
    label: 'Référence externe',
    required: false,
    example: '+237 677 00 00 00',
    hint: `Numéro du compte marchand ou bancaire ; ${CASH_LIMITS.reference} caractères au plus.`,
    aliases: ['reference', 'numero_de_compte'],
  },
];

/** Utilisateur actif nommé par son nom complet : `undefined` si inconnu, `null` si plusieurs portent ce nom. */
function userOfName(refs: SalesReferences, text: string): { id: string } | undefined | null {
  const found = refs.users.filter((user) => user.status === 'ACTIVE' && same(user.full_name, text));
  if (found.length === 0) return undefined;
  return found.length === 1 ? { id: found[0]!.id } : null;
}

async function planCashAccount(
  record: Readonly<Record<string, string>>,
  importRefs: ImportRefs,
): Promise<RowOutcome> {
  const code = entityCode(cell(record, 'code') ?? '');
  const device = deviceOf(importRefs);
  if (!device) return { key: code, issues: [NO_REFERENCES], commands: [] };
  const { refs } = device;
  const issues: string[] = [];

  if (code === '') issues.push('Code obligatoire.');
  else if (code.length > CASH_LIMITS.code)
    issues.push(`Code trop long (${CASH_LIMITS.code} caractères au plus).`);
  const name = cell(record, 'nom');
  if (name === undefined) issues.push('Nom obligatoire.');
  else if (name.length > CASH_LIMITS.nom)
    issues.push(`Nom trop long (${CASH_LIMITS.nom} caractères au plus).`);

  const typeText = cell(record, 'type');
  const type =
    typeText === undefined
      ? null
      : (CASH_TYPES.find((candidate) => candidate === listCode(typeText)) ??
        CASH_TYPE_SYNONYMS[listCode(typeText)] ??
        null);
  if (typeText === undefined) issues.push('Type obligatoire.');
  else if (type === null) {
    issues.push(
      `Type inconnu : « ${typeText} » (caisse PDV, caisse utilisateur, caisse centrale, mobile money, banque).`,
    );
  }

  let siteId: string | undefined;
  const siteText = cell(record, 'site');
  if (siteText !== undefined) {
    const site = siteOf(importRefs.sites, siteText);
    if (!site) issues.push(`Site inconnu ou inactif : « ${siteText} ».`);
    else siteId = site.id;
  } else if (type === 'CAISSE_PDV') {
    issues.push('Site obligatoire pour une caisse PDV.');
  }
  if (type === 'CAISSE_PDV' && siteId !== undefined) {
    const taken = refs.cashAccounts.some(
      (account) =>
        account.account_type === 'CAISSE_PDV' &&
        account.status === 'ACTIVE' &&
        account.site_id === siteId,
    );
    if (taken) issues.push('Ce site a déjà une caisse de PDV active.');
  }

  let holderUserId: string | undefined;
  const holderText = cell(record, 'titulaire');
  if (holderText !== undefined) {
    const holder = userOfName(refs, holderText);
    if (holder === undefined) issues.push(`Titulaire inconnu ou inactif : « ${holderText} ».`);
    else if (holder === null)
      issues.push(`Plusieurs utilisateurs actifs s’appellent « ${holderText} ».`);
    else holderUserId = holder.id;
  } else if (type === 'CAISSE_UTILISATEUR') {
    issues.push('Titulaire obligatoire pour une caisse utilisateur.');
  }

  let responsibleUserId: string | undefined;
  const responsibleText = cell(record, 'responsable');
  if (responsibleText === undefined) issues.push('Responsable obligatoire.');
  else {
    const responsible = userOfName(refs, responsibleText);
    if (responsible === undefined)
      issues.push(`Responsable inconnu ou inactif : « ${responsibleText} ».`);
    else if (responsible === null) {
      issues.push(`Plusieurs utilisateurs actifs s’appellent « ${responsibleText} ».`);
    } else responsibleUserId = responsible.id;
  }
  const externalRef = cell(record, 'reference_externe');
  if (externalRef !== undefined && externalRef.length > CASH_LIMITS.reference) {
    issues.push(`Référence externe trop longue (${CASH_LIMITS.reference} caractères au plus).`);
  }

  if (issues.length > 0 || type === null || responsibleUserId === undefined || name === undefined) {
    return { key: code, issues, commands: [] };
  }
  return {
    key: code,
    issues,
    exists: refs.cashAccounts.some((account) => account.code === code),
    commands: [
      {
        commandType: 'finance.cash_account.create',
        aggregateType: 'CASH_ACCOUNT',
        aggregateId: await authorImportId(importRefs.authorUserId, 'cash-account', code),
        payload: {
          code,
          name,
          accountType: type,
          ...(type === 'CAISSE_PDV' && siteId !== undefined ? { siteId } : {}),
          ...(type === 'CAISSE_UTILISATEUR' && holderUserId !== undefined ? { holderUserId } : {}),
          responsibleUserId,
          ...(externalRef !== undefined ? { externalRef } : {}),
        },
      },
    ],
  };
}

export const CASH_ACCOUNTS_ENTITY: ImportEntity = {
  id: 'cash_accounts',
  label: 'Comptes de trésorerie',
  description:
    'Caisses de point de vente, caisses personnelles, caisse centrale, comptes mobile money et bancaires. Le solde ne se charge jamais : il vient des mouvements.',
  columns: CASH_ACCOUNT_COLUMNS,
  order: 45,
  limits: {
    code: CASH_LIMITS.code,
    nom: CASH_LIMITS.nom,
    reference_externe: CASH_LIMITS.reference,
  },
  roles: ['ADMIN', 'FINANCE'],
  planRow: planCashAccount,
};

// --- Règles de prix (brouillons) ------------------------------------------------------------------------------------

export const PRICE_RULE_LIMITS = { code: 40, notes: 2000 } as const;
/** Bornes du serveur (`pricing.rule.draft`) pour la priorité. */
const PRIORITY_MAX = 32_767;

export const PRICE_RULE_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'code',
    label: 'Code',
    required: true,
    example: 'OEUF-GEN',
    hint: `Code de la règle ; ${PRICE_RULE_LIMITS.code} caractères au plus. Une règle chargée est un brouillon de version 1.`,
  },
  {
    key: 'produit',
    label: 'Produit',
    required: true,
    example: 'OEUF-P',
    hint: 'Code d’un produit actif et vendable.',
  },
  {
    key: 'prix',
    label: 'Prix (F)',
    required: true,
    example: '1850',
    hint: 'Francs entiers par unité de tarification, supérieur à 0.',
  },
  {
    key: 'unite',
    label: 'Unité de tarification',
    required: false,
    example: 'U',
    hint: 'Code d’une unité ; à défaut, l’unité de base du produit (le kilogramme pour un prix au poids).',
  },
  {
    key: 'site',
    label: 'Site',
    required: false,
    example: '',
    hint: 'Code ou nom d’un site actif ; vide : tous les sites.',
  },
  {
    key: 'zone',
    label: 'Zone',
    required: false,
    example: '',
    hint: 'Zone (chemin ou dernier niveau) ; vide : toutes les zones.',
  },
  {
    key: 'categorie_client',
    label: 'Catégorie de client',
    required: false,
    example: '',
    hint: 'Code ou nom ; vide : toutes.',
    aliases: ['categorie'],
  },
  {
    key: 'canal',
    label: 'Canal de vente',
    required: false,
    example: '',
    hint: 'Code du canal ; vide : tous.',
  },
  {
    key: 'quantite_min',
    label: 'À partir de',
    required: false,
    example: '',
    hint: 'Quantité minimale (palier) ; vide : sans palier.',
    aliases: ['a_partir_de'],
  },
  {
    key: 'priorite',
    label: 'Priorité',
    required: false,
    example: '0',
    hint: 'Nombre entier ; 0 par défaut.',
  },
  {
    key: 'debut',
    label: 'Début de validité',
    required: true,
    example: '15/11/2026',
    hint: 'jj/mm/aaaa ou aaaa-mm-jj, au plus tôt aujourd’hui ; la règle vaut dès 0 h, heure de Douala.',
  },
  {
    key: 'fin',
    label: 'Fin de validité',
    required: false,
    example: '',
    hint: 'Même format, après le début ; vide : sans fin.',
  },
  {
    key: 'note',
    label: 'Note',
    required: false,
    example: '',
    hint: `${PRICE_RULE_LIMITS.notes} caractères au plus.`,
  },
];

/** Jour `AAAA-MM-JJ` lu de `jj/mm/aaaa`, `j/m/aa` ou `aaaa-mm-jj` ; `null` si invalide. */
function dayOf(text: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text.trim());
  let year: string;
  let month: string;
  let day: string;
  if (iso) [, year, month, day] = iso as unknown as [string, string, string, string];
  else if (fr) {
    [, day, month, year] = fr as unknown as [string, string, string, string];
    if (year.length === 2) year = `20${year}`;
  } else return null;
  if (Number(year) < 2000 || Number(year) > 2100) return null;
  const result = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result
    ? null
    : result;
}

/** Début d'un jour métier à Douala (UTC+1), en instant ISO. */
const startOfDay = (day: string): string => doualaInstant(`${day}T00:00`) as string;

async function planPriceRule(
  record: Readonly<Record<string, string>>,
  importRefs: ImportRefs,
): Promise<RowOutcome> {
  const code = entityCode(cell(record, 'code') ?? '');
  const device = deviceOf(importRefs);
  if (!device) return { key: code, issues: [NO_REFERENCES], commands: [] };
  const { refs, now } = device;
  const issues: string[] = [];

  if (code === '') issues.push('Code obligatoire.');
  else if (code.length > PRICE_RULE_LIMITS.code) {
    issues.push(`Code trop long (${PRICE_RULE_LIMITS.code} caractères au plus).`);
  }
  const productText = cell(record, 'produit');
  const product = productText === undefined ? undefined : productOfCode(refs, productText);
  if (productText === undefined) issues.push('Produit obligatoire.');
  else if (!product) issues.push(`Produit inconnu : « ${productText} ».`);
  else if (product.status !== 'ACTIVE' || !product.is_sellable) {
    issues.push(`« ${product.code} » est désactivé ou non vendable.`);
  }
  const priceText = cell(record, 'prix');
  const price = priceText === undefined ? null : xafOf(priceText);
  if (price === null || price <= 0) issues.push('Prix invalide (francs entiers supérieurs à 0).');

  const unitText = cell(record, 'unite');
  let unitCode = product
    ? product.pricing_mode === 'PER_WEIGHT'
      ? 'KG'
      : product.base_unit_code
    : '';
  if (unitText !== undefined) {
    const wanted = entityCode(unitText);
    if (!importRefs.unitCodes.has(wanted)) issues.push(`Unité inconnue : « ${unitText} ».`);
    else unitCode = wanted;
  }

  let siteId: string | undefined;
  const siteText = cell(record, 'site');
  if (siteText !== undefined) {
    const site = siteOf(importRefs.sites, siteText);
    if (!site) issues.push(`Site inconnu ou inactif : « ${siteText} ».`);
    else siteId = site.id;
  }
  let zoneId: string | undefined;
  const zoneText = cell(record, 'zone');
  if (zoneText !== undefined) {
    const matches = importRefs.zones.filter(
      (zone) => same(zone.label, zoneText) || same(zone.label.split('›').pop() ?? '', zoneText),
    );
    if (matches.length === 0) issues.push(`Zone inconnue ou inactive : « ${zoneText} ».`);
    else if (matches.length > 1)
      issues.push(`Plusieurs zones portent le nom « ${zoneText} » : écrire son chemin.`);
    else zoneId = matches[0]!.id;
  }
  if (siteId !== undefined && zoneId !== undefined) {
    // Le site appartient à la zone ou à l'une de ses descendantes (D10 §8) : le serveur le contrôle.
    const site = refs.sites.get(siteId);
    let cursor = site ? refs.zones.get(site.zone_id) : undefined;
    let inside = false;
    for (let depth = 0; cursor && depth < 12; depth += 1) {
      if (cursor.id === zoneId) inside = true;
      cursor = cursor.parent_id ? refs.zones.get(cursor.parent_id) : undefined;
    }
    if (!inside) issues.push('Le site n’appartient pas à la zone de la règle.');
  }
  let customerCategoryId: string | undefined;
  const categoryText = cell(record, 'categorie_client');
  if (categoryText !== undefined) {
    const category = importRefs.customerCategories.find(
      (candidate) => same(candidate.code, categoryText) || same(candidate.name, categoryText),
    );
    if (!category) issues.push(`Catégorie de client inconnue : « ${categoryText} ».`);
    else customerCategoryId = category.id;
  }
  const channelText = cell(record, 'canal');
  const channelCode = channelText === undefined ? undefined : entityCode(channelText);

  const minText = cell(record, 'quantite_min');
  const minQuantity = minText === undefined ? undefined : quantityOf(minText);
  if (minText !== undefined && minQuantity === null) {
    issues.push('Quantité minimale invalide (nombre supérieur à 0, trois décimales au plus).');
  }
  const priorityText = cell(record, 'priorite');
  let priority = 0;
  if (priorityText !== undefined) {
    if (!/^-?\d{1,5}$/.test(priorityText) || Math.abs(Number(priorityText)) > PRIORITY_MAX) {
      issues.push('Priorité invalide (nombre entier).');
    } else priority = Number(priorityText);
  }

  const fromText = cell(record, 'debut');
  const fromDay = fromText === undefined ? null : dayOf(fromText);
  if (fromText === undefined) issues.push('Début de validité obligatoire.');
  else if (fromDay === null) issues.push(`Début invalide : « ${fromText} » (jj/mm/aaaa attendu).`);
  else if (startOfDay(fromDay) < startOfDay(dayOfDouala(now))) {
    issues.push(
      'Le début de validité ne peut pas être passé : la règle ne pourrait plus être activée.',
    );
  }
  const toText = cell(record, 'fin');
  const toDay = toText === undefined ? null : dayOf(toText);
  if (toText !== undefined && toDay === null)
    issues.push(`Fin invalide : « ${toText} » (jj/mm/aaaa attendu).`);
  if (fromDay !== null && toDay !== null && startOfDay(toDay) <= startOfDay(fromDay)) {
    issues.push('La fin de validité doit suivre le début.');
  }
  const notes = cell(record, 'note');
  if (notes !== undefined && notes.length > PRICE_RULE_LIMITS.notes) {
    issues.push(`Note trop longue (${PRICE_RULE_LIMITS.notes} caractères au plus).`);
  }

  if (issues.length > 0 || !product || price === null || fromDay === null) {
    return { key: code, issues, commands: [] };
  }
  const payload = {
    code,
    productId: product.id,
    unitPriceXaf: price,
    pricingUnitCode: unitCode,
    ...(zoneId !== undefined ? { zoneId } : {}),
    ...(siteId !== undefined ? { siteId } : {}),
    ...(customerCategoryId !== undefined ? { customerCategoryId } : {}),
    ...(channelCode !== undefined ? { channelCode } : {}),
    ...(minQuantity !== undefined && minQuantity !== null ? { minQuantity } : {}),
    priority,
    validFrom: startOfDay(fromDay),
    ...(toDay !== null ? { validTo: startOfDay(toDay) } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  return {
    key: code,
    issues,
    commands: [
      {
        commandType: 'pricing.rule.draft',
        aggregateType: 'PRICE_RULE',
        aggregateId: await authorImportId(importRefs.authorUserId, 'price-rule', code),
        payload,
      },
    ],
  };
}

/** Jour métier (Douala, UTC+1) d'un instant : `AAAA-MM-JJ`. */
const dayOfDouala = (instant: Date): string =>
  new Date(instant.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);

export const PRICE_RULES_ENTITY: ImportEntity = {
  id: 'price_rules',
  label: 'Règles de prix (brouillons)',
  description:
    'Prix des produits, avec leurs portées (site, zone, catégorie de client, canal, palier). Chargées en brouillon : la Direction les active.',
  columns: PRICE_RULE_COLUMNS,
  order: 22,
  limits: { code: PRICE_RULE_LIMITS.code, note: PRICE_RULE_LIMITS.notes },
  roles: ROLE_SETS.priceRules,
  planRow: planPriceRule,
};

export const RP2_ENTITIES: readonly ImportEntity[] = [
  CASH_ACCOUNTS_ENTITY,
  PRICE_RULES_ENTITY,
  OPENING_STOCK_ENTITY,
];

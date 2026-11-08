/**
 * Chargement par fichier des lots en cours à reprendre (RP-2 ; ADR-069, BR-PRD-016 ; AV-072, AV-317, AV-541 à AV-544) :
 * une ligne par lot déjà en élevage à la date d'arrêt, une commande `production.lot_opening.post` chacune — la
 * déclaration que l'écran « Reprise d'un lot » enverrait (mêmes contrôles du domaine, même contrat de charge utile que le
 * serveur). La Direction valide ensuite chaque reprise : un lot n'existe qu'à sa validation (aucun lot n'est créé par le
 * chargement lui-même).
 *
 * L'identifiant de la reprise dérive de son auteur et de **tout son contenu** : recharger le même fichier ne déclare rien
 * deux fois ; un fichier corrigé après un refus de la Direction est une nouvelle reprise, d'un autre identifiant.
 */
import {
  LOT_OPENING_AGGREGATE_TYPE,
  LOT_OPENING_POST_COMMAND,
  lotOpeningPostPayloadSchema,
} from '@gic/contracts';
import {
  PRODUCTION_LOT_TYPES,
  isBusinessDay,
  lotOpeningIssues,
  type ProductionLotType,
} from '@gic/domain';
import { rearingLocations } from '../production/daily.js';
import {
  MAX_OPENING_NOTES,
  MAX_OPENING_STRAIN,
  knownOpening,
  parseAmountXaf,
  parseHeadcount,
  parseWeightG,
} from '../production/lot-opening.js';
import { farms } from '../production/lot-setup.js';
import type { SalesReferences } from '../sales/references.js';
import type { LocationData, ProductData, SiteData } from '../sales/types.js';
import { normalizeHeaderName } from './csv.js';
import { authorImportId } from './ids.js';
import { cell, entityCode, type ColumnDef, type ImportEntity, type RowOutcome } from './model.js';
import type { ImportRefs } from './refs.js';

const NO_REFERENCES =
  'Les référentiels de l’appareil ne sont pas disponibles : réessayez après la synchronisation.';

const same = (a: string, b: string): boolean => normalizeHeaderName(a) === normalizeHeaderName(b);

/** Noms français admis pour chaque type de lot (le code du type est toujours admis). */
const LOT_TYPE_NAMES: Readonly<Record<ProductionLotType, readonly string[]>> = {
  POULET_CHAIR: ['Poulet de chair', 'Poulets de chair', 'Chair'],
  PONDEUSE: ['Pondeuses', 'Pondeuse', 'Poules pondeuses'],
  PORC_ENGRAISSEMENT: [
    'Porcs à l’engrais',
    'Porc à l’engrais',
    'Porc d’engraissement',
    'Engraissement',
  ],
  REPRODUCTEUR_VOLAILLE: ['Reproducteurs', 'Reproducteur', 'Reproducteurs volaille'],
  PORC_NAISSAGE: ['Truies (naissage)', 'Truies', 'Naissage'],
};

function lotTypeOf(text: string): ProductionLotType | undefined {
  return PRODUCTION_LOT_TYPES.find(
    (type) => same(type, text) || LOT_TYPE_NAMES[type].some((name) => same(name, text)),
  );
}

/**
 * Jour écrit `AAAA-MM-JJ` ou `JJ/MM/AAAA` (tirets, points ou barres) : le format d'un tableur français. `null` si illisible
 * ou si le jour n'existe pas au calendrier.
 */
export function dayOf(text: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const french = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const parts = iso
    ? { year: iso[1]!, month: iso[2]!, day: iso[3]! }
    : french
      ? { year: french[3]!, month: french[2]!, day: french[1]! }
      : null;
  if (!parts) return null;
  const day = `${parts.year}-${parts.month.padStart(2, '0')}-${parts.day.padStart(2, '0')}`;
  return isBusinessDay(day) ? day : null;
}

export const LOT_OPENING_LIMITS = { souche: MAX_OPENING_STRAIN, note: MAX_OPENING_NOTES } as const;

export const LOT_OPENING_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'site',
    label: 'Ferme',
    required: true,
    example: 'Ferme de Bonabéri',
    hint: 'Code ou nom d’un site actif de type ferme.',
  },
  {
    key: 'emplacement',
    label: 'Bâtiment ou case',
    required: true,
    example: 'BAT-1',
    hint: 'Code ou nom d’un bâtiment ou d’une case actif de cette ferme : l’emplacement principal du lot.',
    aliases: ['batiment', 'case'],
  },
  {
    key: 'type_de_lot',
    label: 'Type de lot',
    required: true,
    example: 'Poulet de chair',
    hint: 'Poulet de chair, Pondeuses, Porcs à l’engrais, Reproducteurs ou Truies (naissage) ; le code du type est admis.',
    aliases: ['type'],
  },
  {
    key: 'produit',
    label: 'Animaux du lot',
    required: true,
    example: 'POULET-VIF',
    hint: 'Code d’un produit biologique actif suivi par lot, de l’espèce du type de lot.',
    aliases: ['animaux'],
  },
  {
    key: 'date_mise_en_place',
    label: 'Date de mise en place',
    required: true,
    example: '05/10/2026',
    hint: 'Le jour réel de mise en place, AAAA-MM-JJ ou JJ/MM/AAAA ; jamais postérieur à aujourd’hui.',
    aliases: ['mise_en_place', 'date'],
  },
  {
    key: 'effectif',
    label: 'Effectif repris',
    required: true,
    example: '4800',
    hint: 'Les têtes réellement présentes à la date d’arrêt (entier).',
    aliases: ['effectif_repris', 'nombre', 'tetes'],
  },
  {
    key: 'valeur',
    label: 'Valeur totale (F)',
    required: true,
    example: '5760000',
    hint: 'Valeur totale du lot en francs entiers : animaux, aliments et soins déjà engagés ; coût de départ du lot.',
    aliases: ['valeur_totale', 'cout', 'cout_total'],
  },
  {
    key: 'souche',
    label: 'Souche',
    required: false,
    example: 'Cobb 500',
    hint: `Facultatif ; ${MAX_OPENING_STRAIN} caractères au plus.`,
  },
  {
    key: 'fournisseur',
    label: 'Fournisseur',
    required: false,
    example: '',
    hint: 'Facultatif : code ou nom d’un fournisseur connu de l’appareil.',
  },
  {
    key: 'poids_moyen',
    label: 'Poids moyen (g)',
    required: false,
    example: '1250',
    hint: 'Facultatif : poids moyen constaté à la reprise, en grammes (une décimale au plus).',
  },
  {
    key: 'note',
    label: 'Note',
    required: false,
    example: '',
    hint: `Facultatif ; ${MAX_OPENING_NOTES} caractères au plus.`,
  },
];

const siteOf = (sites: readonly SiteData[], text: string): SiteData | undefined =>
  sites.find((site) => same(site.code, text) || same(site.name, text));

const locationOf = (locations: readonly LocationData[], text: string): LocationData | undefined =>
  locations.find((location) => same(location.code, text) || same(location.name, text));

const productOfCode = (references: SalesReferences, text: string): ProductData | undefined =>
  references.products.find((product) => product.code === entityCode(text));

async function planLotOpening(
  record: Readonly<Record<string, string>>,
  importRefs: ImportRefs,
): Promise<RowOutcome> {
  const siteText = cell(record, 'site');
  const locationText = cell(record, 'emplacement');
  const productText = cell(record, 'produit');
  const dateText = cell(record, 'date_mise_en_place');
  const key = `${siteText ?? ''}|${locationText ?? ''}|${productText ?? ''}|${dateText ?? ''}`;
  const device = importRefs.slipContext;
  if (!device) return { key, issues: [NO_REFERENCES], commands: [] };
  const references = device.refs;
  const issues: string[] = [];

  const site =
    siteText === undefined ? undefined : siteOf(farms(references.sites.values()), siteText);
  if (siteText === undefined) issues.push('Ferme manquante.');
  else if (!site)
    issues.push(`Ferme inconnue, inactive ou qui n’est pas une ferme : « ${siteText} ».`);

  const location =
    site && locationText !== undefined
      ? locationOf(rearingLocations(references.locations, { site_id: site.id }), locationText)
      : undefined;
  if (locationText === undefined) issues.push('Bâtiment ou case manquant.');
  else if (site && !location) {
    issues.push(`Bâtiment ou case inconnu, inactif ou hors de cette ferme : « ${locationText} ».`);
  }

  const typeText = cell(record, 'type_de_lot');
  const lotType = typeText === undefined ? undefined : lotTypeOf(typeText);
  if (typeText === undefined) issues.push('Type de lot manquant.');
  else if (!lotType) issues.push(`Type de lot inconnu : « ${typeText} ».`);

  const product = productText === undefined ? undefined : productOfCode(references, productText);
  if (productText === undefined) issues.push('Produit manquant.');
  else if (!product) issues.push(`Produit inconnu : « ${productText} ».`);
  else if (product.status !== 'ACTIVE') issues.push(`« ${product.code} » est désactivé.`);
  else if (product.stock_family !== 'BIOLOGIQUE' || product.lot_tracking === 'NONE') {
    issues.push(`« ${product.code} » n’est pas un animal suivi par lot.`);
  }

  const placedOn = dateText === undefined ? null : dayOf(dateText);
  if (dateText === undefined) issues.push('Date de mise en place manquante.');
  else if (placedOn === null) {
    issues.push(`Date de mise en place illisible : « ${dateText} » (AAAA-MM-JJ ou JJ/MM/AAAA).`);
  }

  const quantityText = cell(record, 'effectif');
  const quantity = quantityText === undefined ? null : parseHeadcount(quantityText);
  if (quantityText === undefined) issues.push('Effectif repris manquant.');
  else if (quantity === null) issues.push('Effectif repris invalide (nombre entier de têtes).');

  const valueText = cell(record, 'valeur');
  const value = valueText === undefined ? null : parseAmountXaf(valueText);
  if (valueText === undefined) issues.push('Valeur totale manquante.');
  else if (value === null) issues.push('Valeur totale invalide (francs entiers).');

  const weightText = cell(record, 'poids_moyen');
  const weight = weightText === undefined ? undefined : parseWeightG(weightText);
  if (weightText !== undefined && weight === null) {
    issues.push('Poids moyen invalide (grammes, une décimale au plus).');
  }

  const supplierText = cell(record, 'fournisseur');
  const supplier =
    supplierText === undefined
      ? undefined
      : [...references.suppliers.values()].find(
          (candidate) => same(candidate.code, supplierText) || same(candidate.name, supplierText),
        );
  if (supplierText !== undefined && !supplier) {
    issues.push(`Fournisseur inconnu : « ${supplierText} ».`);
  }

  // Les règles partagées (effectif, valeur, date, espèce) se jugent sur des valeurs lisibles, comme le serveur.
  if (lotType && product && quantity !== null && value !== null && placedOn !== null) {
    for (const issue of lotOpeningIssues(
      {
        lotType,
        productSpecies: product.species ?? null,
        placedOn,
        quantity,
        valueXaf: value,
      },
      device.now,
    )) {
      issues.push(issue.message);
    }
  }
  if (issues.length > 0 || !site || !location || !lotType || !product || !placedOn) {
    return { key, issues, commands: [] };
  }

  const strain = cell(record, 'souche');
  const notes = cell(record, 'note');
  const parsed = lotOpeningPostPayloadSchema.safeParse({
    lotType,
    productId: product.id,
    mainLocationId: location.id,
    placedOn,
    quantity,
    valueXaf: value,
    ...(supplier ? { supplierId: supplier.id } : {}),
    ...(strain ? { strain } : {}),
    ...(weight !== undefined && weight !== null ? { avgWeightG: weight } : {}),
    ...(notes ? { notes } : {}),
  });
  if (!parsed.success) {
    return { key, issues: ['La reprise n’est pas conforme au contrat du serveur.'], commands: [] };
  }
  const payload = parsed.data;
  const aggregateId = await authorImportId(
    importRefs.authorUserId,
    'lot-opening',
    JSON.stringify(payload),
  );
  const known = knownOpening(references, {
    locationId: location.id,
    productId: product.id,
    placedOn,
    selfId: aggregateId,
  });
  return {
    // La clé du lot réel : deux lignes du même fichier pour le même lot sont un doublon.
    key: `${location.id}|${product.id}|${placedOn}`,
    issues,
    exists:
      known !== null || references.outbox.some((command) => command.aggregate_id === aggregateId),
    commands: [
      {
        commandType: LOT_OPENING_POST_COMMAND,
        aggregateType: LOT_OPENING_AGGREGATE_TYPE,
        aggregateId,
        payload,
      },
    ],
  };
}

export const LOT_OPENING_ENTITY: ImportEntity = {
  id: 'lot_opening',
  label: 'Lots en cours (reprise)',
  description:
    'Lots déjà en élevage à la date d’arrêt : effectif repris, mise en place réelle, valeur totale. Chaque reprise attend la validation de la Direction ; le lot n’existe qu’après.',
  columns: LOT_OPENING_COLUMNS,
  order: 26,
  limits: LOT_OPENING_LIMITS,
  // Comme les autres chargements, réservé aux rôles du menu « Chargement de données » (`ROLE_SETS.dataImport`) qui détiennent
  // le droit `production.lot_opening.post` : l'Administrateur. Le Responsable production déclare ses lots un à un à l'écran.
  roles: ['ADMIN'],
  planRow: planLotOpening,
};

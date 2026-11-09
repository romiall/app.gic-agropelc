/**
 * Reprise d'un lot en cours (section « Reprise » de ECR-PRD-04 et chargement par fichier ; ADR-069, BR-PRD-016 ;
 * AV-541 à AV-544) : logique pure. Un lot déjà en élevage à la date d'arrêt entre dans l'application par une déclaration
 * unique — effectif repris, date de mise en place réelle, valeur totale déclarée — que la Direction valide ; le lot
 * n'existe qu'à l'approbation. La commande est `production.lot_opening.post` (agrégat `PRODUCTION_LOT_OPENING`).
 *
 * Les contrôles sont ceux du domaine (`lotOpeningIssues`, que le serveur rejoue) et le contrat de la charge utile est
 * celui du serveur (`lotOpeningPostPayloadSchema`) : ce que le serveur refuserait, l'écran le signale d'avance.
 */
import { lotOpeningPostPayloadSchema, type LotOpeningPostPayload } from '@gic/contracts';
import { lotOpeningIssues, type ProductionLotType } from '@gic/domain';
import { isWaiting } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import type { ProductData } from '../sales/types.js';

export const MAX_OPENING_NOTES = 4000;
export const MAX_OPENING_STRAIN = 100;

/** Type de commande des reprises encore dans l'outbox (mêmes valeurs que le contrat). */
export const OPENING_COMMAND_TYPE = 'production.lot_opening.post';

export interface LotOpeningDraft {
  readonly siteId: string;
  readonly lotType: ProductionLotType;
  readonly productId: string;
  readonly mainLocationId: string;
  /** Jour de mise en place réel, `AAAA-MM-JJ`. */
  readonly placedOn: string;
  /** Effectif repris (têtes), tel que saisi. */
  readonly quantityText: string;
  /** Valeur totale du lot (francs), telle que saisie. */
  readonly valueText: string;
  readonly supplierId: string;
  readonly strain: string;
  readonly avgWeightText: string;
  readonly notes: string;
}

export const EMPTY_LOT_OPENING: LotOpeningDraft = {
  siteId: '',
  lotType: 'POULET_CHAIR',
  productId: '',
  mainLocationId: '',
  placedOn: '',
  quantityText: '',
  valueText: '',
  supplierId: '',
  strain: '',
  avgWeightText: '',
  notes: '',
};

const SPACES = /[\s\u00a0\u202f]/g;

/** Effectif en têtes : entier, espaces tolérés (« 4 800 ») ; `null` si vide ou illisible. */
export function parseHeadcount(text: string): number | null {
  const digits = text.replace(SPACES, '');
  if (!/^\d{1,8}$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** Montant en francs entiers, espaces tolérés (« 5 760 000 ») ; `null` si vide ou illisible. */
export function parseAmountXaf(text: string): number | null {
  const digits = text.replace(SPACES, '');
  if (!/^\d{1,15}$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** Poids moyen en grammes, une décimale au plus, virgule ou point ; `null` si vide ou illisible. */
export function parseWeightG(text: string): number | null {
  const compact = text.replace(SPACES, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d)?$/.test(compact)) return null;
  const value = Number(compact);
  return value > 0 ? value : null;
}

export interface LotOpeningIssue {
  /** Champ de l'écran concerné. */
  readonly field: 'farm' | 'product' | 'location' | 'placedOn' | 'quantity' | 'value' | 'weight';
  /** `REQUIRED` : champ pas encore rempli (l'écran ne le reproche pas) ; `INVALID` : valeur refusée. */
  readonly kind: 'REQUIRED' | 'INVALID';
  /** Phrase en français : celle du domaine pour une règle partagée, celle de l'écran sinon. */
  readonly message: string;
}

const FIELD_OF_DOMAIN = {
  quantity: 'quantity',
  valueXaf: 'value',
  placedOn: 'placedOn',
  productId: 'product',
} as const;

/**
 * Défauts d'une déclaration, tous rendus. `product` est le produit choisi (son espèce juge `PRODUCT_INVALID`) ;
 * `declaredAt` est l'instant de la déclaration (maintenant), comme `occurred_at` pour le serveur.
 */
export function checkLotOpeningDraft(
  draft: LotOpeningDraft,
  product: Pick<ProductData, 'species'> | undefined,
  declaredAt: Date,
): readonly LotOpeningIssue[] {
  const issues: LotOpeningIssue[] = [];
  if (!draft.siteId)
    issues.push({ field: 'farm', kind: 'REQUIRED', message: 'Choisissez la ferme.' });
  if (!draft.productId)
    issues.push({
      field: 'product',
      kind: 'REQUIRED',
      message: 'Choisissez les animaux du lot.',
    });
  if (!draft.mainLocationId) {
    issues.push({
      field: 'location',
      kind: 'REQUIRED',
      message: 'Choisissez le bâtiment ou la case.',
    });
  }
  const quantity = parseHeadcount(draft.quantityText);
  const value = parseAmountXaf(draft.valueText);
  if (draft.avgWeightText.trim() !== '' && parseWeightG(draft.avgWeightText) === null) {
    issues.push({
      field: 'weight',
      kind: 'INVALID',
      message: 'Poids moyen : nombre positif en grammes, une décimale au plus.',
    });
  }
  if (draft.placedOn === '') {
    issues.push({
      field: 'placedOn',
      kind: 'REQUIRED',
      message: 'Indiquez la date de mise en place.',
    });
  }
  if (draft.quantityText.trim() === '') {
    issues.push({
      field: 'quantity',
      kind: 'REQUIRED',
      message: 'Indiquez l’effectif repris.',
    });
  }
  if (draft.valueText.trim() === '') {
    issues.push({
      field: 'value',
      kind: 'REQUIRED',
      message: 'Indiquez la valeur totale du lot, en francs.',
    });
  }
  // Les règles partagées ne se jugent que sur des valeurs lisibles et une date saisie.
  if (
    quantity !== null &&
    value !== null &&
    draft.placedOn !== '' &&
    (draft.productId === '' || product !== undefined)
  ) {
    for (const issue of lotOpeningIssues(
      {
        lotType: draft.lotType,
        productSpecies: product?.species ?? null,
        placedOn: draft.placedOn,
        quantity,
        valueXaf: value,
      },
      declaredAt,
    )) {
      // Produit non choisi : déjà signalé plus haut.
      if (issue.code === 'PRODUCT_INVALID' && draft.productId === '') continue;
      issues.push({ field: FIELD_OF_DOMAIN[issue.field], kind: 'INVALID', message: issue.message });
    }
  } else {
    if (draft.quantityText.trim() !== '' && quantity === null) {
      issues.push({
        field: 'quantity',
        kind: 'INVALID',
        message: 'Effectif : un nombre entier de têtes.',
      });
    }
    if (draft.valueText.trim() !== '' && value === null) {
      issues.push({
        field: 'value',
        kind: 'INVALID',
        message: 'Valeur : un montant entier en francs.',
      });
    }
  }
  return issues;
}

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Charge utile de `production.lot_opening.post`, validée par le contrat du serveur ; `null` tant que la déclaration est
 * incomplète ou illisible.
 */
export function lotOpeningPayload(draft: LotOpeningDraft): LotOpeningPostPayload | null {
  const quantity = parseHeadcount(draft.quantityText);
  const value = parseAmountXaf(draft.valueText);
  if (quantity === null || value === null) return null;
  const strain = optionalText(draft.strain);
  const notes = optionalText(draft.notes);
  const weight = draft.avgWeightText.trim() === '' ? undefined : parseWeightG(draft.avgWeightText);
  if (weight === null) return null;
  const parsed = lotOpeningPostPayloadSchema.safeParse({
    lotType: draft.lotType,
    productId: draft.productId,
    mainLocationId: draft.mainLocationId,
    placedOn: draft.placedOn,
    quantity,
    valueXaf: value,
    ...(draft.supplierId ? { supplierId: draft.supplierId } : {}),
    ...(strain ? { strain } : {}),
    ...(weight !== undefined ? { avgWeightG: weight } : {}),
    ...(notes ? { notes } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** Le lot réel que la déclaration reprendrait existe-t-il déjà, ou est-il déjà déclaré sur cet appareil ? */
export type KnownOpening =
  { readonly kind: 'LOT'; readonly lotCode: string } | { readonly kind: 'UNSENT' };

/**
 * Même emplacement, même produit, même jour de mise en place : un lot de l'appareil, ou une reprise encore dans
 * l'outbox sans réponse du serveur (pas encore envoyée, ou en cours). Les reprises déjà envoyées et refusées ne sont pas
 * lues ici : le serveur juge (un refus libère le lot réel, une reprise validée est un lot).
 */
export function knownOpening(
  refs: Pick<SalesReferences, 'productionLots' | 'outbox'>,
  group: {
    readonly locationId: string;
    readonly productId: string;
    readonly placedOn: string;
    /** Identifiant de la reprise elle-même, pour ne pas se reconnaître. */
    readonly selfId?: string;
  },
): KnownOpening | null {
  const lot = refs.productionLots.find(
    (candidate) =>
      candidate.main_location_id === group.locationId &&
      candidate.product_id === group.productId &&
      candidate.start_date?.slice(0, 10) === group.placedOn &&
      candidate.status !== 'CANCELLED' &&
      candidate.id !== group.selfId,
  );
  if (lot) return { kind: 'LOT', lotCode: lot.lot_code };
  const unsent = refs.outbox.some((command) => {
    if (command.command_type !== OPENING_COMMAND_TYPE) return false;
    if (command.aggregate_id === group.selfId) return false;
    if (!isWaiting(command)) return false;
    const payload = command.payload as {
      readonly mainLocationId?: unknown;
      readonly productId?: unknown;
      readonly placedOn?: unknown;
    };
    return (
      payload.mainLocationId === group.locationId &&
      payload.productId === group.productId &&
      payload.placedOn === group.placedOn
    );
  });
  return unsent ? { kind: 'UNSENT' } : null;
}

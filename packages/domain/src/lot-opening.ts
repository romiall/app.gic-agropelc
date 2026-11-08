/**
 * Reprise d'un lot en cours (ADR-069, BR-PRD-016 ; AV-541 à AV-544) : règles pures, partagées par l'appareil (écran et
 * chargement par fichier, contrôles faits avant l'envoi) et par le serveur (qui rejuge tout, ADR-021). Sans entrée-sortie.
 *
 * Un lot déjà en élevage à la date d'arrêt entre dans les livres par une déclaration unique : l'effectif repris à cette
 * date, la date de mise en place réelle (âge, croissance) et la valeur totale déclarée du lot (animaux, aliments et soins
 * déjà engagés). Ces bornes sont des garde-fous contre une faute de frappe, pas des seuils métier (règle 8 : le seuil de
 * validation reste la politique de contrôle `LOT_OPENING`).
 */
import { addBusinessDays, businessDayOf, isBusinessDay } from './business-day.js';
import { lotAcceptsProductSpecies, type ProductionLotType } from './production.js';

/** Effectif repris le plus haut accepté (têtes) : au-delà, c'est une faute de frappe. */
export const LOT_OPENING_MAX_HEADCOUNT = 1_000_000;

/** Valeur déclarée la plus haute par tête (XAF) : un reproducteur coûte quelques centaines de milliers de francs. */
export const LOT_OPENING_MAX_UNIT_VALUE_XAF = 10_000_000;

/** Ancienneté la plus haute d'un lot repris (jours) : environ trois ans, la vie d'un troupeau de reproducteurs. */
export const LOT_OPENING_MAX_AGE_DAYS = 1_100;

export interface LotOpeningIssue {
  /** Code stable, repris tel quel par le rejet du serveur. */
  readonly code:
    | 'LOT_OPENING_QUANTITY_INVALID'
    | 'LOT_OPENING_VALUE_INVALID'
    | 'LOT_OPENING_VALUE_TOO_HIGH'
    | 'LOT_OPENING_DATE_INVALID'
    | 'LOT_OPENING_DATE_FUTURE'
    | 'LOT_OPENING_DATE_TOO_OLD'
    | 'PRODUCT_INVALID';
  /** Champ de la déclaration concerné, pour l'écran et le fichier. */
  readonly field: 'quantity' | 'valueXaf' | 'placedOn' | 'productId';
  readonly message: string;
}

export interface LotOpeningDeclaration {
  readonly lotType: ProductionLotType;
  /** Espèce du produit du catalogue (`catalog.products.species`), `null` si le produit n'en a pas. */
  readonly productSpecies: string | null;
  /** Jour métier de mise en place réel, `AAAA-MM-JJ`. */
  readonly placedOn: string;
  /** Effectif repris à la date d'arrêt (têtes, entier). */
  readonly quantity: number;
  /** Valeur totale déclarée du lot (XAF entiers). */
  readonly valueXaf: number;
}

/**
 * Contrôles d'une déclaration de reprise, tous rendus (jamais le premier seul) : l'écran et le fichier montrent chaque
 * défaut d'un coup. `declaredAt` est l'instant de la déclaration (`occurred_at` de la commande) : la mise en place ne
 * peut pas le suivre (BR-PRD-016), ni le précéder de plus de {@link LOT_OPENING_MAX_AGE_DAYS} jours.
 */
export function lotOpeningIssues(
  declaration: LotOpeningDeclaration,
  declaredAt: Date,
): readonly LotOpeningIssue[] {
  const issues: LotOpeningIssue[] = [];
  const { quantity, valueXaf, placedOn } = declaration;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > LOT_OPENING_MAX_HEADCOUNT) {
    issues.push({
      code: 'LOT_OPENING_QUANTITY_INVALID',
      field: 'quantity',
      message: `L’effectif repris est un nombre entier de têtes, de 1 à ${LOT_OPENING_MAX_HEADCOUNT}.`,
    });
  }

  if (!Number.isSafeInteger(valueXaf) || valueXaf < 0) {
    issues.push({
      code: 'LOT_OPENING_VALUE_INVALID',
      field: 'valueXaf',
      message: 'La valeur déclarée du lot est un montant entier en francs, nul ou positif.',
    });
  } else if (
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    valueXaf > quantity * LOT_OPENING_MAX_UNIT_VALUE_XAF
  ) {
    issues.push({
      code: 'LOT_OPENING_VALUE_TOO_HIGH',
      field: 'valueXaf',
      message: `La valeur déclarée dépasse ${LOT_OPENING_MAX_UNIT_VALUE_XAF} F par tête : vérifiez le montant et l’effectif.`,
    });
  }

  if (!isBusinessDay(placedOn)) {
    issues.push({
      code: 'LOT_OPENING_DATE_INVALID',
      field: 'placedOn',
      message: 'La date de mise en place est un jour réel, au format AAAA-MM-JJ.',
    });
  } else {
    const today = businessDayOf(declaredAt);
    if (placedOn > today) {
      issues.push({
        code: 'LOT_OPENING_DATE_FUTURE',
        field: 'placedOn',
        message: 'La mise en place d’un lot repris ne peut pas être postérieure à la déclaration.',
      });
    } else if (placedOn < addBusinessDays(today, -LOT_OPENING_MAX_AGE_DAYS)) {
      issues.push({
        code: 'LOT_OPENING_DATE_TOO_OLD',
        field: 'placedOn',
        message: `La mise en place date de plus de ${LOT_OPENING_MAX_AGE_DAYS} jours : vérifiez la date.`,
      });
    }
  }

  if (!lotAcceptsProductSpecies(declaration.lotType, declaration.productSpecies)) {
    issues.push({
      code: 'PRODUCT_INVALID',
      field: 'productId',
      message:
        'Le produit d’un lot est un produit biologique actif, suivi par lot, de l’espèce du type de lot (BR-PRD-001).',
    });
  }
  return issues;
}

/**
 * Résumé de la demande de validation (file des validations de la Direction). Aucune valeur au coût : le résumé est servi
 * tel quel au demandeur (RC-05) ; la valeur reste dans le montant de la demande, masqué sans droit de valorisation.
 */
export function lotOpeningSummary(input: {
  readonly productName: string;
  readonly quantity: number;
  readonly placedOn: string;
}): string {
  const [year, month, day] = input.placedOn.split('-');
  return `Reprise d’un lot en cours : ${input.productName}, ${input.quantity} têtes mises en place le ${day}/${month}/${year}`;
}

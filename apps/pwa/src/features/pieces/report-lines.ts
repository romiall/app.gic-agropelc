/**
 * Ligne vide d'un éditeur de lignes de pièce (produit à choisir). Séparée des composants pour que
 * `ReportSections.tsx` n'exporte que des composants (rechargement à chaud) et que `report-form.ts` reste
 * sans dépendance à la racine de composition.
 */
import { idGenerator } from '../../platform/composition.js';
import type { DraftLine } from '../sales/sale-form.js';

export function blankLine(): DraftLine {
  return {
    key: idGenerator.newId(),
    productId: '',
    unitCode: '',
    quantityText: '',
    weightText: '',
    priceText: null,
    overrideReasonId: null,
  };
}

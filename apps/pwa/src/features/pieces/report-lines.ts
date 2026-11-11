/**
 * Ligne vide d'un éditeur de lignes de pièce (produit à choisir). Séparée des composants pour que
 * `ReportSections.tsx` n'exporte que des composants (rechargement à chaud) et que `report-form.ts` reste
 * sans dépendance à la racine de composition.
 */
import { idGenerator } from '../../platform/composition.js';
import type { DraftLine } from '../sales/sale-form.js';
import type { LotDayForm } from './report-form.js';

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

/** Ligne vide d'une fiche de suivi de lot (FL), pour le jour `AAAA-MM-JJ` donné. */
export function blankLotDay(date = ''): LotDayForm {
  return {
    key: idGenerator.newId(),
    date,
    deathsText: '',
    deathReasonId: '',
    feedProductId: '',
    feedKgText: '',
    sampleText: '',
    avgWeightText: '',
    observation: '',
  };
}

/** Jour proposé pour une nouvelle ligne : le lendemain de la dernière ligne, sans dépasser aujourd'hui. */
export function nextLotDay(days: readonly LotDayForm[], today: string): string {
  const last = days[days.length - 1]?.date ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return today;
  const next = new Date(`${last}T12:00`);
  if (Number.isNaN(next.getTime())) return today;
  next.setDate(next.getDate() + 1);
  const text = new Date(next.getTime() - next.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
  return text > today ? today : text;
}

/**
 * Mise en forme des écrans de vente : mêmes conventions que l'accueil (`format-home.ts`) — montants
 * en francs CFA entiers, quantités à trois décimales au plus, heure du fuseau métier.
 *
 * Unités (MP-09, AV-249, décision du porteur du 13/10/2026) : libellés courts au singulier et au
 * pluriel pour les codes connus (« 27 plateaux », « 1 pièce », « 500 kg », « 12 têtes »), repli sur le
 * nom du catalogue, puis sur le code ; aucun changement de la base. Pluriel à partir de 2 (règle
 * française), la quantité arrondie comme à l'affichage ; symboles invariables (kg, g, L).
 */
import { formatClockTime, formatKpiValue } from '../home/format-home.js';

export function formatMoney(amountXaf: number): string {
  return formatKpiValue(amountXaf, 'XAF');
}

const QUANTITY = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

/** Le séparateur de milliers français (espace insécable) devient une espace ordinaire (`\s`). */
export function formatQuantity(value: number): string {
  // `-0` (aucun solde, rien en attente) s'affiche 0.
  return QUANTITY.format(value || 0).replace(/\s/g, ' ');
}

export { formatClockTime };

/** Unités du catalogue, par code (nom de repli). */
export type UnitCatalog = ReadonlyMap<string, { readonly name: string }>;

/** Libellés courts des codes d'unité connus (dictionnaire `catalog.units`) : singulier, pluriel. */
const UNIT_LABELS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['TETE', ['tête', 'têtes']],
  ['OEUF', ['œuf', 'œufs']],
  ['PIECE', ['pièce', 'pièces']],
  ['KG', ['kg', 'kg']],
  ['G', ['g', 'g']],
  ['L', ['L', 'L']],
  ['SAC', ['sac', 'sacs']],
  ['PLATEAU', ['plateau', 'plateaux']],
  ['CARTON', ['carton', 'cartons']],
  ['DOSE', ['dose', 'doses']],
]);

/** Pluriel français : 2 et plus, la quantité arrondie au millième comme à l'affichage, signe ignoré. */
export function isPluralQuantity(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(Math.round(value * 1000) / 1000) >= 2;
}

/**
 * Libellé d'une unité pour une quantité (`1` : libellé de champ, au singulier). Code connu : libellé
 * court ; sinon nom du catalogue ; sinon le code tel quel.
 */
export function unitLabel(code: string, quantity = 1, units?: UnitCatalog): string {
  const known = UNIT_LABELS.get(code);
  if (known) return isPluralQuantity(quantity) ? known[1] : known[0];
  return units?.get(code)?.name ?? code;
}

/** « 27 plateaux », « 1,5 kg », « 1 pièce ». */
export function formatQuantityUnit(value: number, code: string, units?: UnitCatalog): string {
  return `${formatQuantity(value)} ${unitLabel(code, value, units)}`.trim();
}

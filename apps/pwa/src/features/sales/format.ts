/**
 * Mise en forme des écrans de vente : mêmes conventions que l'accueil (`format-home.ts`) — montants
 * en francs CFA entiers, quantités à trois décimales au plus, heure du fuseau métier.
 */
import { formatClockTime, formatKpiValue } from '../home/format-home.js';

export function formatMoney(amountXaf: number): string {
  return formatKpiValue(amountXaf, 'XAF');
}

const QUANTITY = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

/** Le séparateur de milliers français (espace insécable) devient une espace ordinaire (`\s`). */
export function formatQuantity(value: number): string {
  return QUANTITY.format(value).replace(/\s/g, ' ');
}

export { formatClockTime };

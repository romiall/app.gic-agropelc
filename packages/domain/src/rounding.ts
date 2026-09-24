/**
 * Arrondis monétaires (ADR-013 ; BR-VEN-014 : « montant de ligne = arrondi au franc,
 * demi supérieur, de quantité de tarification × prix »).
 *
 * Le franc CFA n'a pas de sous-unité, mais `quantité × prix` peut être fractionnaire
 * (tarification au poids, BR-CAT-009). Le calcul se fait entièrement en arithmétique
 * entière — quantité en millièmes × prix en francs, donnant un résultat exact en
 * **milli-francs** — puis arrondi au franc supérieur à partir de 0,5 : jamais de
 * flottant, donc aucune dérive d'arrondi possible.
 */
import { assertSafeInteger } from './errors.js';
import { type Quantity, quantityMilliUnits } from './quantity.js';
import { type Xaf, xaf } from './money.js';

/** Arrondit un montant exprimé en milli-francs au franc le plus proche, demi supérieur. */
export function roundHalfUpMilliXafToFranc(milliXaf: number): Xaf {
  assertSafeInteger(milliXaf, 'milliXaf');
  const rounded = Math.floor((milliXaf + 500) / 1000);
  return xaf(rounded);
}

/**
 * Montant d'une ligne de vente ou de commande (BR-VEN-014, INV-VEN-03) :
 * quantité (unité de base) × prix unitaire (XAF entiers), arrondi au franc, demi
 * supérieur. Utilisable tel quel par le futur moteur de prix (P1, `pricing`).
 */
export function lineAmountXaf(quantity: Quantity, unitPriceXaf: Xaf): Xaf {
  const milliXaf = quantityMilliUnits(quantity) * unitPriceXaf;
  assertSafeInteger(milliXaf, 'lineAmountXaf (produit intermédiaire)');
  return roundHalfUpMilliXafToFranc(milliXaf);
}

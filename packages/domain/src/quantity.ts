/**
 * Quantités en unité de base, ADR-013 : `numeric(14,3)` en base, portées ici en
 * **millièmes entiers** pour n'effectuer aucune arithmétique en virgule flottante
 * (05-architecture/05-stack.md §2.1). `Quantity` représente donc, en interne, le nombre
 * de millièmes d'unité (1,000 unité = 1000 millièmes) ; il reste dans les bornes d'un
 * entier sûr JavaScript pour toute valeur réaliste (14 chiffres significatifs, dont 3
 * décimales, restent trois ordres de grandeur sous `Number.MAX_SAFE_INTEGER`).
 *
 * `Quantity` n'impose ni signe ni caractère entier : ces contraintes sont propres à
 * l'usage (BR-STK-001 : quantité de mouvement strictement positive ; BR-CAT-003 : unité
 * comptée ⇒ quantité entière) et sont vérifiées par les modules qui les appliquent, pas
 * ici — cohérent avec la manière dont {@link isWholeQuantity} est offerte comme
 * prédicat plutôt qu'imposée par le type.
 */
import { assertSafeInteger, DomainError } from './errors.js';

declare const QuantityBrand: unique symbol;
export type Quantity = number & { readonly [QuantityBrand]: true };

const MILLI = 1000;

/** Construit une quantité à partir de sa valeur décimale (ex. 3.5, jusqu'à 3 décimales). */
export function quantityFromDecimal(value: number): Quantity {
  if (!Number.isFinite(value)) {
    throw new DomainError(`Quantity : valeur non finie (${value}).`, 'INVALID_QUANTITY');
  }
  const milli = Math.round(value * MILLI);
  if (Math.abs(milli / MILLI - value) > 1e-9) {
    throw new DomainError(
      `Quantity : ${value} porte plus de 3 décimales (précision maximale en unité de base).`,
      'TOO_MANY_DECIMALS',
    );
  }
  assertSafeInteger(milli, 'Quantity (millièmes)');
  return milli as Quantity;
}

/** Construit une quantité directement à partir de son nombre entier de millièmes. */
export function quantityFromMilli(milli: number): Quantity {
  assertSafeInteger(milli, 'Quantity (millièmes)');
  return milli as Quantity;
}

export const ZERO_QUANTITY = quantityFromMilli(0);

/** Nombre entier de millièmes porté par la quantité (interopérabilité, calculs exacts). */
export function quantityMilliUnits(q: Quantity): number {
  return q as number;
}

/** Valeur décimale (ex. 3500 millièmes → 3.5). */
export function quantityToDecimal(q: Quantity): number {
  return (q as number) / MILLI;
}

export function addQuantity(...values: readonly Quantity[]): Quantity {
  const sum = values.reduce((acc, v) => acc + (v as number), 0);
  return quantityFromMilli(sum);
}

/** Différence signée (ex. écart d'inventaire : compté − théorique, BR-STK-042). */
export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  return quantityFromMilli((a as number) - (b as number));
}

export function isPositiveQuantity(q: Quantity): boolean {
  return (q as number) > 0;
}

export function isZeroQuantity(q: Quantity): boolean {
  return (q as number) === 0;
}

/** Vrai si la quantité représente un nombre entier d'unités (BR-CAT-003). */
export function isWholeQuantity(q: Quantity): boolean {
  return (q as number) % MILLI === 0;
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}

export function formatQuantity(q: Quantity): string {
  return quantityToDecimal(q).toLocaleString('fr-FR', { maximumFractionDigits: 3 });
}

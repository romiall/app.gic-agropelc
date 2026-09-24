/**
 * Montants en francs CFA (XAF), ADR-013.
 *
 * XAF n'a pas de sous-unité : tout montant est un **entier**. Représenté ici en `number`
 * plutôt qu'en `bigint` (05-architecture/05-stack.md §2.1 laisse le choix « bigint/number »)
 * pour rester sérialisable tel quel en JSON dans les enveloppes de commande
 * (`packages/contracts`) ; `Number.isSafeInteger` (± 9 × 10^15) offre une marge
 * considérable au-delà de toute valeur réaliste (H-06), vérifiée à chaque construction.
 *
 * INV-GLO-06 : un montant de document est toujours **≥ 0** ; le sens (entrée/sortie,
 * mouvement inverse) est porté par une colonne dédiée, jamais par un signe. `xaf()`
 * l'impose ; `splitSignedXaf()` sert au point de bascule entre un calcul signé (écart,
 * variance) et une écriture en base.
 */
import { assertSafeInteger, DomainError } from './errors.js';

declare const XafBrand: unique symbol;
export type Xaf = number & { readonly [XafBrand]: true };

/** Construit un montant XAF ; lève une erreur si négatif ou non entier (INV-GLO-06). */
export function xaf(value: number): Xaf {
  assertSafeInteger(value, 'Xaf');
  if (value < 0) {
    throw new DomainError(
      `Un montant XAF de document ne peut être négatif (reçu ${value}).`,
      'NEGATIVE_XAF',
    );
  }
  return value as Xaf;
}

export const ZERO_XAF = xaf(0);

/** Somme d'une ou plusieurs sommes XAF (toujours ≥ 0, comme chaque opérande). */
export function addXaf(...values: readonly Xaf[]): Xaf {
  const sum = values.reduce((acc, v) => acc + v, 0);
  return xaf(sum);
}

/**
 * Différence signée entre deux montants XAF (ex. écart de caisse : compté − attendu,
 * BR-DIS-007). Le résultat n'est **pas** un `Xaf` (il peut être négatif) : c'est un
 * entier XAF signé simple, à faire passer par {@link splitSignedXaf} avant toute
 * écriture dans une colonne de montant.
 */
export function differenceXaf(a: Xaf, b: Xaf): number {
  const diff = a - b;
  assertSafeInteger(diff, 'differenceXaf');
  return diff;
}

/** Éclate un montant signé en (montant ≥ 0, sens), pour l'écriture d'un mouvement. */
export function splitSignedXaf(value: number): { amount: Xaf; direction: 'IN' | 'OUT' } {
  assertSafeInteger(value, 'splitSignedXaf');
  return value >= 0
    ? { amount: xaf(value), direction: 'IN' }
    : { amount: xaf(-value), direction: 'OUT' };
}

export function compareXaf(a: Xaf, b: Xaf): -1 | 0 | 1 {
  return a === b ? 0 : a < b ? -1 : 1;
}

// Espace fine insécable (0x202f) et espace insécable ordinaire (0x00a0) : séparateurs de
// milliers que `toLocaleString('fr-FR')` peut produire selon l'environnement ICU. Codes
// numériques (pas d'échappement `\u` littéral dans la source) pour éviter toute ambiguïté
// d'encodage à la relecture ou à l'édition de ce fichier.
const NON_BREAKING_SPACE_CODES = [0x202f, 0x00a0];
const NON_BREAKING_SPACES = new RegExp(
  `[${NON_BREAKING_SPACE_CODES.map((c) => String.fromCharCode(c)).join('')}]`,
  'g',
);

/** Affichage simple avec séparateur de milliers (espace ordinaire) et suffixe XAF. */
export function formatXaf(value: Xaf): string {
  return `${value.toLocaleString('fr-FR').replace(NON_BREAKING_SPACES, ' ')} XAF`;
}

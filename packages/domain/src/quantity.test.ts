import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addQuantity,
  compareQuantity,
  formatQuantity,
  isPositiveQuantity,
  isWholeQuantity,
  isZeroQuantity,
  quantityFromDecimal,
  quantityFromMilli,
  quantityMilliUnits,
  quantityToDecimal,
  subtractQuantity,
  ZERO_QUANTITY,
} from './quantity.js';
import { DomainError } from './errors.js';

// Valeurs à 3 décimales maximum, représentables exactement en millièmes entiers.
const threeDecimals = fc
  .integer({ min: -1_000_000_000, max: 1_000_000_000 })
  .map((milli) => milli / 1000);

describe('quantityFromDecimal / quantityToDecimal (roundtrip exact, ADR-013)', () => {
  it("conserve la valeur décimale (jusqu'à 3 décimales) sans dérive", () => {
    fc.assert(
      fc.property(threeDecimals, (value) => {
        expect(quantityToDecimal(quantityFromDecimal(value))).toBeCloseTo(value, 9);
      }),
    );
  });

  it("rejette plus de 3 décimales (BR-CAT-003 : précision de l'unité de base)", () => {
    expect(() => quantityFromDecimal(1.2345)).toThrow(DomainError);
  });

  it('rejette une valeur non finie (NaN, Infinity)', () => {
    expect(() => quantityFromDecimal(Number.NaN)).toThrow(DomainError);
    expect(() => quantityFromDecimal(Number.POSITIVE_INFINITY)).toThrow(DomainError);
  });

  it('accepte exactement 3 décimales', () => {
    expect(quantityMilliUnits(quantityFromDecimal(3.5))).toBe(3500);
    expect(quantityMilliUnits(quantityFromDecimal(0.001))).toBe(1);
  });
});

describe('addQuantity / subtractQuantity : arithmétique entière exacte', () => {
  it('a + b − b = a (aucune dérive de flottant, contrairement à 0.1 + 0.2)', () => {
    fc.assert(
      fc.property(threeDecimals, threeDecimals, (a, b) => {
        const qa = quantityFromDecimal(a);
        const qb = quantityFromDecimal(b);
        const result = subtractQuantity(addQuantity(qa, qb), qb);
        expect(quantityMilliUnits(result)).toBe(quantityMilliUnits(qa));
      }),
    );
  });

  it('0.1 + 0.2 unités = 0.300 unité exactement (là où le flottant natif donne 0.30000000000000004)', () => {
    const sum = addQuantity(quantityFromDecimal(0.1), quantityFromDecimal(0.2));
    expect(quantityMilliUnits(sum)).toBe(300);
    expect(quantityToDecimal(sum)).toBe(0.3);
  });
});

describe('isWholeQuantity (BR-CAT-003 : unité comptée ⇒ quantité entière)', () => {
  it("vrai pour un nombre entier d'unités", () => {
    expect(isWholeQuantity(quantityFromDecimal(3))).toBe(true);
    expect(isWholeQuantity(ZERO_QUANTITY)).toBe(true);
  });

  it("faux dès qu'une décimale est présente", () => {
    expect(isWholeQuantity(quantityFromDecimal(3.5))).toBe(false);
    expect(isWholeQuantity(quantityFromDecimal(0.001))).toBe(false);
  });
});

describe('isPositiveQuantity / isZeroQuantity', () => {
  it('distingue positif, nul et négatif', () => {
    expect(isPositiveQuantity(quantityFromDecimal(1))).toBe(true);
    expect(isPositiveQuantity(ZERO_QUANTITY)).toBe(false);
    expect(isPositiveQuantity(quantityFromMilli(-1))).toBe(false);
    expect(isZeroQuantity(ZERO_QUANTITY)).toBe(true);
  });
});

describe('compareQuantity', () => {
  it('ordonne correctement', () => {
    expect(compareQuantity(quantityFromDecimal(1), quantityFromDecimal(2))).toBe(-1);
    expect(compareQuantity(quantityFromDecimal(2), quantityFromDecimal(1))).toBe(1);
    expect(compareQuantity(quantityFromDecimal(1), quantityFromDecimal(1))).toBe(0);
  });
});

describe('formatQuantity', () => {
  it("affiche jusqu'à 3 décimales sans zéros superflus", () => {
    expect(formatQuantity(quantityFromDecimal(3))).toBe('3');
    expect(formatQuantity(quantityFromDecimal(3.5))).toBe('3,5');
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addQuantity,
  compareQuantity,
  convertToBaseQuantity,
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

describe('convertToBaseQuantity — conditionnement vers unité de base (BR-CAT-003)', () => {
  const convert = (quantity: number, factor: string) =>
    quantityToDecimal(convertToBaseQuantity(quantityFromDecimal(quantity), factor));

  it('multiplie par le facteur, sans flottant', () => {
    expect(convert(2, '12.000000')).toBe(24);
    expect(convert(3, '0.5')).toBe(1.5);
    expect(convert(0.001, '1')).toBe(0.001);
    // 0,1 × 3 en flottant donne 0,30000000000000004.
    expect(convert(0.1, '3')).toBe(0.3);
  });

  it('arrondit au millième, demi supérieur', () => {
    expect(convert(1, '0.0005')).toBe(0.001);
    expect(convert(1, '0.000499')).toBe(0);
    expect(convert(3, '0.333333')).toBe(1);
  });

  it('refuse un facteur invalide ou nul et une quantité non positive', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as DomainError).code;
      }
      return 'OK';
    };
    expect(code(() => convertToBaseQuantity(quantityFromDecimal(1), '0'))).toBe('FACTOR_INVALID');
    expect(code(() => convertToBaseQuantity(quantityFromDecimal(1), '-2'))).toBe('FACTOR_INVALID');
    expect(code(() => convertToBaseQuantity(quantityFromDecimal(1), '1,5'))).toBe('FACTOR_INVALID');
    expect(code(() => convertToBaseQuantity(quantityFromDecimal(1), '1.1234567'))).toBe(
      'FACTOR_INVALID',
    );
    expect(code(() => convertToBaseQuantity(ZERO_QUANTITY, '2'))).toBe('QUANTITY_INVALID');
  });

  it('propriété : facteur entier = multiplication exacte des millièmes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (milli, factor) => {
          expect(
            quantityMilliUnits(convertToBaseQuantity(quantityFromMilli(milli), String(factor))),
          ).toBe(milli * factor);
        },
      ),
    );
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addXaf,
  compareXaf,
  differenceXaf,
  formatXaf,
  splitSignedXaf,
  xaf,
  ZERO_XAF,
} from './money.js';
import { DomainError } from './errors.js';

const safeXaf = fc.integer({ min: 0, max: 1_000_000_000_000 });

describe('xaf (INV-GLO-06 : montant de document toujours ≥ 0)', () => {
  it('accepte un entier positif ou nul', () => {
    fc.assert(
      fc.property(safeXaf, (v) => {
        expect(xaf(v)).toBe(v);
      }),
    );
  });

  it('rejette un montant négatif', () => {
    expect(() => xaf(-1)).toThrow(DomainError);
  });

  it('rejette une valeur non entière', () => {
    expect(() => xaf(1.5)).toThrow(DomainError);
  });

  it("rejette une valeur hors de l'entier sûr", () => {
    expect(() => xaf(Number.MAX_SAFE_INTEGER + 1)).toThrow(DomainError);
  });
});

describe('addXaf', () => {
  it('est associatif et commutatif (propriété algébrique)', () => {
    fc.assert(
      fc.property(safeXaf, safeXaf, safeXaf, (a, b, c) => {
        const left = addXaf(addXaf(xaf(a), xaf(b)), xaf(c));
        const right = addXaf(xaf(a), addXaf(xaf(b), xaf(c)));
        expect(left).toBe(right);
        expect(addXaf(xaf(a), xaf(b))).toBe(addXaf(xaf(b), xaf(a)));
      }),
    );
  });

  it('neutre : x + 0 = x', () => {
    fc.assert(
      fc.property(safeXaf, (a) => {
        expect(addXaf(xaf(a), ZERO_XAF)).toBe(a);
      }),
    );
  });

  it('sans opérande, renvoie zéro', () => {
    expect(addXaf()).toBe(0);
  });
});

describe('differenceXaf / splitSignedXaf (écart de caisse, BR-DIS-007)', () => {
  it('roundtrip : splitSignedXaf(differenceXaf(a, b)) redonne (a, b) selon le sens', () => {
    fc.assert(
      fc.property(safeXaf, safeXaf, (a, b) => {
        const diff = differenceXaf(xaf(a), xaf(b));
        const { amount, direction } = splitSignedXaf(diff);
        if (a >= b) {
          expect(direction).toBe('IN');
          expect(amount).toBe(a - b);
        } else {
          expect(direction).toBe('OUT');
          expect(amount).toBe(b - a);
        }
      }),
    );
  });

  it('un compte exact (compté = attendu) donne un écart nul en IN', () => {
    expect(splitSignedXaf(differenceXaf(xaf(5000), xaf(5000)))).toEqual({
      amount: 0,
      direction: 'IN',
    });
  });
});

describe('compareXaf', () => {
  it('ordonne correctement', () => {
    expect(compareXaf(xaf(100), xaf(200))).toBe(-1);
    expect(compareXaf(xaf(200), xaf(100))).toBe(1);
    expect(compareXaf(xaf(100), xaf(100))).toBe(0);
  });
});

describe('formatXaf', () => {
  it('insère un séparateur de milliers et le suffixe XAF', () => {
    expect(formatXaf(xaf(5600000))).toBe('5 600 000 XAF');
    expect(formatXaf(ZERO_XAF)).toBe('0 XAF');
  });
});

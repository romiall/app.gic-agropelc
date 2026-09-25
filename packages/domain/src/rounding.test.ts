import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { lineAmountXaf, roundHalfUpMilliXafToFranc } from './rounding.js';
import { quantityFromDecimal, quantityFromMilli } from './quantity.js';
import { xaf } from './money.js';

describe('roundHalfUpMilliXafToFranc (BR-VEN-014 : arrondi au franc, demi supérieur)', () => {
  it('arrondit 0,5 franc vers le haut (demi supérieur, pas arrondi bancaire)', () => {
    expect(roundHalfUpMilliXafToFranc(500)).toBe(1); // 0,500 XAF -> 1 XAF
    expect(roundHalfUpMilliXafToFranc(1500)).toBe(2); // 1,500 XAF -> 2 XAF (pas 2 arrondi pair->2, ici coïncide)
    expect(roundHalfUpMilliXafToFranc(2500)).toBe(3); // 2,500 XAF -> 3 XAF (l'arrondi bancaire donnerait 2)
  });

  it('arrondit en dessous de 0,5 vers le bas', () => {
    expect(roundHalfUpMilliXafToFranc(499)).toBe(0);
    expect(roundHalfUpMilliXafToFranc(1499)).toBe(1);
  });

  it('arrondit au-dessus de 0,5 vers le haut', () => {
    expect(roundHalfUpMilliXafToFranc(501)).toBe(1);
  });

  it('une valeur déjà entière reste inchangée', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (francs) => {
        expect(roundHalfUpMilliXafToFranc(francs * 1000)).toBe(francs);
      }),
    );
  });
});

describe('lineAmountXaf (BR-VEN-014, INV-VEN-03)', () => {
  it('quantité entière × prix entier = produit exact, sans arrondi à effectuer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (qtyUnits, priceXaf) => {
          const amount = lineAmountXaf(quantityFromMilli(qtyUnits * 1000), xaf(priceXaf));
          expect(amount).toBe(qtyUnits * priceXaf);
        },
      ),
    );
  });

  it('exemple chiffré : 2,5 kg à 2 000 XAF/kg = 5 000 XAF (tarification au poids, BR-CAT-009)', () => {
    expect(lineAmountXaf(quantityFromDecimal(2.5), xaf(2000))).toBe(5000);
  });

  it('exemple avec arrondi : 1,003 kg à 999 XAF/kg = 1 002,0 -> 1 002,00 -> arrondi à 1 002', () => {
    // 1.003 * 999 = 1001.997 -> 1 001 997 milli-XAF -> arrondi à 1002
    expect(lineAmountXaf(quantityFromDecimal(1.003), xaf(999))).toBe(1002);
  });
});

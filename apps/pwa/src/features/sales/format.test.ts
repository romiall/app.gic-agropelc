import { describe, expect, it } from 'vitest';
import { formatQuantityUnit, isPluralQuantity, unitLabel } from './format.js';

describe('unités (MP-09, AV-249)', () => {
  it('pluriel à partir de 2, quantité arrondie comme à l’affichage, signe ignoré', () => {
    expect(isPluralQuantity(0)).toBe(false);
    expect(isPluralQuantity(1)).toBe(false);
    expect(isPluralQuantity(1.5)).toBe(false);
    expect(isPluralQuantity(1.9996)).toBe(true);
    expect(isPluralQuantity(2)).toBe(true);
    expect(isPluralQuantity(-6)).toBe(true);
    expect(isPluralQuantity(Number.NaN)).toBe(false);
  });

  it('libellés courts des codes connus, symboles invariables', () => {
    expect(formatQuantityUnit(27, 'PLATEAU')).toBe('27 plateaux');
    expect(formatQuantityUnit(1, 'PIECE')).toBe('1 pièce');
    expect(formatQuantityUnit(500, 'KG')).toBe('500 kg');
    expect(formatQuantityUnit(12, 'TETE')).toBe('12 têtes');
    expect(formatQuantityUnit(1, 'TETE')).toBe('1 tête');
    expect(formatQuantityUnit(1.5, 'SAC')).toBe('1,5 sac');
    expect(formatQuantityUnit(-6, 'PLATEAU')).toBe('-6 plateaux');
    expect(formatQuantityUnit(2.5, 'L')).toBe('2,5 L');
    expect(unitLabel('KG')).toBe('kg');
    expect(unitLabel('OEUF', 30)).toBe('œufs');
  });

  it('repli : nom du catalogue, puis le code ; code vide ou inattendu', () => {
    const units = new Map([['BIDON', { name: 'Bidon de 20 L' }]]);
    expect(formatQuantityUnit(3, 'BIDON', units)).toBe('3 Bidon de 20 L');
    expect(unitLabel('BIDON', 1, units)).toBe('Bidon de 20 L');
    expect(formatQuantityUnit(3, 'U')).toBe('3 U');
    expect(formatQuantityUnit(3, '')).toBe('3');
    expect(unitLabel('constructor')).toBe('constructor');
    // Le libellé court l'emporte sur le nom du catalogue pour un code connu.
    expect(unitLabel('PLATEAU', 2, new Map([['PLATEAU', { name: 'Plateau de 30 œufs' }]]))).toBe(
      'plateaux',
    );
  });
});

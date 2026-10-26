import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { amountXafInFrenchWords, integerInFrenchWords } from './amount-in-words.js';
import { DomainError } from './errors.js';

describe('integerInFrenchWords (montant en lettres des pièces imprimées)', () => {
  it.each([
    [0, 'zéro'],
    [1, 'un'],
    [16, 'seize'],
    [17, 'dix-sept'],
    [21, 'vingt et un'],
    [22, 'vingt-deux'],
    [70, 'soixante-dix'],
    [71, 'soixante et onze'],
    [72, 'soixante-douze'],
    [80, 'quatre-vingts'],
    [81, 'quatre-vingt-un'],
    [91, 'quatre-vingt-onze'],
    [99, 'quatre-vingt-dix-neuf'],
    [100, 'cent'],
    [101, 'cent un'],
    [200, 'deux cents'],
    [201, 'deux cent un'],
    [280, 'deux cent quatre-vingts'],
    [1000, 'mille'],
    [1001, 'mille un'],
    [2000, 'deux mille'],
    [80_000, 'quatre-vingt mille'],
    [200_000, 'deux cent mille'],
    [281_500, 'deux cent quatre-vingt-un mille cinq cents'],
    [1_000_000, 'un million'],
    [2_500_000, 'deux millions cinq cent mille'],
    [3_000_000_000, 'trois milliards'],
  ])('%i → %s', (value, words) => {
    expect(integerInFrenchWords(value)).toBe(words);
  });

  it('rejette un montant négatif ou non entier', () => {
    expect(() => integerInFrenchWords(-1)).toThrow(DomainError);
    expect(() => integerInFrenchWords(1.5)).toThrow(DomainError);
  });

  it('ne laisse ni espace double ni trait d’union en bord (propriété)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999_999_999_999 }), (value) => {
        const words = integerInFrenchWords(value);
        expect(words).not.toMatch(/\s{2}|^[\s-]|[\s-]$/);
      }),
    );
  });
});

describe('amountXafInFrenchWords', () => {
  it('met une majuscule et la devise', () => {
    expect(amountXafInFrenchWords(50_000)).toBe('Cinquante mille francs CFA');
  });

  it('écrit « de » après un multiple exact du million', () => {
    expect(amountXafInFrenchWords(2_000_000)).toBe('Deux millions de francs CFA');
    expect(amountXafInFrenchWords(2_000_001)).toBe('Deux millions un francs CFA');
    expect(amountXafInFrenchWords(0)).toBe('Zéro franc CFA');
    expect(amountXafInFrenchWords(1)).toBe('Un franc CFA');
  });
});

import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_SUSPECT_MS, isClockSkewSuspect } from './clock-skew.js';

describe('isClockSkewSuspect (BR-SYN-011)', () => {
  it('faux pour un écart nul ou inconnu', () => {
    expect(isClockSkewSuspect(0)).toBe(false);
    expect(isClockSkewSuspect(null)).toBe(false);
  });

  it('faux à exactement le seuil (strictement supérieur exigé)', () => {
    expect(isClockSkewSuspect(CLOCK_SKEW_SUSPECT_MS)).toBe(false);
    expect(isClockSkewSuspect(-CLOCK_SKEW_SUSPECT_MS)).toBe(false);
  });

  it('vrai au-delà du seuil, dans les deux sens', () => {
    expect(isClockSkewSuspect(CLOCK_SKEW_SUSPECT_MS + 1)).toBe(true);
    expect(isClockSkewSuspect(-(CLOCK_SKEW_SUSPECT_MS + 1))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_STORED_MAX_MS,
  CLOCK_SKEW_SUSPECT_MS,
  OCCURRED_AT_FUTURE_TOLERANCE_DEFAULT_MS,
  clampClockSkewMs,
  clockSkewThresholdMsFrom,
  futureToleranceMsFrom,
  isClockSkewSuspect,
} from './clock-skew.js';

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

describe('seuil et tolérance paramétrés (P5-23 : AV-216, AV-226)', () => {
  it('seuil du drapeau : minutes > 0 (fractions admises), sinon 5 min ; plafonné', () => {
    expect(clockSkewThresholdMsFrom(2)).toBe(120_000);
    expect(clockSkewThresholdMsFrom(0.5)).toBe(30_000);
    for (const absurd of [0, -5, 'abc', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clockSkewThresholdMsFrom(absurd)).toBe(CLOCK_SKEW_SUSPECT_MS);
    }
    expect(clockSkewThresholdMsFrom(1e12)).toBe(CLOCK_SKEW_STORED_MAX_MS);
  });

  it('tolérance de date future : minutes ≥ 0 (zéro admis), sinon 5 min', () => {
    expect(futureToleranceMsFrom(0)).toBe(0);
    expect(futureToleranceMsFrom(30)).toBe(1_800_000);
    for (const absurd of [-1, '5', null, undefined, Number.NaN]) {
      expect(futureToleranceMsFrom(absurd)).toBe(OCCURRED_AT_FUTURE_TOLERANCE_DEFAULT_MS);
    }
  });

  it('drapeau au seuil donné, strictement supérieur, dans les deux sens', () => {
    expect(isClockSkewSuspect(120_000, 120_000)).toBe(false);
    expect(isClockSkewSuspect(120_001, 120_000)).toBe(true);
    expect(isClockSkewSuspect(-120_001, 120_000)).toBe(true);
    expect(isClockSkewSuspect(600_000, 3_600_000)).toBe(false);
  });
});

describe('écart borné au stockage (AV-227)', () => {
  it('borne à ±INT_MAX, tronque en millisecondes entières', () => {
    expect(clampClockSkewMs(40 * 86_400_000)).toBe(CLOCK_SKEW_STORED_MAX_MS);
    expect(clampClockSkewMs(-40 * 86_400_000)).toBe(-CLOCK_SKEW_STORED_MAX_MS);
    expect(clampClockSkewMs(1234.9)).toBe(1234);
    expect(clampClockSkewMs(Number.POSITIVE_INFINITY)).toBe(CLOCK_SKEW_STORED_MAX_MS);
    expect(isClockSkewSuspect(clampClockSkewMs(40 * 86_400_000))).toBe(true);
  });
});

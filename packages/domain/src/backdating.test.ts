import { describe, expect, it } from 'vitest';
import {
  backdatingRefusal,
  backdatingWindowFrom,
  evaluateBackdatingGap,
  type BackdatingWindow,
} from './backdating.js';

const HOUR = 60 * 60 * 1000;
const window24_72: BackdatingWindow = { justificationAfterHours: 24, maxHours: 72 };

describe('backdatingWindowFrom — réglages de la fenêtre (AV-078)', () => {
  it('lit les deux réglages, nombres ou chaînes décimales', () => {
    expect(backdatingWindowFrom(12, 48)).toEqual({ justificationAfterHours: 12, maxHours: 48 });
    expect(backdatingWindowFrom('6', '36')).toEqual({ justificationAfterHours: 6, maxHours: 36 });
  });

  it('absent ou absurde : les défauts d’AV-078 (24 h, 72 h)', () => {
    expect(backdatingWindowFrom(undefined, undefined)).toEqual(window24_72);
    expect(backdatingWindowFrom(null, 'abc')).toEqual(window24_72);
    expect(backdatingWindowFrom(-5, -1)).toEqual(window24_72);
    expect(backdatingWindowFrom(Number.NaN, Number.POSITIVE_INFINITY)).toEqual(window24_72);
  });

  it('le maximum n’est jamais inférieur au seuil du motif', () => {
    expect(backdatingWindowFrom(48, 24)).toEqual({ justificationAfterHours: 48, maxHours: 48 });
  });
});

describe('evaluateBackdatingGap — écart client_created_at − occurred_at', () => {
  it('dans la fenêtre : aucune formalité, bornes comprises', () => {
    expect(evaluateBackdatingGap(0, window24_72)).toMatchObject({
      requiresReason: false,
      exceedsWindow: false,
    });
    expect(evaluateBackdatingGap(24 * HOUR, window24_72)).toMatchObject({
      requiresReason: false,
      exceedsWindow: false,
    });
  });

  it('au-delà de 24 h : un motif est exigé ; au-delà de 72 h : fenêtre dépassée', () => {
    expect(evaluateBackdatingGap(24 * HOUR + 1, window24_72)).toMatchObject({
      requiresReason: true,
      exceedsWindow: false,
    });
    expect(evaluateBackdatingGap(72 * HOUR, window24_72).exceedsWindow).toBe(false);
    expect(evaluateBackdatingGap(72 * HOUR + 1, window24_72)).toMatchObject({
      requiresReason: true,
      exceedsWindow: true,
    });
  });

  it('une date postérieure à la saisie n’est pas rétroactive ; l’écart se lit en heures', () => {
    expect(evaluateBackdatingGap(-3 * HOUR, window24_72)).toEqual({
      gapHours: -3,
      requiresReason: false,
      exceedsWindow: false,
    });
    expect(evaluateBackdatingGap(30.04 * HOUR, window24_72).gapHours).toBe(30);
    expect(evaluateBackdatingGap(Number.NaN, window24_72).gapHours).toBe(0);
  });
});

describe('backdatingRefusal', () => {
  const inside = evaluateBackdatingGap(2 * HOUR, window24_72);
  const justified = evaluateBackdatingGap(30 * HOUR, window24_72);
  const tooOld = evaluateBackdatingGap(100 * HOUR, window24_72);
  const noRight = { hasReason: false, canExceedWindow: false };

  it('dans la fenêtre : passe, avec ou sans motif', () => {
    expect(backdatingRefusal(inside, noRight)).toBeNull();
    expect(backdatingRefusal(inside, { hasReason: true, canExceedWindow: false })).toBeNull();
  });

  it('entre 24 h et 72 h : sans motif JUSTIFICATION_REQUIRED, avec motif passe', () => {
    expect(backdatingRefusal(justified, noRight)).toBe('JUSTIFICATION_REQUIRED');
    expect(backdatingRefusal(justified, { hasReason: true, canExceedWindow: false })).toBeNull();
  });

  it('au-delà de 72 h : BACKDATE_EXCEEDED, même avec un motif', () => {
    expect(backdatingRefusal(tooOld, noRight)).toBe('BACKDATE_EXCEEDED');
    expect(backdatingRefusal(tooOld, { hasReason: true, canExceedWindow: false })).toBe(
      'BACKDATE_EXCEEDED',
    );
  });

  it('qui peut dépasser la fenêtre n’est pas dispensé du motif', () => {
    expect(backdatingRefusal(tooOld, { hasReason: false, canExceedWindow: true })).toBe(
      'JUSTIFICATION_REQUIRED',
    );
    expect(backdatingRefusal(tooOld, { hasReason: true, canExceedWindow: true })).toBeNull();
  });
});

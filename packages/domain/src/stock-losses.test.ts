import { describe, expect, it } from 'vitest';
import {
  lossApprovalNeedsValue,
  lossApprovalRuleOf,
  lossRequiresApproval,
} from './stock-losses.js';

// Politique par défaut semée (AV-037, Q50 A du 08/11/2026).
const DEFAULT_CONDITION = {
  alwaysCategories: ['DESTRUCTION', 'INEXPLIQUEE', 'VOL_SUSPECTE'],
  thresholdCategories: ['CASSE', 'DETERIORATION', 'IMPROPRE'],
  thresholdXaf: 25_000,
};

describe('validation d’une perte hors mortalité (AV-037, Q50 A)', () => {
  const rule = lossApprovalRuleOf(DEFAULT_CONDITION);

  it('destruction, perte inexpliquée et vol suspecté : toujours validés, même à 0 XAF', () => {
    for (const category of ['DESTRUCTION', 'INEXPLIQUEE', 'VOL_SUSPECTE']) {
      expect(lossRequiresApproval({ category, valueXaf: 0, rule }), category).toBe(true);
      expect(lossRequiresApproval({ category, valueXaf: 1_000_000, rule }), category).toBe(true);
    }
  });

  it('casse, détérioration et produit impropre : validés à partir de 25 000 XAF (borne incluse)', () => {
    for (const category of ['CASSE', 'DETERIORATION', 'IMPROPRE']) {
      expect(lossRequiresApproval({ category, valueXaf: 24_999, rule }), category).toBe(false);
      expect(lossRequiresApproval({ category, valueXaf: 25_000, rule }), category).toBe(true);
      expect(lossRequiresApproval({ category, valueXaf: 80_000, rule }), category).toBe(true);
    }
  });

  it('une catégorie que la règle ne nomme pas n’est pas validée', () => {
    expect(lossRequiresApproval({ category: 'AUTRE', valueXaf: 1_000_000, rule })).toBe(false);
  });

  it('une politique sans règle par catégorie valide toute perte (comportement d’avant)', () => {
    expect(lossApprovalRuleOf({})).toBeNull();
    expect(lossApprovalRuleOf(null)).toBeNull();
    expect(lossApprovalRuleOf([])).toBeNull();
    expect(lossApprovalRuleOf({ relativePct: 0 })).toBeNull();
    expect(lossRequiresApproval({ category: 'CASSE', valueXaf: 1, rule: null })).toBe(true);
  });

  it('un seuil absent, négatif ou non numérique vaut 0 : jamais d’exemption par erreur de saisie', () => {
    for (const thresholdXaf of [undefined, -5, 'abc', Number.NaN]) {
      const lax = lossApprovalRuleOf({ thresholdCategories: ['CASSE'], thresholdXaf });
      expect(lax?.thresholdXaf).toBe(0);
      expect(lossRequiresApproval({ category: 'CASSE', valueXaf: 0, rule: lax })).toBe(true);
    }
  });

  it('les entrées qui ne sont pas des chaînes sont ignorées', () => {
    expect(lossApprovalRuleOf({ alwaysCategories: ['VOL_SUSPECTE', 3, null] })).toEqual({
      alwaysCategories: ['VOL_SUSPECTE'],
      thresholdCategories: [],
      thresholdXaf: 0,
    });
  });

  it('la valeur n’est utile que pour une catégorie à seuil', () => {
    expect(lossApprovalNeedsValue('CASSE', rule)).toBe(true);
    expect(lossApprovalNeedsValue('DESTRUCTION', rule)).toBe(false);
    expect(lossApprovalNeedsValue('CASSE', null)).toBe(false);
  });
});

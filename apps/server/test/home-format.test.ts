/** Mise en forme de l'accueil : ventilation des ventes signalées et gravité (AV-255, MP-09). */
import { describe, expect, it } from 'vitest';
import {
  flaggedSalesDetail,
  flaggedSalesSignal,
  hasControlFlag,
} from '../src/home-api/home-format.js';

describe('Accueil : ventes signalées (AV-255)', () => {
  it('ventilation : contrôles d’abord, du plus fréquent au plus rare ; code inconnu tel quel', () => {
    expect(
      flaggedSalesDetail(
        new Map([
          ['OUT_OF_SESSION', 5],
          ['PRICE_MISMATCH', 1],
          ['STOCK_NEGATIVE', 2],
          ['FUTUR', 1],
        ]),
      ),
    ).toBe(
      'Stock devenu négatif : 2 · FUTUR : 1 · Prix différent du catalogue : 1 · Vente hors prise de service : 5',
    );
  });

  it('ventilation coupée à 240 caractères par « … »', () => {
    const many = new Map(
      Array.from({ length: 30 }, (_, index) => [`DRAPEAU_${index}`, 30 - index] as const),
    );
    const detail = flaggedSalesDetail(many);
    expect(detail.length).toBeLessThanOrEqual(240);
    expect(detail.endsWith('…')).toBe(true);
    expect(detail.startsWith('DRAPEAU_0 : 30 · DRAPEAU_1 : 29')).toBe(true);
  });

  it('gravité : avertissement dès un drapeau de contrôle, information pour la seule vente hors prise de service', () => {
    expect(hasControlFlag(new Map([['OUT_OF_SESSION', 3]]))).toBe(false);
    expect(
      hasControlFlag(
        new Map([
          ['OUT_OF_SESSION', 3],
          ['PRICE_MISMATCH', 1],
        ]),
      ),
    ).toBe(true);
    expect(hasControlFlag(new Map([['FUTUR', 1]]))).toBe(true);
  });

  it('signal : information pour les seules ventes hors prise de service, avertissement sinon ; lien ; rien sans vente', () => {
    expect(flaggedSalesSignal({ salesCount: 3, byFlag: new Map([['OUT_OF_SESSION', 3]]) })).toEqual(
      {
        code: 'SALES_FLAGGED',
        severity: 'INFO',
        title: '3 ventes du jour signalées',
        detail: 'Vente hors prise de service : 3',
        count: 3,
        action: { label: 'Voir les ventes signalées', route: null },
      },
    );
    expect(
      flaggedSalesSignal({
        salesCount: 1,
        byFlag: new Map([
          ['OUT_OF_SESSION', 1],
          ['PRICE_MISMATCH', 1],
        ]),
      }),
    ).toMatchObject({ severity: 'WARNING', title: '1 vente du jour signalée', count: 1 });
    expect(flaggedSalesSignal({ salesCount: 0, byFlag: new Map() })).toBeNull();
  });
});

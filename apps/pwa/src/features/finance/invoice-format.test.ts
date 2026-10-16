import { describe, expect, it } from 'vitest';
import { INVOICE_MISMATCH_REASONS, type InvoiceMismatchDetail } from '@gic/domain';
import i18next from '../../i18n/index.js';
import { mismatchText } from './invoice-format.js';

const t = i18next.t.bind(i18next);
const detail = (overrides: Partial<InvoiceMismatchDetail>): InvoiceMismatchDetail => ({
  reason: 'PRICE_MISMATCH',
  lineIndex: null,
  poLineId: null,
  expected: null,
  actual: null,
  ...overrides,
});

describe('écarts de rapprochement en clair (ECR-FIN-03, P8E-05)', () => {
  it('chaque raison du registre a son texte ; montants en F CFA, quantités décimales', () => {
    const texts = INVOICE_MISMATCH_REASONS.map((reason) =>
      mismatchText(t, detail({ reason, lineIndex: 1, expected: 1_000, actual: 1_500 })),
    );
    expect(texts).toEqual([
      'Facture sans bon de commande : à examiner.',
      'Fournisseur différent de celui du bon de commande.',
      expect.stringMatching(/^Ligne 2 hors du bon de commande \(1\s500 F CFA\)\.$/),
      'Quantité facturée au-delà de l’accepté pour une ligne du bon : 1500 facturés au total pour 1000 acceptés.',
      expect.stringMatching(/^Ligne 2 : prix 1\s500 F CFA au lieu de 1\s000 F CFA\.$/),
      expect.stringMatching(
        /^Ligne 2 : montant 1\s500 F CFA au lieu de 1\s000 F CFA \(quantité × prix\)\.$/,
      ),
      expect.stringMatching(
        /^Total imprimé 1\s500 F CFA au lieu de 1\s000 F CFA \(somme des lignes\)\.$/,
      ),
      'Ligne 2 : produit différent de celui du bon de commande.',
    ]);
    expect(INVOICE_MISMATCH_REASONS).toHaveLength(8);
  });

  it('quantité décimale à la virgule, produit nommé, valeurs absentes et raison inconnue', () => {
    expect(
      mismatchText(
        t,
        detail({
          reason: 'QUANTITY_ABOVE_ACCEPTED',
          poLineId: 'po-1',
          expected: 10,
          actual: 12.5,
        }),
        (poLineId) => (poLineId === 'po-1' ? 'Aliment ponte' : null),
      ),
    ).toBe(
      'Quantité facturée au-delà de l’accepté pour Aliment ponte : 12,5 facturés au total pour 10 acceptés.',
    );
    expect(mismatchText(t, detail({ reason: 'TOTAL_MISMATCH', expected: 1_000 }))).toMatch(
      /^Total imprimé — au lieu de 1\s000 F CFA/,
    );
    expect(mismatchText(t, detail({ reason: 'QUANTITY_ABOVE_ACCEPTED', expected: 10 }))).toBe(
      'Quantité facturée au-delà de l’accepté pour une ligne du bon : — facturés au total pour 10 acceptés.',
    );
    expect(mismatchText(t, detail({ reason: 'UNKNOWN_REASON' as never }))).toBe('UNKNOWN_REASON');
  });
});

import { describe, expect, it } from 'vitest';
import {
  LOT_OPENING_MAX_AGE_DAYS,
  LOT_OPENING_MAX_HEADCOUNT,
  LOT_OPENING_MAX_UNIT_VALUE_XAF,
  lotOpeningIssues,
  lotOpeningSummary,
  type LotOpeningDeclaration,
} from './lot-opening.js';

/** Le 9 novembre 2026 à 10 h, heure de Douala (UTC+1). */
const NOW = new Date('2026-11-09T09:00:00.000Z');

const declaration = (overrides: Partial<LotOpeningDeclaration> = {}): LotOpeningDeclaration => ({
  lotType: 'POULET_CHAIR',
  productSpecies: 'POULET_CHAIR',
  placedOn: '2026-10-05',
  quantity: 4800,
  valueXaf: 5_760_000,
  ...overrides,
});

const codes = (overrides: Partial<LotOpeningDeclaration> = {}, at: Date = NOW): string[] =>
  lotOpeningIssues(declaration(overrides), at).map((issue) => issue.code);

describe('reprise d’un lot en cours : contrôles de la déclaration (BR-PRD-016)', () => {
  it('une déclaration cohérente n’a aucun défaut', () => {
    expect(lotOpeningIssues(declaration(), NOW)).toEqual([]);
    // Valeur nulle : permise (valeur inconnue au départ), la Direction la voit dans la demande.
    expect(codes({ valueXaf: 0 })).toEqual([]);
  });

  it('effectif : entier de 1 à la borne', () => {
    expect(codes({ quantity: 1 })).toEqual([]);
    expect(codes({ quantity: LOT_OPENING_MAX_HEADCOUNT, valueXaf: 0 })).toEqual([]);
    for (const quantity of [0, -3, 12.5, Number.NaN, LOT_OPENING_MAX_HEADCOUNT + 1]) {
      expect(codes({ quantity }), String(quantity)).toContain('LOT_OPENING_QUANTITY_INVALID');
    }
  });

  it('valeur : entier nul ou positif, au plus la borne par tête', () => {
    expect(codes({ quantity: 10, valueXaf: 10 * LOT_OPENING_MAX_UNIT_VALUE_XAF })).toEqual([]);
    expect(codes({ quantity: 10, valueXaf: 10 * LOT_OPENING_MAX_UNIT_VALUE_XAF + 1 })).toEqual([
      'LOT_OPENING_VALUE_TOO_HIGH',
    ]);
    for (const valueXaf of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(codes({ valueXaf }), String(valueXaf)).toContain('LOT_OPENING_VALUE_INVALID');
    }
    // Un effectif invalide ne se double pas d’un faux reproche de valeur par tête.
    expect(codes({ quantity: 0, valueXaf: 100_000_000_000 })).toEqual([
      'LOT_OPENING_QUANTITY_INVALID',
    ]);
  });

  it('mise en place : un jour réel, ni dans le futur de la déclaration ni vieux de plus de trois ans', () => {
    // Le jour de la déclaration (heure de Douala) est permis.
    expect(codes({ placedOn: '2026-11-09' })).toEqual([]);
    expect(codes({ placedOn: '2026-11-10' })).toEqual(['LOT_OPENING_DATE_FUTURE']);
    // 1 100 jours avant le 09/11/2026 (un 29 février entre les deux) : le 05/11/2023.
    expect(LOT_OPENING_MAX_AGE_DAYS).toBe(1100);
    expect(codes({ placedOn: '2023-11-05' })).toEqual([]);
    expect(codes({ placedOn: '2023-11-04' })).toEqual(['LOT_OPENING_DATE_TOO_OLD']);
    for (const placedOn of ['2026-02-30', '05/10/2026', '', '2026-13-01']) {
      expect(codes({ placedOn }), placedOn).toEqual(['LOT_OPENING_DATE_INVALID']);
    }
  });

  it('le jour de la déclaration est celui de Douala, pas celui d’UTC', () => {
    // 23 h 30 UTC le 9 novembre = 00 h 30 à Douala le 10 novembre.
    const lateEvening = new Date('2026-11-09T23:30:00.000Z');
    expect(codes({ placedOn: '2026-11-10' }, lateEvening)).toEqual([]);
    expect(codes({ placedOn: '2026-11-11' }, lateEvening)).toEqual(['LOT_OPENING_DATE_FUTURE']);
  });

  it('produit : l’espèce doit être celle du type de lot (BR-PRD-001)', () => {
    expect(codes({ productSpecies: 'PONDEUSE' })).toEqual(['PRODUCT_INVALID']);
    expect(codes({ productSpecies: null })).toEqual(['PRODUCT_INVALID']);
    expect(codes({ lotType: 'PONDEUSE', productSpecies: 'PONDEUSE' })).toEqual([]);
    // Un reproducteur volaille admet les deux souches.
    expect(codes({ lotType: 'REPRODUCTEUR_VOLAILLE', productSpecies: 'POULET_CHAIR' })).toEqual([]);
    expect(codes({ lotType: 'PORC_NAISSAGE', productSpecies: 'PORC' })).toEqual([]);
    expect(codes({ lotType: 'PORC_NAISSAGE', productSpecies: 'POULET_CHAIR' })).toEqual([
      'PRODUCT_INVALID',
    ]);
  });

  it('rend tous les défauts d’un coup, avec le champ concerné', () => {
    const issues = lotOpeningIssues(
      declaration({ quantity: 0, valueXaf: -5, placedOn: '2099-01-01', productSpecies: null }),
      NOW,
    );
    expect(issues.map((issue) => [issue.code, issue.field])).toEqual([
      ['LOT_OPENING_QUANTITY_INVALID', 'quantity'],
      ['LOT_OPENING_VALUE_INVALID', 'valueXaf'],
      ['LOT_OPENING_DATE_FUTURE', 'placedOn'],
      ['PRODUCT_INVALID', 'productId'],
    ]);
    for (const issue of issues) expect(issue.message.length).toBeGreaterThan(10);
  });
});

describe('résumé de la demande de validation', () => {
  it('nomme le produit, l’effectif et la date, sans aucune valeur au coût (RC-05)', () => {
    const summary = lotOpeningSummary({
      productName: 'Poulet de chair vif',
      quantity: 4800,
      placedOn: '2026-10-05',
    });
    expect(summary).toBe(
      'Reprise d’un lot en cours : Poulet de chair vif, 4800 têtes mises en place le 05/10/2026',
    );
  });
});

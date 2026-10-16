import { describe, expect, it } from 'vitest';
import {
  costEntriesPath,
  lossesPath,
  lotCodePaths,
  lotPath,
  lotsPath,
  lotWithoutSales,
  namedPeriod,
  overviewPath,
  periodIssue,
  sortCostEntries,
  sortLots,
  type CostEntry,
  type LotChoice,
} from './costs.js';

// Samedi 10 octobre 2026.
const TODAY = '2026-10-10';

describe('coûts et marges (ECR-FIN-06, P8E-08)', () => {
  it('périodes nommées en cours, arrêtées à aujourd’hui', () => {
    expect(namedPeriod('MONTH', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
    expect(namedPeriod('WEEK', TODAY)).toEqual({ from: '2026-10-05', to: TODAY });
    expect(namedPeriod('TODAY', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(namedPeriod('YEAR', TODAY)).toEqual({ from: '2026-01-01', to: TODAY });
    // Le dernier jour du mois n'est pas tronqué.
    expect(namedPeriod('MONTH', '2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('période choisie : dates, ordre, avenir, un an au plus', () => {
    expect(periodIssue('2026-09-01', TODAY, TODAY)).toBeNull();
    expect(periodIssue('2026-10-02', '2026-10-01', TODAY)).toBe('ORDER');
    expect(periodIssue('2026-10-01', '2026-10-11', TODAY)).toBe('FUTURE');
    expect(periodIssue('2025-10-09', TODAY, TODAY)).toBe('TOO_LONG');
    expect(periodIssue('2025-10-10', TODAY, TODAY)).toBeNull();
    expect(periodIssue('2026-13-01', TODAY, TODAY)).toBe('DATE_INVALID');
  });

  it('chemins des lectures', () => {
    expect(overviewPath('2026-10-01', TODAY)).toBe(
      '/api/v1/finance/overview?from=2026-10-01&to=2026-10-10',
    );
    expect(lossesPath('2026-10-01', TODAY, 'lot')).toBe(
      '/api/v1/losses/summary?from=2026-10-01&to=2026-10-10&group_by=lot',
    );
    expect(lotsPath('SELLING')).toBe('/api/v1/production/lots?status=SELLING&limit=50');
    expect(lotPath('l1')).toBe('/api/v1/production/lots/l1');
    expect(costEntriesPath('l1')).toBe(
      '/api/v1/costs?cost_object_type=PRODUCTION_LOT&cost_object_id=l1&limit=200',
    );
    expect(lotCodePaths()).toEqual([
      '/api/v1/production/lots?status=ACTIVE&limit=200',
      '/api/v1/production/lots?status=SELLING&limit=200',
      '/api/v1/production/lots?status=CLOSED&limit=200',
    ]);
  });

  it('lot sans vente : aucune tête vendue et aucun chiffre d’affaires, montant masqué compté nul', () => {
    const sales = {
      netRevenueXaf: 0,
      slaughterProductsRevenueXaf: 0,
      costOfSalesXaf: 0,
      soldQuantity: 0,
      lotMarginXaf: 0,
      grossMarginXaf: 0,
    };
    expect(lotWithoutSales(sales)).toBe(true);
    expect(lotWithoutSales({ ...sales, netRevenueXaf: null })).toBe(true);
    expect(lotWithoutSales({ ...sales, soldQuantity: 1 })).toBe(false);
    // Produits d'abattage vendus sans tête : le lot a des ventes.
    expect(lotWithoutSales({ ...sales, netRevenueXaf: 5_000 })).toBe(false);
  });

  it('tris : écritures et lots du plus récent au plus ancien ; un lot lu deux fois une fois', () => {
    const entry = (id: string, occurredAt: string) => ({ id, occurredAt }) as CostEntry;
    expect(
      sortCostEntries([
        entry('a', '2026-10-01T08:00:00.000Z'),
        entry('c', '2026-10-03T08:00:00.000Z'),
        entry('b', '2026-10-01T08:00:00.000Z'),
      ]).map((item) => item.id),
    ).toEqual(['c', 'b', 'a']);
    const lot = (id: string, occurredAt: string, status = 'CLOSED') =>
      ({ id, occurredAt, status }) as LotChoice;
    expect(
      sortLots([
        lot('a', '2026-09-01T08:00:00.000Z'),
        lot('b', '2026-09-02T08:00:00.000Z'),
        lot('a', '2026-09-01T08:00:00.000Z', 'SELLING'),
      ]).map((item) => [item.id, item.status]),
    ).toEqual([
      ['b', 'CLOSED'],
      ['a', 'SELLING'],
    ]);
    // Même instant : l'identifiant le plus grand d'abord.
    expect(
      sortLots([lot('x', '2026-09-01T08:00:00.000Z'), lot('y', '2026-09-01T08:00:00.000Z')]).map(
        (item) => item.id,
      ),
    ).toEqual(['y', 'x']);
  });
});

/**
 * P8-11 : composition de la marge d'un lot avec les ventes de ses produits d'abattage (ADR-044 §1 ;
 * AV-279 ; stratégie finance §6.2-6.3) — fonction pure `composeLotSales`.
 */
import { describe, expect, it } from 'vitest';
import { composeLotSales } from '../src/production-api/lot-margin.js';
import type { LotRevenue } from '../src/modules/sales/application/public/index.js';

const revenue = (overrides: Partial<LotRevenue> & Pick<LotRevenue, 'lotId'>): LotRevenue => ({
  grossRevenueXaf: 0,
  cancelledXaf: 0,
  netRevenueXaf: 0,
  costOfSalesXaf: 0,
  soldQuantity: 0,
  months: [],
  ...overrides,
});

describe('composeLotSales (P8-11)', () => {
  const costs = {
    netXaf: 5_600_000,
    monthly: [
      { period: '2026-09', debitXaf: 3_000_000, creditXaf: 0, netXaf: 3_000_000 },
      { period: '2026-10', debitXaf: 2_600_000, creditXaf: 0, netXaf: 2_600_000 },
    ],
  };

  it('lot vendu vif : exemple de la stratégie finance §6.2 (CA 10 741 500, marge 5 141 500)', () => {
    const own = revenue({
      lotId: 'lot',
      grossRevenueXaf: 10_741_500,
      netRevenueXaf: 10_741_500,
      costOfSalesXaf: 5_600_000,
      soldQuantity: 2_310,
      months: [{ period: '2026-10', revenueXaf: 10_741_500, costOfSalesXaf: 5_600_000 }],
    });
    const { sales, monthly } = composeLotSales(costs, own, []);
    expect(sales).toEqual({
      grossRevenueXaf: 10_741_500,
      cancelledXaf: 0,
      netRevenueXaf: 10_741_500,
      costOfSalesXaf: 5_600_000,
      soldQuantity: 2_310,
      slaughterProductsRevenueXaf: 0,
      lotMarginXaf: 5_141_500,
      grossMarginXaf: 5_141_500,
    });
    expect(monthly).toEqual([
      { period: '2026-09', debitXaf: 3_000_000, creditXaf: 0, netXaf: 3_000_000, revenueXaf: 0 },
      {
        period: '2026-10',
        debitXaf: 2_600_000,
        creditXaf: 0,
        netXaf: 2_600_000,
        revenueXaf: 10_741_500,
      },
    ]);
  });

  it('lot abattu : le CA des produits entre dans la marge ; la quantité vendue reste celle des têtes', () => {
    const own = revenue({ lotId: 'lot', netRevenueXaf: 0, soldQuantity: 0 });
    const carcasses = revenue({
      lotId: 'carcasses',
      grossRevenueXaf: 7_000_000,
      cancelledXaf: 100_000,
      netRevenueXaf: 6_900_000,
      costOfSalesXaf: 4_000_000,
      soldQuantity: 3_100.5,
      months: [{ period: '2026-11', revenueXaf: 6_900_000, costOfSalesXaf: 4_000_000 }],
    });
    const offal = revenue({
      lotId: 'abats',
      netRevenueXaf: 500_000,
      grossRevenueXaf: 500_000,
      costOfSalesXaf: 300_000,
      soldQuantity: 120,
      months: [{ period: '2026-10', revenueXaf: 500_000, costOfSalesXaf: 300_000 }],
    });
    const { sales, monthly } = composeLotSales(costs, own, [carcasses, offal]);
    expect(sales).toMatchObject({
      grossRevenueXaf: 7_500_000,
      cancelledXaf: 100_000,
      netRevenueXaf: 7_400_000,
      costOfSalesXaf: 4_300_000,
      soldQuantity: 0,
      slaughterProductsRevenueXaf: 7_400_000,
      lotMarginXaf: 1_800_000,
      grossMarginXaf: 3_100_000,
    });
    expect(monthly.map((line) => [line.period, line.revenueXaf, line.netXaf])).toEqual([
      ['2026-09', 0, 3_000_000],
      ['2026-10', 500_000, 2_600_000],
      ['2026-11', 6_900_000, 0],
    ]);
  });
});

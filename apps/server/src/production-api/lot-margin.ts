/**
 * Composition du chiffre d'affaires et des marges d'un lot de production (P4-09, P8-11 ; stratégie
 * finance §6.2-6.3 ; ADR-062 §1 ; AV-366) : ventes du lot et de ses produits d'abattage, résultat
 * mensuel (coûts et CA), « marge de lot » (CA net − coût net du lot) et « marge brute des ventes »
 * (CA net − coût figé des ventes). La quantité vendue reste celle du lot (têtes) ; le CA des produits
 * est détaillé à part. Fonction pure, sans entrée-sortie.
 */
import type { LotRevenue } from '../modules/sales/application/public/index.js';

export interface LotCostsForMargin {
  readonly netXaf: number;
  readonly monthly: readonly {
    readonly period: string;
    readonly debitXaf: number;
    readonly creditXaf: number;
    readonly netXaf: number;
  }[];
}

export function composeLotSales(
  costs: LotCostsForMargin,
  own: LotRevenue,
  products: readonly LotRevenue[],
) {
  const all = [own, ...products];
  const sum = (pick: (revenue: LotRevenue) => number) =>
    all.reduce((total, revenue) => total + pick(revenue), 0);
  const byPeriod = new Map<string, number>();
  for (const month of all.flatMap((revenue) => revenue.months)) {
    byPeriod.set(month.period, (byPeriod.get(month.period) ?? 0) + month.revenueXaf);
  }
  const periods = new Set([...costs.monthly.map((line) => line.period), ...byPeriod.keys()]);
  const costByPeriod = new Map(costs.monthly.map((line) => [line.period, line]));
  const monthly = [...periods].sort().map((period) => ({
    ...(costByPeriod.get(period) ?? { period, debitXaf: 0, creditXaf: 0, netXaf: 0 }),
    revenueXaf: byPeriod.get(period) ?? 0,
  }));
  const netRevenueXaf = sum((revenue) => revenue.netRevenueXaf);
  const costOfSalesXaf = sum((revenue) => revenue.costOfSalesXaf);
  return {
    monthly,
    sales: {
      grossRevenueXaf: sum((revenue) => revenue.grossRevenueXaf),
      cancelledXaf: sum((revenue) => revenue.cancelledXaf),
      netRevenueXaf,
      costOfSalesXaf,
      soldQuantity: own.soldQuantity,
      slaughterProductsRevenueXaf: products.reduce(
        (total, revenue) => total + revenue.netRevenueXaf,
        0,
      ),
      lotMarginXaf: netRevenueXaf - costs.netXaf,
      grossMarginXaf: netRevenueXaf - costOfSalesXaf,
    },
  };
}

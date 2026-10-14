/**
 * Composition du chiffre d'affaires et des marges d'un lot de production (P4-09, P8-11 ; stratégie
 * finance §6.2-6.3 ; ADR-044 §1 ; AV-279) : ventes du lot et de ses produits d'abattage, résultat
 * mensuel (coûts et CA), « marge de lot » (CA net − coût net du lot) et « marge brute des ventes »
 * (CA net − coût figé des ventes). La quantité vendue reste celle du lot (têtes) ; le CA des produits
 * est détaillé à part. `composeLotSales` est pure ; `lotWithSales` lit les ventes (lot de stock du lot
 * et lots de ses abattages) et compose le détail rendu par `GET /production/lots/:id`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { lotRevenue, type LotRevenue } from '../modules/sales/application/public/index.js';
import {
  slaughterStockLotIds,
  type ProductionLotDetail,
} from '../modules/production/application/public/index.js';

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

/**
 * Détail d'un lot avec son CA et ses marges (P4-09, P8-11) : ventes de son lot de stock et des lots de
 * stock de ses abattages enregistrés (`slaughterStockLotIds`), coûts mensuels complétés du CA.
 */
export async function lotWithSales(
  executor: Kysely<DB> | Transaction<DB>,
  lot: ProductionLotDetail,
) {
  const productLots = await slaughterStockLotIds(executor, lot.id);
  const revenues = await lotRevenue(executor, [lot.stockLotId, ...productLots]);
  const composed = composeLotSales(
    lot.costs,
    revenues.get(lot.stockLotId)!,
    productLots.map((stockLotId) => revenues.get(stockLotId)!),
  );
  return { ...lot, costs: { ...lot.costs, monthly: composed.monthly }, sales: composed.sales };
}

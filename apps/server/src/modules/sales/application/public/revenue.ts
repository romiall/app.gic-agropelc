/**
 * Chiffre d'affaires et marges (P4-09 ; D09 BR-FIN-042, BR-FIN-043 ; stratégie finance §6.2-6.3 ;
 * ADR-010 : jamais stockés, toujours calculés sur les opérations).
 *
 * - **CA d'une période** = Σ des ventes confirmées dont `occurred_at` est dans la période − Σ des
 *   annulations **appliquées** dans la période (contre-écriture datée de son propre `applied_at`) : un
 *   rapport passé n'est jamais réécrit. **Coût des ventes** = Σ valeurs figées des mouvements `SALE`
 *   de la période − Σ des retours `CUSTOMER_RETURN` de la période ; **marge brute** = CA − coût.
 * - **CA d'un lot** : le montant de chaque ligne de vente est partagé entre ses mouvements `SALE` au
 *   prorata des quantités (`splitAmountXaf`, sans dérive) ; une annulation retire la part de ses
 *   retours (montant de la ligne d'annulation partagé entre ses retours), au mois du retour.
 * - **Réalisé d'un commercial** (objectifs `CA` et `QTE_PRODUIT`, D02) : ventes attribuées au
 *   commercial (`commercial_user_id`), mêmes principes de date.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { businessDayOf, quantityFromDecimal, splitAmountXaf, xaf } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { saleCostsInPeriod, saleMovesOfLots } from '../../../inventory/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

const monthOf = (at: Date): string => businessDayOf(at).slice(0, 7);

export interface LotRevenueMonth {
  /** Mois métier `AAAA-MM` (Africa/Douala). */
  readonly period: string;
  /** CA net du mois : ventes du mois − annulations du mois. */
  readonly revenueXaf: number;
  /** Coût des ventes net du mois (valeurs figées). */
  readonly costOfSalesXaf: number;
}

export interface LotRevenue {
  readonly lotId: string;
  readonly grossRevenueXaf: number;
  readonly cancelledXaf: number;
  readonly netRevenueXaf: number;
  readonly costOfSalesXaf: number;
  /** Quantité vendue nette (unité de base). */
  readonly soldQuantity: number;
  readonly months: readonly LotRevenueMonth[];
}

/** CA et coût des ventes de chaque lot demandé (lots sans vente : zéros). */
export async function lotRevenue(
  executor: Executor,
  lotIds: readonly string[],
): Promise<ReadonlyMap<string, LotRevenue>> {
  const wanted = new Set(lotIds);
  const acc = new Map<
    string,
    {
      gross: number;
      cancelled: number;
      cost: number;
      quantity: number;
      months: Map<string, { revenue: number; cost: number }>;
    }
  >();
  for (const lotId of wanted) {
    acc.set(lotId, { gross: 0, cancelled: 0, cost: 0, quantity: 0, months: new Map() });
  }
  const { saleMoves, returns } = await saleMovesOfLots(executor, [...wanted]);
  if (saleMoves.length > 0) {
    const lineIds = [...new Set(saleMoves.map((move) => move.saleLineId))];
    const lineRows = await executor
      .selectFrom('sales_sale_lines')
      .select(['id', 'line_total_xaf'])
      .where(
        'id',
        'in',
        lineIds.map((id) => toBin(id)),
      )
      .execute();
    const lineTotal = new Map(lineRows.map((row) => [fromBin(row.id), Number(row.line_total_xaf)]));
    const moveShare = new Map<string, number>();
    for (const lineId of lineIds) {
      const moves = saleMoves.filter((move) => move.saleLineId === lineId);
      const shares = splitAmountXaf(
        xaf(lineTotal.get(lineId) ?? 0),
        moves.map((move) => quantityFromDecimal(move.quantity)),
      );
      moves.forEach((move, index) => moveShare.set(move.moveId, shares[index]!));
    }
    const month = (lotId: string, period: string) => {
      const lot = acc.get(lotId)!;
      const current = lot.months.get(period) ?? { revenue: 0, cost: 0 };
      lot.months.set(period, current);
      return current;
    };
    for (const move of saleMoves) {
      if (move.lotId === null || !wanted.has(move.lotId)) continue;
      const share = moveShare.get(move.moveId) ?? 0;
      const lot = acc.get(move.lotId)!;
      lot.gross += share;
      lot.cost += move.valueXaf;
      lot.quantity += move.quantity;
      const m = month(move.lotId, monthOf(move.occurredAt));
      m.revenue += share;
      m.cost += move.valueXaf;
    }

    if (returns.length > 0) {
      const cancellationLineIds = [
        ...new Set(returns.flatMap((r) => (r.cancellationLineId ? [r.cancellationLineId] : []))),
      ];
      const cancellationRows =
        cancellationLineIds.length === 0
          ? []
          : await executor
              .selectFrom('sales_sale_cancellation_lines')
              .select(['id', 'amount_xaf'])
              .where(
                'id',
                'in',
                cancellationLineIds.map((id) => toBin(id)),
              )
              .execute();
      const cancellationAmount = new Map(
        cancellationRows.map((row) => [fromBin(row.id), Number(row.amount_xaf)]),
      );
      for (const lineId of cancellationLineIds) {
        const lineReturns = returns.filter((r) => r.cancellationLineId === lineId);
        const shares = splitAmountXaf(
          xaf(cancellationAmount.get(lineId) ?? 0),
          lineReturns.map((r) => quantityFromDecimal(r.quantity)),
        );
        lineReturns.forEach((r, index) => {
          if (r.lotId === null || !wanted.has(r.lotId)) return;
          const share = shares[index]!;
          const lot = acc.get(r.lotId)!;
          lot.cancelled += share;
          lot.cost -= r.valueXaf;
          lot.quantity -= r.quantity;
          const m = month(r.lotId, monthOf(r.occurredAt));
          m.revenue -= share;
          m.cost -= r.valueXaf;
        });
      }
    }
  }
  const result = new Map<string, LotRevenue>();
  for (const [lotId, lot] of acc) {
    result.set(lotId, {
      lotId,
      grossRevenueXaf: lot.gross,
      cancelledXaf: lot.cancelled,
      netRevenueXaf: lot.gross - lot.cancelled,
      costOfSalesXaf: lot.cost,
      soldQuantity: Math.round(lot.quantity * 1000) / 1000,
      months: [...lot.months]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([period, m]) => ({ period, revenueXaf: m.revenue, costOfSalesXaf: m.cost })),
    });
  }
  return result;
}

export interface RevenueFilter {
  /** Début inclus, fin exclue (instants UTC des bornes de jours métier). */
  readonly fromUtc: Date;
  readonly toUtc: Date;
  readonly siteIds?: readonly string[];
  readonly commercialUserId?: string;
  readonly customerIds?: readonly string[];
}

export interface PeriodRevenue {
  readonly grossRevenueXaf: number;
  readonly cancelledXaf: number;
  readonly netRevenueXaf: number;
  readonly costOfSalesXaf: number;
  readonly grossMarginXaf: number;
  readonly saleCount: number;
}

/** BR-FIN-042, BR-FIN-043 : CA, coût des ventes et marge brute d'une période. */
export async function periodRevenue(
  executor: Executor,
  filter: RevenueFilter,
): Promise<PeriodRevenue> {
  const sales = await executor
    .selectFrom('sales_sales')
    .select([
      sql<string>`COALESCE(SUM(total_xaf), 0)`.as('gross'),
      sql<string>`COUNT(*)`.as('count'),
    ])
    .where('occurred_at', '>=', filter.fromUtc)
    .where('occurred_at', '<', filter.toUtc)
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.commercialUserId !== undefined, (qb) =>
      qb.where('commercial_user_id', '=', toBin(filter.commercialUserId!)),
    )
    .$if(filter.customerIds !== undefined, (qb) =>
      qb.where(
        'customer_id',
        'in',
        filter.customerIds!.map((id) => toBin(id)),
      ),
    )
    .executeTakeFirst();
  const cancelled = await executor
    .selectFrom('sales_sale_cancellations as c')
    .innerJoin('sales_sales as s', 's.id', 'c.sale_id')
    .select(sql<string>`COALESCE(SUM(c.cancelled_total_xaf), 0)`.as('cancelled'))
    .where('c.status', '=', 'APPLIED')
    .where('c.applied_at', '>=', filter.fromUtc)
    .where('c.applied_at', '<', filter.toUtc)
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        's.site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.commercialUserId !== undefined, (qb) =>
      qb.where('s.commercial_user_id', '=', toBin(filter.commercialUserId!)),
    )
    .$if(filter.customerIds !== undefined, (qb) =>
      qb.where(
        's.customer_id',
        'in',
        filter.customerIds!.map((id) => toBin(id)),
      ),
    )
    .executeTakeFirst();
  // Coût des ventes : valeurs figées d'inventory (API publique), ventes du périmètre seulement.
  const costs = await saleCostsInPeriod(executor, filter);
  let costXaf = 0;
  if (costs.size > 0) {
    const ids = [...costs.keys()];
    const inScope = await executor
      .selectFrom('sales_sales')
      .select('id')
      .where(
        'id',
        'in',
        ids.map((id) => toBin(id)),
      )
      .$if(filter.siteIds !== undefined, (qb) =>
        qb.where(
          'site_id',
          'in',
          filter.siteIds!.map((id) => toBin(id)),
        ),
      )
      .$if(filter.commercialUserId !== undefined, (qb) =>
        qb.where('commercial_user_id', '=', toBin(filter.commercialUserId!)),
      )
      .$if(filter.customerIds !== undefined, (qb) =>
        qb.where(
          'customer_id',
          'in',
          filter.customerIds!.map((id) => toBin(id)),
        ),
      )
      .execute();
    for (const row of inScope) {
      const cost = costs.get(fromBin(row.id))!;
      costXaf += cost.soldXaf - cost.returnedXaf;
    }
  }
  const gross = Number(sales?.gross ?? 0);
  const cancelledXaf = Number(cancelled?.cancelled ?? 0);
  return {
    grossRevenueXaf: gross,
    cancelledXaf,
    netRevenueXaf: gross - cancelledXaf,
    costOfSalesXaf: costXaf,
    grossMarginXaf: gross - cancelledXaf - costXaf,
    saleCount: Number(sales?.count ?? 0),
  };
}

/**
 * Quantité nette d'un produit vendue dans une période (objectif `QTE_PRODUIT`) : lignes des ventes de
 * la période − quantités des annulations appliquées dans la période, en unité de base.
 */
export async function periodProductQuantity(
  executor: Executor,
  filter: RevenueFilter & { readonly productId: string },
): Promise<number> {
  const sold = await executor
    .selectFrom('sales_sale_lines as l')
    .innerJoin('sales_sales as s', 's.id', 'l.sale_id')
    .select(sql<string>`COALESCE(SUM(l.quantity_base), 0)`.as('quantity'))
    .where('l.product_id', '=', toBin(filter.productId))
    .where('s.occurred_at', '>=', filter.fromUtc)
    .where('s.occurred_at', '<', filter.toUtc)
    .$if(filter.commercialUserId !== undefined, (qb) =>
      qb.where('s.commercial_user_id', '=', toBin(filter.commercialUserId!)),
    )
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        's.site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .executeTakeFirst();
  const cancelled = await executor
    .selectFrom('sales_sale_cancellation_lines as cl')
    .innerJoin('sales_sale_cancellations as c', 'c.id', 'cl.cancellation_id')
    .innerJoin('sales_sale_lines as l', 'l.id', 'cl.sale_line_id')
    .innerJoin('sales_sales as s', 's.id', 'c.sale_id')
    .select(sql<string>`COALESCE(SUM(cl.quantity_base), 0)`.as('quantity'))
    .where('l.product_id', '=', toBin(filter.productId))
    .where('c.status', '=', 'APPLIED')
    .where('c.applied_at', '>=', filter.fromUtc)
    .where('c.applied_at', '<', filter.toUtc)
    .$if(filter.commercialUserId !== undefined, (qb) =>
      qb.where('s.commercial_user_id', '=', toBin(filter.commercialUserId!)),
    )
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        's.site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .executeTakeFirst();
  return Math.round((Number(sold?.quantity ?? 0) - Number(cancelled?.quantity ?? 0)) * 1000) / 1000;
}

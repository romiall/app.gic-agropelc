/**
 * Indicateurs de ventes sans fonction publique avant P9 (P9-15 ; KPI-COM-06 et 15, ADR-065 §1) :
 * - **Commandes** (KPI-COM-06) : commandes engagées (ni brouillon ni annulées) au jour de leur confirmation
 *   (`confirmed_at`, à défaut `occurred_at`), comme la vue `analytics_f_orders` ;
 * - **Taux de réachat** (KPI-COM-15) : clients ayant au moins deux ventes dans la période ÷ clients ayant au
 *   moins une vente dans la période, ventes non annulées en totalité (comme `salesActivityByDay`).
 *
 * Périmètre (`ReadScope`) : le site du document ; les personnes sont le commercial d'une commande, le vendeur
 * ou le commercial d'une vente.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { num, ratio, type DayWindow, type UtcWindow } from '../../../../platform/indicator-window.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface OrdersActivity {
  readonly orders: number;
  readonly orderedQuantity: number;
  readonly amountXaf: number;
}

export interface RepurchaseRate {
  readonly buyers: number;
  readonly repeatBuyers: number;
  readonly rate: number | null;
}

export async function ordersActivity(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<OrdersActivity> {
  const { rows } = await sql<{ orders: unknown; quantity: unknown; amount: unknown }>`
    SELECT COUNT(DISTINCT o.id) AS orders,
           COALESCE(SUM(l.quantity_base), 0) AS quantity,
           COALESCE(SUM(l.line_total_xaf), 0) AS amount
      FROM sales_sales_orders o
      JOIN sales_sales_order_lines l ON l.order_id = o.id
     WHERE o.status NOT IN ('DRAFT', 'CANCELLED')
       AND COALESCE(o.confirmed_at, o.occurred_at) >= ${window.fromUtc}
       AND COALESCE(o.confirmed_at, o.occurred_at) < ${window.toUtc}
       AND ${scopeSql(scope, { site: 'o.site_id', users: ['o.commercial_user_id'] })}
  `.execute(executor);
  return {
    orders: num(rows[0]?.orders),
    orderedQuantity: num(rows[0]?.quantity),
    amountXaf: num(rows[0]?.amount),
  };
}

export async function repurchaseRate(
  executor: Executor,
  scope: ReadScope,
  window: DayWindow,
): Promise<RepurchaseRate> {
  const { rows } = await sql<{ buyers: unknown; repeaters: unknown }>`
    SELECT COUNT(*) AS buyers, COALESCE(SUM(x.sales >= 2), 0) AS repeaters
      FROM (
        SELECT s.customer_id, COUNT(*) AS sales
          FROM sales_sales s
         WHERE s.business_date BETWEEN ${window.fromDay} AND ${window.toDay}
           AND s.status <> 'CANCELLED' AND s.customer_id IS NOT NULL
           AND ${scopeSql(scope, {
             site: 's.site_id',
             users: ['s.seller_user_id', 's.commercial_user_id'],
           })}
         GROUP BY s.customer_id
      ) x
  `.execute(executor);
  const buyers = num(rows[0]?.buyers);
  const repeatBuyers = num(rows[0]?.repeaters);
  return { buyers, repeatBuyers, rate: ratio(repeatBuyers, buyers) };
}

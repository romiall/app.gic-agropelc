/**
 * Ventes sur commande confirmées dont une partie reste à livrer (P9-07 ; D13 §7.1 `SALE_UNDELIVERED`,
 * AV-132). Lecture seule, même définition du reste à livrer que `toDeliverByLocation` (vendu − annulé −
 * livré, ADR-028) : une vente livrée en totalité, annulée ou dont la demande d'annulation est en cours
 * n'est plus listée. L'ancienneté se compte depuis le jour métier de la vente (sa confirmation) ou, s'il
 * est postérieur, depuis le jour de livraison demandé par le client (AV-401) : une livraison planifiée
 * n'est pas en retard avant sa date.
 *
 * La lecture part des **commandes ouvertes** (`sales_sales_orders.status`, indexé) plutôt que de toute la
 * table des ventes : une passe quotidienne ne relit pas l'historique.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

const dayOf = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export interface UndeliveredSale {
  readonly saleId: string;
  readonly docNumber: string;
  readonly orderId: string | null;
  readonly customerId: string | null;
  readonly siteId: string;
  readonly zoneId: string;
  readonly commercialUserId: string | null;
  readonly sellerUserId: string;
  /** Jour métier de la vente (`AAAA-MM-JJ`). */
  readonly saleDay: string;
  /** Jour de livraison demandé par le client, s'il y en a un. */
  readonly requestedDeliveryDay: string | null;
  /** Jour de départ de l'ancienneté : le plus tardif de la vente et de la livraison demandée. */
  readonly referenceDay: string;
  /** Quantité totale restant à livrer, en unités de base (tous produits confondus). */
  readonly remainingQuantity: number;
}

/**
 * Ventes à livrer dont le jour de départ de l'ancienneté (vente ou livraison demandée si postérieure) est
 * au plus `onOrBeforeDay` (celui du seuil d'ancienneté), de la plus ancienne à la plus récente.
 */
export async function listUndeliveredSales(
  executor: Executor,
  filter: { readonly onOrBeforeDay: string },
): Promise<readonly UndeliveredSale[]> {
  const { rows } = await sql<{
    readonly id: Buffer;
    readonly doc_number: string;
    readonly order_id: Buffer | null;
    readonly customer_id: Buffer | null;
    readonly site_id: Buffer;
    readonly zone_id: Buffer;
    readonly commercial_user_id: Buffer | null;
    readonly seller_user_id: Buffer;
    readonly business_date: Date | string;
    readonly requested_delivery_date: Date | string | null;
    readonly reference_date: Date | string;
    readonly remaining: string;
  }>`
    SELECT s.id, s.doc_number, s.order_id, s.customer_id, s.site_id, s.zone_id,
      s.commercial_user_id, s.seller_user_id, s.business_date, o.requested_delivery_date,
      GREATEST(s.business_date, COALESCE(o.requested_delivery_date, s.business_date)) AS reference_date,
      SUM(l.quantity_base - l.cancelled_quantity_base - l.delivered_quantity_base) AS remaining
    FROM sales_sales_orders o
    JOIN sales_sales s ON s.order_id = o.id
    JOIN sales_sale_lines l ON l.sale_id = s.id
    WHERE o.status IN ('CONFIRMED', 'PARTIALLY_FULFILLED')
      AND s.sale_type = 'ORDER'
      AND s.status = 'CONFIRMED'
      AND s.business_date IS NOT NULL
      AND GREATEST(s.business_date, COALESCE(o.requested_delivery_date, s.business_date))
        <= ${filter.onOrBeforeDay}
    GROUP BY s.id, s.doc_number, s.order_id, s.customer_id, s.site_id, s.zone_id,
      s.commercial_user_id, s.seller_user_id, s.business_date, o.requested_delivery_date
    HAVING remaining > 0
    ORDER BY reference_date ASC, s.id ASC
  `.execute(executor);
  return rows.map((row) => ({
    saleId: fromBin(row.id),
    docNumber: row.doc_number,
    orderId: fromBinOrNull(row.order_id),
    customerId: fromBinOrNull(row.customer_id),
    siteId: fromBin(row.site_id),
    zoneId: fromBin(row.zone_id),
    commercialUserId: fromBinOrNull(row.commercial_user_id),
    sellerUserId: fromBin(row.seller_user_id),
    saleDay: dayOf(row.business_date),
    requestedDeliveryDay:
      row.requested_delivery_date === null ? null : dayOf(row.requested_delivery_date),
    referenceDay: dayOf(row.reference_date),
    remainingQuantity: Number(row.remaining),
  }));
}

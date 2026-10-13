/**
 * Métriques de distribution de `sales` (P5-19 ; D05 BR-DIS-010, KPI-DIS-03 et 06 ; AV-164, AV-200) :
 * vendu par PDV et produit, à livrer, encaissé ventilé. Fonctions **partagées** entre le tableau de
 * distribution (P5-20) et l'accueil (BR-ANA-009). Lecture seule, calculée à la demande (BR-ANA-001).
 *
 * - **Vendu** (AV-164 (a), BR-ANA-003 « par période d'activité ») : lignes des ventes dont l'instant est
 *   dans la période, moins les lignes des annulations **appliquées** dans la période — chaque
 *   contre-écriture à sa date, comme `periodRevenue` et le registre de stock (le mouvement `SALE` est
 *   daté de la vente, le `CUSTOMER_RETURN` de l'application de l'annulation) : la quantité nette par
 *   (emplacement, produit) égale le vendu net d'`inventory` (`locationFlows`) **pour un produit stocké**.
 * - **À livrer** (ADR-028) : reste des lignes des ventes sur commande (vendu − annulé − livré), à un
 *   instant ; il égale le solde de l'emplacement `V_TO_DELIVER` du site pour un produit stocké.
 * Une ligne de produit `SERVICE` n'a aucun mouvement de stock (INV-VEN-08) : elle figure dans le vendu
 * et l'à livrer, hors rapprochement ; l'appelant qui rapproche passe `productIds` limité aux produits
 * stockés (lecture du catalogue). Les deux lectures relisent l'historique de l'emplacement (pas de
 * borne basse pour l'à livrer) : acceptable aux volumes du pilote (NFR-12, P5-20).
 * L'emplacement d'une vente est son `from_location_id` (le PDV vend depuis son emplacement de vente,
 * BR-DIS-010) ; le site, celui de la vente.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { businessDayEndUtc, businessDayStartUtc } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { saleActivityArms } from './period-activity.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface SalesLocationFilter {
  /** Emplacements de vente (`from_location_id`). */
  readonly locationIds?: readonly string[];
  readonly siteIds?: readonly string[];
  readonly productIds?: readonly string[];
}

export interface SoldByLocationLine {
  readonly siteId: string;
  readonly locationId: string;
  readonly productId: string;
  /** Quantité vendue (unité de base) des ventes de la période. */
  readonly soldQty: number;
  /** Quantité annulée par les annulations appliquées dans la période. */
  readonly cancelledQty: number;
  readonly soldNetQty: number;
  /** Montant des lignes vendues (XAF entiers). */
  readonly soldXaf: number;
  readonly cancelledXaf: number;
  readonly netXaf: number;
}

const binList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${toBin(id)}`));

/** Filtres SQL communs ; `undefined` quand un tableau vide ne doit rien lire. */
function locationFilters(filter: SalesLocationFilter) {
  if (
    filter.locationIds?.length === 0 ||
    filter.siteIds?.length === 0 ||
    filter.productIds?.length === 0 ||
    (filter.locationIds === undefined && filter.siteIds === undefined)
  ) {
    return undefined;
  }
  return sql.join(
    [
      filter.locationIds !== undefined
        ? sql`AND s.from_location_id IN (${binList(filter.locationIds)})`
        : sql``,
      filter.siteIds !== undefined ? sql`AND s.site_id IN (${binList(filter.siteIds)})` : sql``,
      filter.productIds !== undefined
        ? sql`AND l.product_id IN (${binList(filter.productIds)})`
        : sql``,
    ],
    sql` `,
  );
}

const milliRound = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Vendu par (site, emplacement, produit) sur la période (jours métier inclus). Au moins un filtre
 * d'emplacement ou de site est attendu ; un tableau vide ne lit rien.
 */
export async function soldByLocation(
  executor: Executor,
  input: SalesLocationFilter & {
    readonly period: { readonly fromDay: string; readonly toDay: string };
  },
): Promise<readonly SoldByLocationLine[]> {
  const filters = locationFilters(input);
  if (filters === undefined) return [];
  const start = businessDayStartUtc(input.period.fromDay);
  const end = businessDayEndUtc(input.period.toDay);
  const { rows } = await sql<{
    readonly site_id: Buffer;
    readonly location_id: Buffer;
    readonly product_id: Buffer;
    readonly sold_qty: string;
    readonly cancelled_qty: string;
    readonly sold_xaf: string;
    readonly cancelled_xaf: string;
  }>`
    SELECT x.site_id, x.location_id, x.product_id,
      COALESCE(SUM(x.sold_qty), 0) AS sold_qty, COALESCE(SUM(x.cancelled_qty), 0) AS cancelled_qty,
      COALESCE(SUM(x.sold_xaf), 0) AS sold_xaf, COALESCE(SUM(x.cancelled_xaf), 0) AS cancelled_xaf
    FROM (${saleActivityArms(start, end, filters)}
    ) x
    GROUP BY x.site_id, x.location_id, x.product_id
    ORDER BY x.site_id, x.location_id, x.product_id
  `.execute(executor);
  return rows.map((row) => {
    const soldQty = Number(row.sold_qty);
    const cancelledQty = Number(row.cancelled_qty);
    const soldXaf = Number(row.sold_xaf);
    const cancelledXaf = Number(row.cancelled_xaf);
    return {
      siteId: fromBin(row.site_id),
      locationId: fromBin(row.location_id),
      productId: fromBin(row.product_id),
      soldQty,
      cancelledQty,
      soldNetQty: milliRound(soldQty - cancelledQty),
      soldXaf,
      cancelledXaf,
      netXaf: soldXaf - cancelledXaf,
    };
  });
}

export interface ToDeliverLine {
  readonly siteId: string;
  readonly locationId: string;
  readonly productId: string;
  /** Reste à livrer (vendu − annulé − livré) des ventes sur commande. */
  readonly toDeliverQty: number;
  readonly openSales: number;
  /** Instant de la plus ancienne vente encore à livrer (alerte de retard, AV-132 : P9). */
  readonly oldestSaleAt: Date;
}

/**
 * À livrer, à l'instant de la lecture (KPI-DIS-03, colonne « vendu à livrer » d'AV-164), par (site,
 * emplacement de préparation, produit). Au moins un filtre d'emplacement ou de site est attendu ; un
 * tableau vide ne lit rien.
 */
export async function toDeliverByLocation(
  executor: Executor,
  input: SalesLocationFilter,
): Promise<readonly ToDeliverLine[]> {
  const filters = locationFilters(input);
  if (filters === undefined) return [];
  const { rows } = await sql<{
    readonly site_id: Buffer;
    readonly location_id: Buffer;
    readonly product_id: Buffer;
    readonly to_deliver_qty: string;
    readonly open_sales: string;
    readonly oldest_sale_at: Date;
  }>`
    SELECT s.site_id, s.from_location_id AS location_id, l.product_id,
      SUM(l.quantity_base - l.cancelled_quantity_base - l.delivered_quantity_base) AS to_deliver_qty,
      COUNT(DISTINCT s.id) AS open_sales, MIN(s.occurred_at) AS oldest_sale_at
    FROM sales_sale_lines l
    JOIN sales_sales s ON s.id = l.sale_id
    WHERE s.sale_type = 'ORDER'
      AND l.quantity_base - l.cancelled_quantity_base - l.delivered_quantity_base > 0 ${filters}
    GROUP BY s.site_id, s.from_location_id, l.product_id
    ORDER BY s.site_id, s.from_location_id, l.product_id
  `.execute(executor);
  return rows.map((row) => ({
    siteId: fromBin(row.site_id),
    locationId: fromBin(row.location_id),
    productId: fromBin(row.product_id),
    toDeliverQty: Number(row.to_deliver_qty),
    openSales: Number(row.open_sales),
    oldestSaleAt: row.oldest_sale_at,
  }));
}

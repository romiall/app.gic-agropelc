/**
 * Activité des ventes et des encaissements **par période d'activité** (P5-23 ; AV-200, AV-209, AV-244 ;
 * ADR-041 ; BR-ANA-003, BR-ANA-009 ; D11 KPI-COM-07, 08, 10, KPI-FIN-01 ; KPI-DIS-06) — une seule
 * définition pour l'accueil par rôle et le tableau de distribution, sans divergence entre écrans :
 * - **vendu** : lignes des ventes datées de la période, quel que soit leur statut ultérieur, moins les
 *   lignes des annulations appliquées dans la période, chacune à sa propre date (une annulation décidée le
 *   lendemain retranche le lendemain, jamais rétroactivement) ;
 * - **encaissé** : encaissements confirmés (enregistrés, en demande d'annulation, ou annulés depuis) à leur
 *   jour métier, moins les annulations décidées dans la période, à leur date ; les remboursements ne sont
 *   pas retranchés (D11, AV-244).
 *
 * Jours métier `Africa/Douala` (BR-ANA-002) ; périodes en jours inclus `AAAA-MM-JJ`.
 */
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { businessDayEndUtc, businessDayStartUtc } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface ActivityPeriod {
  readonly fromDay: string;
  readonly toDay: string;
}

/**
 * Les deux bras du vendu (lignes vendues, lignes annulées) sur `[start, end[`, chacun daté à sa propre
 * date (`day`) ; `filters` commence par `AND` et porte sur les alias `s` (vente) et `l` (ligne). Partagé
 * par le vendu par emplacement du tableau (`soldByLocation`) et le vendu par jour de l'accueil
 * (`salesActivityByDay`) : égaux par construction.
 */
export function saleActivityArms(
  start: Date,
  end: Date,
  filters: RawBuilder<unknown>,
): RawBuilder<unknown> {
  return sql`
      SELECT s.id AS sale_id, s.site_id, s.from_location_id AS location_id, l.product_id,
             s.channel_code, COALESCE(s.commercial_user_id, s.seller_user_id) AS seller_id,
             s.business_date AS day,
             l.quantity_base AS sold_qty, 0 AS cancelled_qty,
             l.line_total_xaf AS sold_xaf, 0 AS cancelled_xaf
        FROM sales_sale_lines l
        JOIN sales_sales s ON s.id = l.sale_id
       WHERE s.occurred_at >= ${start} AND s.occurred_at < ${end} ${filters}
      UNION ALL
      SELECT s.id AS sale_id, s.site_id, s.from_location_id AS location_id, l.product_id,
             s.channel_code, COALESCE(s.commercial_user_id, s.seller_user_id) AS seller_id,
             c.applied_business_date AS day,
             0 AS sold_qty, cl.quantity_base AS cancelled_qty,
             0 AS sold_xaf, cl.amount_xaf AS cancelled_xaf
        FROM sales_sale_cancellation_lines cl
        JOIN sales_sale_cancellations c ON c.id = cl.cancellation_id
        JOIN sales_sale_lines l ON l.id = cl.sale_line_id
        JOIN sales_sales s ON s.id = l.sale_id
       WHERE c.status = 'APPLIED' AND c.applied_at >= ${start} AND c.applied_at < ${end} ${filters}`;
}

export interface SalesActivityDay {
  readonly day: string;
  /** Lignes vendues ce jour (ventes datées du jour, quel que soit leur statut ultérieur). */
  readonly soldXaf: number;
  /** Lignes annulées ce jour (annulations appliquées ce jour, ventes de n'importe quel jour). */
  readonly cancelledXaf: number;
  /** Chiffre d'affaires du jour (KPI-COM-08) : vendu − annulé ; négatif possible. */
  readonly netXaf: number;
  /** Ventes du jour non annulées en totalité (KPI-COM-07). */
  readonly salesCount: number;
  /** Ventes du jour non annulées portant au moins une anomalie (drapeau). */
  readonly flaggedCount: number;
}

/** Activité des ventes par jour métier sur la période, dans le périmètre de lecture (jours sans activité absents). */
export async function salesActivityByDay(
  executor: Executor,
  scope: ReadScope,
  period: ActivityPeriod,
): Promise<readonly SalesActivityDay[]> {
  const start = businessDayStartUtc(period.fromDay);
  const end = businessDayEndUtc(period.toDay);
  const saleScope = scopeSql(scope, {
    site: 's.site_id',
    users: ['s.seller_user_id', 's.commercial_user_id'],
  });
  const amounts = await sql<{
    readonly day: string;
    readonly sold_xaf: string;
    readonly cancelled_xaf: string;
  }>`
    SELECT DATE_FORMAT(x.day, '%Y-%m-%d') AS day,
           COALESCE(SUM(x.sold_xaf), 0) AS sold_xaf, COALESCE(SUM(x.cancelled_xaf), 0) AS cancelled_xaf
      FROM (${saleActivityArms(start, end, sql`AND ${saleScope}`)}) x
     GROUP BY x.day
  `.execute(executor);
  const counts = await sql<{
    readonly day: string;
    readonly sales: string;
    readonly flagged: string;
  }>`
    SELECT DATE_FORMAT(s.business_date, '%Y-%m-%d') AS day, COUNT(*) AS sales,
           COALESCE(SUM(JSON_LENGTH(s.flags) > 0), 0) AS flagged
      FROM sales_sales s
     WHERE s.status <> 'CANCELLED' AND s.occurred_at >= ${start} AND s.occurred_at < ${end}
       AND ${saleScope}
     GROUP BY s.business_date
  `.execute(executor);
  const days = new Map<
    string,
    { sold: number; cancelled: number; sales: number; flagged: number }
  >();
  const entry = (day: string) => {
    let value = days.get(day);
    if (!value) {
      value = { sold: 0, cancelled: 0, sales: 0, flagged: 0 };
      days.set(day, value);
    }
    return value;
  };
  for (const row of amounts.rows) {
    const value = entry(row.day);
    value.sold = Number(row.sold_xaf);
    value.cancelled = Number(row.cancelled_xaf);
  }
  for (const row of counts.rows) {
    const value = entry(row.day);
    value.sales = Number(row.sales);
    value.flagged = Number(row.flagged);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      day,
      soldXaf: value.sold,
      cancelledXaf: value.cancelled,
      netXaf: value.sold - value.cancelled,
      salesCount: value.sales,
      flaggedCount: value.flagged,
    }));
}

export interface SalesBreakdownLine {
  /** Canal de vente (`channel_code`) ou utilisateur attribué (commercial, à défaut le vendeur). */
  readonly key: string;
  /** Chiffre d'affaires de la période, vendu − annulé (même définition que `salesActivityByDay`). */
  readonly netXaf: number;
  /** Ventes de la période non annulées en totalité. */
  readonly salesCount: number;
}

type Dimension = 'channel_code' | 'seller_id';

async function salesBreakdown(
  executor: Executor,
  scope: ReadScope,
  period: ActivityPeriod,
  dimension: Dimension,
): Promise<readonly SalesBreakdownLine[]> {
  const start = businessDayStartUtc(period.fromDay);
  const end = businessDayEndUtc(period.toDay);
  const saleScope = scopeSql(scope, {
    site: 's.site_id',
    users: ['s.seller_user_id', 's.commercial_user_id'],
  });
  const column = sql.raw(dimension === 'channel_code' ? 'x.channel_code' : 'x.seller_id');
  const amounts = await sql<{ readonly k: Buffer | string; readonly net_xaf: string }>`
    SELECT ${column} AS k, COALESCE(SUM(x.sold_xaf - x.cancelled_xaf), 0) AS net_xaf
      FROM (${saleActivityArms(start, end, sql`AND ${saleScope}`)}) x
     GROUP BY ${column}
  `.execute(executor);
  const saleColumn = sql.raw(
    dimension === 'channel_code'
      ? 's.channel_code'
      : 'COALESCE(s.commercial_user_id, s.seller_user_id)',
  );
  const counts = await sql<{ readonly k: Buffer | string; readonly sales: string }>`
    SELECT ${saleColumn} AS k, COUNT(*) AS sales
      FROM sales_sales s
     WHERE s.status <> 'CANCELLED' AND s.occurred_at >= ${start} AND s.occurred_at < ${end}
       AND ${saleScope}
     GROUP BY ${saleColumn}
  `.execute(executor);
  const keyOf = (value: Buffer | string): string =>
    typeof value === 'string' ? value : fromBin(value);
  const lines = new Map<string, { net: number; count: number }>();
  const entry = (key: string) => {
    let value = lines.get(key);
    if (!value) {
      value = { net: 0, count: 0 };
      lines.set(key, value);
    }
    return value;
  };
  for (const row of amounts.rows) entry(keyOf(row.k)).net = Number(row.net_xaf);
  for (const row of counts.rows) entry(keyOf(row.k)).count = Number(row.sales);
  return [...lines.entries()]
    .map(([key, value]) => ({ key, netXaf: value.net, salesCount: value.count }))
    .sort((a, b) => b.netXaf - a.netXaf || a.key.localeCompare(b.key));
}

/** Chiffre d'affaires par canal de vente sur la période, du plus élevé au plus faible (D11 §7.2, bloc VENTES). */
export const salesByChannel = (
  executor: Executor,
  scope: ReadScope,
  period: ActivityPeriod,
): Promise<readonly SalesBreakdownLine[]> =>
  salesBreakdown(executor, scope, period, 'channel_code');

/**
 * Chiffre d'affaires par commercial attribué (à défaut, le vendeur du point de vente) sur la période, classé du plus
 * élevé au plus faible (D11 §7.2, bloc VENTES) ; `key` est l'identifiant de l'utilisateur.
 */
export const salesBySeller = (
  executor: Executor,
  scope: ReadScope,
  period: ActivityPeriod,
): Promise<readonly SalesBreakdownLine[]> => salesBreakdown(executor, scope, period, 'seller_id');

export interface FlaggedSalesOfDay {
  /** Ventes du jour non annulées portant au moins un drapeau (= `flaggedCount` du jour). */
  readonly salesCount: number;
  /** Ventes par drapeau : une vente compte pour chacun de ses drapeaux. */
  readonly byFlag: ReadonlyMap<string, number>;
}

/**
 * Ventes signalées d'un jour métier, ventilées par drapeau (signal `SALES_FLAGGED` de l'accueil, AV-255) :
 * mêmes ventes que `flaggedCount` de `salesActivityByDay` (non annulées, datées du jour, dans le
 * périmètre). Les drapeaux sont lus et comptés ici, sans `JSON_TABLE`.
 *
 * `ignoreFlags` (AV-537) : drapeaux qui ne comptent pas ; une vente qui n'en porte aucun autre n'est plus
 * « signalée » (le pointage désactivé ne signale plus une vente « hors prise de service »). Vide par défaut :
 * le compte est alors celui de `flaggedCount`.
 */
export async function flaggedSalesOfDay(
  executor: Executor,
  scope: ReadScope,
  day: string,
  options: { readonly ignoreFlags?: readonly string[] } = {},
): Promise<FlaggedSalesOfDay> {
  const saleScope = scopeSql(scope, {
    site: 's.site_id',
    users: ['s.seller_user_id', 's.commercial_user_id'],
  });
  const rows = await sql<{ readonly flags: unknown }>`
    SELECT s.flags
      FROM sales_sales s
     WHERE s.status <> 'CANCELLED'
       AND s.occurred_at >= ${businessDayStartUtc(day)} AND s.occurred_at < ${businessDayEndUtc(day)}
       AND JSON_LENGTH(s.flags) > 0 AND ${saleScope}
  `.execute(executor);
  return tallyFlaggedSales(
    rows.rows.map((row) => row.flags),
    options.ignoreFlags,
  );
}

/**
 * Compte des ventes signalées d'après la colonne `flags` de chacune (tableau JSON de codes) : une vente compte pour
 * chacun de ses drapeaux ; les `ignoreFlags` ne comptent pas, et une vente qui n'en porte aucun autre n'est plus
 * signalée. Sans drapeau ignoré, toute ligne lue est une vente signalée.
 */
export function tallyFlaggedSales(
  flagLists: readonly unknown[],
  ignoreFlags: readonly string[] = [],
): FlaggedSalesOfDay {
  const ignored = new Set(ignoreFlags);
  const byFlag = new Map<string, number>();
  let salesCount = 0;
  for (const raw of flagLists) {
    const flags = Array.isArray(raw) ? (raw as unknown[]) : [];
    const kept = new Set(
      flags.filter((value): value is string => typeof value === 'string' && !ignored.has(value)),
    );
    if (ignored.size > 0 && kept.size === 0) continue;
    salesCount += 1;
    for (const flag of kept) byFlag.set(flag, (byFlag.get(flag) ?? 0) + 1);
  }
  return { salesCount, byFlag };
}

/** Somme de l'activité des jours `[fromDay, toDay]` (semaine de l'accueil). */
export function sumSalesActivity(
  days: readonly SalesActivityDay[],
  fromDay: string,
  toDay: string,
): Omit<SalesActivityDay, 'day'> {
  const kept = days.filter((day) => day.day >= fromDay && day.day <= toDay);
  const sum = (pick: (day: SalesActivityDay) => number) =>
    kept.reduce((total, day) => total + pick(day), 0);
  return {
    soldXaf: sum((day) => day.soldXaf),
    cancelledXaf: sum((day) => day.cancelledXaf),
    netXaf: sum((day) => day.netXaf),
    salesCount: sum((day) => day.salesCount),
    flaggedCount: sum((day) => day.flaggedCount),
  };
}

export interface CashedActivityRow {
  readonly siteId: Buffer;
  readonly paymentMethodCode: string;
  readonly receivedByUserId: Buffer;
  /** Encaissements confirmés de la période (enregistrés, en demande d'annulation, ou annulés depuis). */
  readonly confirmedCount: number;
  readonly confirmedXaf: number;
  /** Annulations d'encaissement décidées dans la période (encaissements de n'importe quel jour). */
  readonly cancelledCount: number;
  readonly cancelledXaf: number;
}

/**
 * Encaissé par période d'activité, par site, moyen et receveur (KPI-FIN-01, KPI-DIS-06 ; AV-200 (b),
 * AV-244). Un encaissement mis de côté comme doublon (`SUSPECT_DUPLICATE`) n'est pas confirmé ; approuvé,
 * il compte à sa date d'origine (comme son mouvement de trésorerie).
 */
export async function cashedActivity(
  executor: Executor,
  scope: ReadScope,
  period: ActivityPeriod,
): Promise<readonly CashedActivityRow[]> {
  const start = businessDayStartUtc(period.fromDay);
  const end = businessDayEndUtc(period.toDay);
  const paymentScope = scopeSql(scope, { site: 'p.site_id', users: ['p.received_by_user_id'] });
  const { rows } = await sql<{
    readonly site_id: Buffer;
    readonly payment_method_code: string;
    readonly received_by_user_id: Buffer;
    readonly confirmed_count: string;
    readonly confirmed_xaf: string;
    readonly cancelled_count: string;
    readonly cancelled_xaf: string;
  }>`
    SELECT x.site_id, x.payment_method_code, x.received_by_user_id,
           COALESCE(SUM(x.confirmed), 0) AS confirmed_count,
           COALESCE(SUM(x.confirmed_xaf), 0) AS confirmed_xaf,
           COALESCE(SUM(x.cancelled), 0) AS cancelled_count,
           COALESCE(SUM(x.cancelled_xaf), 0) AS cancelled_xaf
      FROM (
        SELECT p.site_id, p.payment_method_code, p.received_by_user_id,
               1 AS confirmed, p.amount_xaf AS confirmed_xaf, 0 AS cancelled, 0 AS cancelled_xaf
          FROM sales_customer_payments p
         WHERE p.status IN ('RECORDED', 'CANCELLATION_REQUESTED', 'CANCELLED')
           AND p.occurred_at >= ${start} AND p.occurred_at < ${end} AND ${paymentScope}
        UNION ALL
        SELECT p.site_id, p.payment_method_code, p.received_by_user_id,
               0 AS confirmed, 0 AS confirmed_xaf, 1 AS cancelled, p.amount_xaf AS cancelled_xaf
          FROM sales_customer_payments p
         WHERE p.status = 'CANCELLED'
           AND p.cancelled_at >= ${start} AND p.cancelled_at < ${end} AND ${paymentScope}
      ) x
     GROUP BY x.site_id, x.payment_method_code, x.received_by_user_id
     ORDER BY x.site_id, x.payment_method_code, x.received_by_user_id
  `.execute(executor);
  return rows.map((row) => ({
    siteId: row.site_id,
    paymentMethodCode: row.payment_method_code,
    receivedByUserId: row.received_by_user_id,
    confirmedCount: Number(row.confirmed_count),
    confirmedXaf: Number(row.confirmed_xaf),
    cancelledCount: Number(row.cancelled_count),
    cancelledXaf: Number(row.cancelled_xaf),
  }));
}

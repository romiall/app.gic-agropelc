/**
 * Indicateurs de stock sans fonction publique avant P9 (P9-15 ; KPI-PRD-02, KPI-STK-04 et 05, ADR-075 §1) :
 * - **Mortalité** d'un périmètre, par jour et sur les sept derniers jours (KPI-PRD-02) : déclarations de la
 *   catégorie `MORTALITE`, constatées (`RECORDED`, `APPROVED`, `REJECTED_UNJUSTIFIED`, `CANCELLATION_PENDING`) ;
 *   celles en attente de validation sont à part (AV-486, comme `lossValueSummary`) ;
 * - **Écarts d'inventaire** (KPI-STK-04) : gains moins pertes des mouvements `INVENTORY_GAIN` et
 *   `INVENTORY_LOSS`, en quantité et en valeur (valeur au coût : protégée) ; une contre-écriture compte en sens
 *   inverse ;
 * - **Couverture** (KPI-STK-05) : disponible ÷ ventes moyennes journalières des 14 derniers jours, par produit.
 *
 * Périmètre (`ReadScope`) : le site de l'emplacement ; les personnes sont le déclarant d'une perte et le
 * titulaire d'un emplacement mobile.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { num, type DayWindow, type UtcWindow } from '../../../../platform/indicator-window.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

const COUNTED = ['RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING'] as const;
const counted = sql.join(COUNTED.map((status) => sql`${status}`));
/** Fenêtre des ventes qui donne la vitesse d'écoulement de la couverture (KPI-STK-05). */
export const COVERAGE_SALES_DAYS = 14;

export interface MortalityDay {
  readonly day: string;
  readonly heads: number;
}

export interface MortalitySummary {
  /** Têtes mortes constatées sur la période. */
  readonly total: number;
  readonly byDay: readonly MortalityDay[];
  /** Têtes mortes constatées sur les sept jours finissant au dernier jour de la période. */
  readonly lastSevenDays: number;
  /** Déclarations de mortalité en attente de validation sur la période (à part). */
  readonly pendingHeads: number;
}

export async function mortalitySummary(
  executor: Executor,
  scope: ReadScope,
  window: DayWindow,
): Promise<MortalitySummary> {
  const where = scopeSql(scope, { site: 'd.site_id', users: ['d.declared_by'] });
  const days = await sql<{ day: string; heads: unknown }>`
    SELECT DATE_FORMAT(d.business_date, '%Y-%m-%d') AS day, COALESCE(SUM(d.quantity_base), 0) AS heads
      FROM inventory_loss_declarations d
     WHERE d.category = 'MORTALITE' AND d.status IN (${counted})
       AND d.business_date BETWEEN ${window.fromDay} AND ${window.toDay}
       AND ${where}
     GROUP BY d.business_date ORDER BY d.business_date
  `.execute(executor);
  const pending = await sql<{ heads: unknown }>`
    SELECT COALESCE(SUM(d.quantity_base), 0) AS heads
      FROM inventory_loss_declarations d
     WHERE d.category = 'MORTALITE' AND d.status = 'PENDING_APPROVAL'
       AND d.business_date BETWEEN ${window.fromDay} AND ${window.toDay}
       AND ${where}
  `.execute(executor);
  const byDay = days.rows.map((row) => ({ day: row.day, heads: num(row.heads) }));
  const sevenFrom = shiftDay(window.toDay, -6);
  return {
    total: byDay.reduce((sum, row) => sum + row.heads, 0),
    byDay,
    lastSevenDays: byDay
      .filter((row) => row.day >= sevenFrom && row.day <= window.toDay)
      .reduce((sum, row) => sum + row.heads, 0),
    pendingHeads: num(pending.rows[0]?.heads),
  };
}

/** Mortalité constatée par lot de production (BR-PRD-011), pour les taux d'un ensemble de lots. */
export async function countedMortalityOfLots(
  executor: Executor,
  lotIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (lotIds.length === 0) return new Map();
  const { rows } = await sql<{ lot: Buffer; heads: unknown }>`
    SELECT d.production_lot_id AS lot, COALESCE(SUM(d.quantity_base), 0) AS heads
      FROM inventory_loss_declarations d
     WHERE d.category = 'MORTALITE' AND d.status IN (${counted})
       AND d.production_lot_id IN (${sql.join(lotIds.map((id) => toBin(id)))})
     GROUP BY d.production_lot_id
  `.execute(executor);
  return new Map(rows.map((row) => [fromBin(row.lot), num(row.heads)]));
}

export interface InventoryVariance {
  readonly gainQuantity: number;
  readonly lossQuantity: number;
  readonly netQuantity: number;
  readonly gainValueXaf: number;
  readonly lossValueXaf: number;
  readonly netValueXaf: number;
}

export async function inventoryVarianceSummary(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<InventoryVariance> {
  // Un gain entre dans l'emplacement compté, une perte en sort : l'emplacement compté porte le site.
  const { rows } = await sql<{
    gain_qty: unknown;
    loss_qty: unknown;
    gain_value: unknown;
    loss_value: unknown;
  }>`
    SELECT COALESCE(SUM(CASE WHEN m.move_type = 'INVENTORY_GAIN' THEN s.sign * m.quantity END), 0) AS gain_qty,
           COALESCE(SUM(CASE WHEN m.move_type = 'INVENTORY_LOSS' THEN s.sign * m.quantity END), 0) AS loss_qty,
           COALESCE(SUM(CASE WHEN m.move_type = 'INVENTORY_GAIN' THEN s.sign * m.value_xaf END), 0) AS gain_value,
           COALESCE(SUM(CASE WHEN m.move_type = 'INVENTORY_LOSS' THEN s.sign * m.value_xaf END), 0) AS loss_value
      FROM inventory_stock_moves m
      JOIN organization_locations l
        ON l.id = CASE WHEN m.move_type = 'INVENTORY_GAIN' THEN m.to_location_id ELSE m.from_location_id END
      JOIN (SELECT 1 AS sign, 0 AS reversed UNION ALL SELECT -1, 1) s ON s.reversed = m.is_reversal
     WHERE m.move_type IN ('INVENTORY_GAIN', 'INVENTORY_LOSS')
       AND m.occurred_at >= ${window.fromUtc} AND m.occurred_at < ${window.toUtc}
       AND ${scopeSql(scope, { site: 'l.site_id', users: ['l.custodian_user_id'] })}
  `.execute(executor);
  const gainQuantity = num(rows[0]?.gain_qty);
  const lossQuantity = num(rows[0]?.loss_qty);
  const gainValueXaf = num(rows[0]?.gain_value);
  const lossValueXaf = num(rows[0]?.loss_value);
  return {
    gainQuantity,
    lossQuantity,
    netQuantity: Math.round((gainQuantity - lossQuantity) * 1000) / 1000,
    gainValueXaf,
    lossValueXaf,
    netValueXaf: gainValueXaf - lossValueXaf,
  };
}

export interface StockCoverageLine {
  readonly productId: string;
  readonly availableQuantity: number;
  readonly averageDailySold: number;
  /** Jours de vente couverts par le disponible ; `null` sans vente récente. */
  readonly coverageDays: number | null;
}

/** Couverture par produit, au jour `at` : disponible des emplacements physiques du périmètre ÷ ventes moyennes des 14 jours. */
export async function stockCoverage(
  executor: Executor,
  scope: ReadScope,
  at: Date,
): Promise<readonly StockCoverageLine[]> {
  const since = new Date(at.getTime() - COVERAGE_SALES_DAYS * 86_400_000);
  const locationScope = scopeSql(scope, { site: 'l.site_id', users: ['l.custodian_user_id'] });
  const available = await sql<{ product: Buffer; qty: unknown }>`
    SELECT b.product_id AS product,
           COALESCE(SUM(CASE WHEN l.custody_mode IN ('EXCLUSIVE_USER', 'EXCLUSIVE_DEVICE')
                             THEN b.qty_on_hand - b.qty_reserved
                             ELSE b.qty_on_hand - b.qty_reserved - b.qty_allocated END), 0) AS qty
      FROM inventory_stock_balances b
      JOIN organization_locations l ON l.id = b.location_id
     WHERE l.is_virtual = 0 AND ${locationScope}
     GROUP BY b.product_id
  `.execute(executor);
  const sold = await sql<{ product: Buffer; qty: unknown }>`
    SELECT m.product_id AS product,
           COALESCE(SUM(CASE WHEN m.is_reversal = 1 THEN -m.quantity ELSE m.quantity END), 0) AS qty
      FROM inventory_stock_moves m
      JOIN organization_locations l ON l.id = m.from_location_id
     WHERE m.move_type = 'SALE' AND m.occurred_at >= ${since} AND m.occurred_at < ${at}
       AND ${locationScope}
     GROUP BY m.product_id
  `.execute(executor);
  const soldBy = new Map(sold.rows.map((row) => [fromBin(row.product), num(row.qty)]));
  return available.rows
    .map((row) => {
      const productId = fromBin(row.product);
      const availableQuantity = num(row.qty);
      const averageDailySold = Math.round(((soldBy.get(productId) ?? 0) / COVERAGE_SALES_DAYS) * 1000) / 1000;
      return {
        productId,
        availableQuantity,
        averageDailySold,
        coverageDays:
          averageDailySold > 0 ? Math.round((availableQuantity / averageDailySold) * 10) / 10 : null,
      };
    })
    .sort((a, b) => (a.coverageDays ?? Infinity) - (b.coverageDays ?? Infinity));
}

/** Jour métier décalé de `days` jours (calendrier civil, sans fuseau). */
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}


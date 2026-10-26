/**
 * Indicateurs de production sans fonction publique avant P9 (P9-15 ; KPI-PRD-03, 06, 07 et 08, ADR-065 §1) :
 * - **Taux de mortalité cumulé** (KPI-PRD-03, AV-049, AV-116) : mortalité constatée ÷ effectif initial (somme des
 *   entrées), pour les lots en élevage (`ACTIVE`, `SELLING`) du périmètre ;
 * - **Œufs** (KPI-PRD-06 et 07) : collectés, commercialisables, à couver, cassés et non conformes des collectes
 *   enregistrées, et taux d'œufs commercialisables ÷ collectés ;
 * - **Taux d'éclosion** (KPI-PRD-08, BR-INC-007) : poussins éclos viables ÷ œufs incubés, et ÷ œufs fertiles
 *   (incubés moins infertiles) en indicateur secondaire, sur les lots d'incubation mis en incubation dans la
 *   période et dont l'éclosion est saisie.
 *
 * Périmètre (`ReadScope`) : le site du lot ou de la collecte ; les personnes sont l'auteur du document.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { num, ratio, type DayWindow, type UtcWindow } from '../../../../platform/indicator-window.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';
import { countedMortalityOfLots } from '../../../inventory/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Statuts d'un lot en élevage (effectif vivant, BR-PRD-003). */
export const REARING_LOT_STATUSES = ['ACTIVE', 'SELLING'] as const;

export interface CumulativeMortality {
  readonly lots: number;
  readonly initialHeads: number;
  readonly deadHeads: number;
  readonly rate: number | null;
}

export async function cumulativeMortalityRate(
  executor: Executor,
  scope: ReadScope,
): Promise<CumulativeMortality> {
  const { rows } = await sql<{ lot: Buffer; entries: unknown }>`
    SELECT pl.id AS lot,
           COALESCE((SELECT SUM(e.quantity_base) FROM production_lot_entries e
                      WHERE e.production_lot_id = pl.id AND e.status = 'RECORDED'), 0) AS entries
      FROM production_production_lots pl
     WHERE pl.status IN (${sql.join(REARING_LOT_STATUSES.map((status) => sql`${status}`))})
       AND ${scopeSql(scope, { site: 'pl.site_id', users: ['pl.created_by'] })}
  `.execute(executor);
  const dead = await countedMortalityOfLots(
    executor,
    rows.map((row) => fromBin(row.lot)),
  );
  const initialHeads = rows.reduce((sum, row) => sum + num(row.entries), 0);
  const deadHeads = [...dead.values()].reduce((sum, heads) => sum + heads, 0);
  return { lots: rows.length, initialHeads, deadHeads, rate: ratio(deadHeads, initialHeads) };
}

export interface EggSummary {
  readonly collected: number;
  readonly marketable: number;
  readonly toHatch: number;
  readonly broken: number;
  readonly nonConforming: number;
  /** Œufs commercialisables ÷ œufs collectés. */
  readonly marketableRate: number | null;
}

export async function eggSummary(
  executor: Executor,
  scope: ReadScope,
  window: DayWindow,
): Promise<EggSummary> {
  const { rows } = await sql<Record<'collected' | 'marketable' | 'hatching' | 'broken' | 'nonconf', unknown>>`
    SELECT COALESCE(SUM(e.collected_qty), 0) AS collected,
           COALESCE(SUM(e.marketable_qty), 0) AS marketable,
           COALESCE(SUM(e.hatching_qty), 0) AS hatching,
           COALESCE(SUM(e.broken_qty), 0) AS broken,
           COALESCE(SUM(e.nonconforming_qty), 0) AS nonconf
      FROM production_egg_collections e
     WHERE e.status = 'RECORDED'
       AND e.collection_date BETWEEN ${window.fromDay} AND ${window.toDay}
       AND ${scopeSql(scope, { site: 'e.site_id', users: ['e.created_by'] })}
  `.execute(executor);
  const collected = num(rows[0]?.collected);
  const marketable = num(rows[0]?.marketable);
  return {
    collected,
    marketable,
    toHatch: num(rows[0]?.hatching),
    broken: num(rows[0]?.broken),
    nonConforming: num(rows[0]?.nonconf),
    marketableRate: ratio(marketable, collected),
  };
}

export interface HatchRate {
  readonly batches: number;
  readonly eggsSet: number;
  readonly hatchedViable: number;
  readonly infertile: number;
  /** Poussins éclos viables ÷ œufs incubés. */
  readonly rate: number | null;
  /** Poussins éclos viables ÷ œufs fertiles (incubés moins infertiles). */
  readonly fertileRate: number | null;
}

export async function hatchRate(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<HatchRate> {
  const { rows } = await sql<Record<'batches' | 'eggs' | 'viable' | 'infertile', unknown>>`
    SELECT COUNT(*) AS batches,
           COALESCE(SUM(b.eggs_set_qty), 0) AS eggs,
           COALESCE(SUM(b.hatched_viable_qty), 0) AS viable,
           COALESCE(SUM(b.infertile_qty), 0) AS infertile
      FROM production_incubation_batches b
     WHERE b.status <> 'CANCELLED' AND b.hatched_viable_qty IS NOT NULL
       AND b.set_at >= ${window.fromUtc} AND b.set_at < ${window.toUtc}
       AND ${scopeSql(scope, { site: 'b.site_id', users: ['b.created_by'] })}
  `.execute(executor);
  const eggsSet = num(rows[0]?.eggs);
  const hatchedViable = num(rows[0]?.viable);
  const infertile = num(rows[0]?.infertile);
  return {
    batches: num(rows[0]?.batches),
    eggsSet,
    hatchedViable,
    infertile,
    rate: ratio(hatchedViable, eggsSet),
    fertileRate: ratio(hatchedViable, eggsSet - infertile),
  };
}

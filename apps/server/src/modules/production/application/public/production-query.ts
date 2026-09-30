/**
 * Lectures de la production (P7-11 ; 08-api-events/01-architecture-api.md §4.7) : lots (effectif,
 * mortalité, coûts, indicateurs, résultat mensuel), vue jour par jour, collectes d'œufs, lots
 * d'incubation, abattages, répartitions de frais généraux. Pagination par curseur sur
 * l'identifiant (UUIDv7, ordre décroissant), comme `procurement`. La portée (RC-04) et le masquage
 * des valeurs (RC-05) sont appliqués par le transport (`production-api/`).
 *
 * Indicateurs (AV-049 ; définitions par défaut AV-116, ouvert) : taux de mortalité = morts
 * comptées ÷ effectif initial ; GMQ = écart de poids moyen entre la première et la dernière pesée
 * ÷ jours ; indice de consommation = aliment (kg) consommé entre ces pesées ÷ gain de poids vif
 * du lot (effectif en élevage × poids moyen) ; taux de ponte = œufs collectés le dernier jour de
 * collecte ÷ effectif en élevage au début de ce jour.
 */
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  averageDailyGainG,
  businessDayEndUtc,
  businessDayStartUtc,
  costPerHeadXaf,
  feedConversionRatio,
  hatchRates,
  layingRate,
  lotTypeProfile,
  mortalityRate,
  nextBusinessDay,
  quantityFromDecimal,
  type ProductionLotType,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type {
  ProductionEggCollections,
  ProductionIncubationBatches,
  ProductionProductionLots,
  ProductionSlaughterBatches,
} from '../../../../platform/kysely/schema.generated.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  biologicalLotRemainingCostXaf,
  costObjectBalance,
  costObjectBreakdown,
  costObjectConsumptionsByDay,
  costObjectMonthly,
  lotHeadcount,
  lotLostQuantity,
  lotMortalitySummary,
  productionLotMortalityByDay,
  type ConsumptionDayLine,
  type CostBreakdownLine,
  type MonthlyCostLine,
} from '../../../inventory/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const PRODUCTION_LIST_DEFAULT_LIMIT = 50;
export const PRODUCTION_LIST_MAX_LIMIT = 200;
/** Fenêtre maximale de la vue jour par jour (un trimestre). */
export const PRODUCTION_DAILY_MAX_DAYS = 92;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

interface PageFilter {
  readonly beforeId?: string;
  readonly limit: number;
}

function pageOf<R extends { readonly id: Buffer }>(
  rows: readonly R[],
  limit: number,
): { readonly rows: readonly R[]; readonly nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  return {
    rows: kept,
    nextCursor: rows.length > limit ? fromBin(kept[kept.length - 1]!.id) : null,
  };
}

/** Forme `AAAA-MM-JJ` d'une colonne `DATE` lue (mysql2 : minuit local). */
function formatDate(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

const qty = (value: string | number | null): number | null =>
  value === null ? null : Math.round(Number(value) * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------------------------

export interface ProductionLotSummary {
  readonly id: string;
  readonly lotCode: string;
  readonly lotType: string;
  readonly productId: string;
  readonly stockLotId: string;
  readonly siteId: string;
  readonly mainLocationId: string;
  readonly parentLotId: string | null;
  readonly supplierId: string | null;
  readonly strain: string | null;
  readonly status: string;
  readonly plannedStartDate: string | null;
  readonly startDate: string | null;
  readonly plannedEndDate: string | null;
  readonly initialQuantity: number | null;
  /** Effectif calculé (INV-PRD-01) : non vendu et en élevage. */
  readonly headcount: { readonly unsold: number; readonly rearing: number };
  readonly closedAt: string | null;
  readonly occurredAt: string;
  readonly version: number;
}

export interface ProductionLotFilter extends PageFilter {
  readonly siteIds?: readonly string[];
  readonly siteId?: string;
  readonly status?: string;
  readonly lotType?: string;
}

async function toLotSummary(
  executor: Executor,
  row: Selectable<ProductionProductionLots>,
): Promise<ProductionLotSummary> {
  const stockLotId = fromBin(row.stock_lot_id);
  const [unsold, rearing] = await Promise.all([
    lotHeadcount(executor, { lotId: stockLotId, scope: 'UNSOLD' }),
    lotHeadcount(executor, { lotId: stockLotId, scope: 'REARING' }),
  ]);
  return {
    id: fromBin(row.id),
    lotCode: row.lot_code,
    lotType: row.lot_type,
    productId: fromBin(row.product_id),
    stockLotId,
    siteId: fromBin(row.site_id),
    mainLocationId: fromBin(row.main_location_id),
    parentLotId: fromBinOrNull(row.parent_lot_id),
    supplierId: fromBinOrNull(row.supplier_id),
    strain: row.strain,
    status: row.status,
    plannedStartDate: formatDate(row.planned_start_date),
    startDate: formatDate(row.start_date),
    plannedEndDate: formatDate(row.planned_end_date),
    initialQuantity: qty(row.initial_quantity),
    headcount: { unsold, rearing },
    closedAt: row.closed_at?.toISOString() ?? null,
    occurredAt: row.occurred_at.toISOString(),
    version: row.version,
  };
}

export async function listProductionLots(
  executor: Executor,
  filter: ProductionLotFilter,
): Promise<Page<ProductionLotSummary>> {
  if (filter.siteIds && filter.siteIds.length === 0) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('production_production_lots')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.lotType !== undefined, (qb) => qb.where('lot_type', '=', filter.lotType!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  const items: ProductionLotSummary[] = [];
  for (const row of page.rows) items.push(await toLotSummary(executor, row));
  return { items, nextCursor: page.nextCursor };
}

export interface LotEntrySummary {
  readonly id: string;
  readonly entryType: string;
  readonly sourceKind: string;
  readonly quantity: number;
  readonly stillbornQuantity: number;
  readonly toLocationId: string;
  readonly sourceLocationId: string | null;
  readonly sourceProductId: string | null;
  readonly sourceProductionLotId: string | null;
  readonly goodsReceiptId: string | null;
  readonly avgWeightG: number | null;
  readonly unitCostXaf: number | null;
  readonly valueXaf: number | null;
  readonly status: string;
  readonly occurredAt: string;
}

export interface WeighingSummary {
  readonly id: string;
  readonly locationId: string | null;
  readonly sampleSize: number;
  readonly avgWeightG: number;
  readonly totalWeightKg: number | null;
  readonly source: string;
  readonly status: string;
  readonly occurredAt: string;
}

export interface ProductionLotDetail extends ProductionLotSummary {
  readonly notes: string | null;
  readonly entries: readonly LotEntrySummary[];
  readonly weighings: readonly WeighingSummary[];
  readonly mortality: {
    readonly countedQuantity: number;
    readonly pendingQuantity: number;
    readonly pendingCount: number;
    /** Toutes pertes du lot (mortalité comprise), sur les mouvements. */
    readonly lostQuantity: number;
  };
  readonly costs: {
    readonly breakdown: readonly CostBreakdownLine[];
    readonly netXaf: number;
    /** Coût restant (ADR-027) et coût par tête courant (effectif non vendu). */
    readonly remainingXaf: number | null;
    readonly costPerHeadXaf: number | null;
    /** Résultat mensuel (AV-109) : coûts du mois ; chiffre d'affaires à partir de P4. */
    readonly monthly: readonly (MonthlyCostLine & { readonly revenueXaf: number | null })[];
  };
  readonly indicators: {
    readonly mortalityRate: number | null;
    readonly averageDailyGainG: number | null;
    readonly feedConversionRatio: number | null;
    readonly layingRate: number | null;
    readonly eggsCollected: number | null;
  };
  readonly closingSummary: unknown;
}

export async function getProductionLot(
  executor: Executor,
  lotId: string,
): Promise<ProductionLotDetail | undefined> {
  const row = await executor
    .selectFrom('production_production_lots')
    .selectAll()
    .where('id', '=', toBin(lotId))
    .executeTakeFirst();
  if (!row) return undefined;
  const summary = await toLotSummary(executor, row);
  const entries = await executor
    .selectFrom('production_lot_entries')
    .selectAll()
    .where('production_lot_id', '=', row.id)
    .orderBy('occurred_at', 'asc')
    .execute();
  const weighings = await executor
    .selectFrom('production_lot_weighings')
    .selectAll()
    .where('production_lot_id', '=', row.id)
    .orderBy('occurred_at', 'asc')
    .execute();
  const mortality = await lotMortalitySummary(executor, { productionLotId: summary.id });
  const lostQuantity = await lotLostQuantity(executor, {
    lotId: summary.stockLotId,
    productId: summary.productId,
  });
  const breakdown = await costObjectBreakdown(executor, {
    costObjectType: 'PRODUCTION_LOT',
    costObjectId: summary.id,
  });
  const netXaf = breakdown.reduce((sum, line) => sum + line.netXaf, 0);
  const remainingXaf = (await biologicalLotRemainingCostXaf(executor, summary.stockLotId)) ?? 0;
  const costPerHead =
    summary.headcount.unsold > 0
      ? costPerHeadXaf(Math.max(0, remainingXaf), quantityFromDecimal(summary.headcount.unsold))
      : null;
  const monthly = await costObjectMonthly(executor, {
    costObjectType: 'PRODUCTION_LOT',
    costObjectId: summary.id,
  });

  // Indicateurs (défauts AV-116).
  const recorded = weighings.filter((w) => w.status === 'RECORDED');
  let averageDailyGain: number | null = null;
  let feedConversion: number | null = null;
  if (recorded.length >= 2) {
    const first = recorded[0]!;
    const last = recorded[recorded.length - 1]!;
    const days = (last.occurred_at.getTime() - first.occurred_at.getTime()) / 86_400_000;
    averageDailyGain = averageDailyGainG({
      fromAvgWeightG: Number(first.avg_weight_g),
      toAvgWeightG: Number(last.avg_weight_g),
      days,
    });
    const [headsFirst, headsLast] = await Promise.all([
      lotHeadcount(executor, {
        lotId: summary.stockLotId,
        scope: 'REARING',
        at: first.occurred_at,
      }),
      lotHeadcount(executor, { lotId: summary.stockLotId, scope: 'REARING', at: last.occurred_at }),
    ]);
    const gainKg =
      (Number(last.avg_weight_g) * headsLast - Number(first.avg_weight_g) * headsFirst) / 1000;
    const feed = await costObjectConsumptionsByDay(executor, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: summary.id,
      fromUtc: first.occurred_at,
      toUtc: last.occurred_at,
    });
    const feedKg = feed
      .filter((line) => line.costType === 'ALIMENT')
      .reduce((sum, line) => sum + line.quantityBase, 0);
    feedConversion = feedConversionRatio(feedKg, gainKg);
  }
  let laying: number | null = null;
  let eggsCollected: number | null = null;
  if (lotTypeProfile(row.lot_type as ProductionLotType).laysEggs) {
    const collections = await executor
      .selectFrom('production_egg_collections')
      .select(['collection_date', 'collected_qty'])
      .where('production_lot_id', '=', row.id)
      .where('status', '=', 'RECORDED')
      .orderBy('collection_date', 'desc')
      .execute();
    eggsCollected = collections.reduce((sum, c) => sum + c.collected_qty, 0);
    const lastDay = collections[0] ? formatDate(collections[0].collection_date) : null;
    if (lastDay !== null) {
      const eggsThatDay = collections
        .filter((c) => formatDate(c.collection_date) === lastDay)
        .reduce((sum, c) => sum + c.collected_qty, 0);
      const hens = await lotHeadcount(executor, {
        lotId: summary.stockLotId,
        scope: 'REARING',
        at: new Date(businessDayStartUtc(lastDay).getTime() - 1),
      });
      laying = layingRate(eggsThatDay, hens);
    }
  }

  return {
    ...summary,
    notes: row.notes,
    entries: entries.map((entry) => ({
      id: fromBin(entry.id),
      entryType: entry.entry_type,
      sourceKind: entry.source_kind,
      quantity: qty(entry.quantity_base)!,
      stillbornQuantity: entry.stillborn_qty,
      toLocationId: fromBin(entry.to_location_id),
      sourceLocationId: fromBinOrNull(entry.source_location_id),
      sourceProductId: fromBinOrNull(entry.source_product_id),
      sourceProductionLotId: fromBinOrNull(entry.source_production_lot_id),
      goodsReceiptId: fromBinOrNull(entry.goods_receipt_id),
      avgWeightG: entry.avg_weight_g === null ? null : Number(entry.avg_weight_g),
      unitCostXaf: entry.unit_cost_xaf === null ? null : Number(entry.unit_cost_xaf),
      valueXaf: Number(entry.value_xaf),
      status: entry.status,
      occurredAt: entry.occurred_at.toISOString(),
    })),
    weighings: weighings.map((w) => ({
      id: fromBin(w.id),
      locationId: fromBinOrNull(w.location_id),
      sampleSize: w.sample_size,
      avgWeightG: Number(w.avg_weight_g),
      totalWeightKg: w.total_weight_kg === null ? null : Number(w.total_weight_kg),
      source: w.source,
      status: w.status,
      occurredAt: w.occurred_at.toISOString(),
    })),
    mortality: {
      countedQuantity: mortality.countedQuantity,
      pendingQuantity: mortality.pendingQuantity,
      pendingCount: mortality.pendingCount,
      lostQuantity,
    },
    costs: {
      breakdown,
      netXaf,
      remainingXaf,
      costPerHeadXaf: costPerHead,
      monthly: monthly.map((line) => ({ ...line, revenueXaf: null })),
    },
    indicators: {
      mortalityRate: mortalityRate(mortality.countedQuantity, summary.initialQuantity ?? 0),
      averageDailyGainG: averageDailyGain,
      feedConversionRatio: feedConversion,
      layingRate: laying,
      eggsCollected,
    },
    closingSummary: row.closing_summary ?? null,
  };
}

export interface LotDay {
  readonly day: string;
  /** Effectif en élevage en fin de journée. */
  readonly headcountEnd: number;
  readonly deaths: { readonly counted: number; readonly pending: number };
  readonly consumptions: readonly Omit<ConsumptionDayLine, 'day'>[];
  readonly weighings: readonly { readonly avgWeightG: number; readonly sampleSize: number }[];
  readonly observations: readonly {
    readonly observationType: string;
    readonly severity: string;
    readonly text: string;
  }[];
  readonly eggs: {
    readonly collected: number;
    readonly marketable: number;
    readonly hatching: number;
    readonly broken: number;
    readonly nonconforming: number;
  } | null;
  readonly enteredQuantity: number;
}

/** Vue jour par jour d'un lot sur `[fromDay, toDay]` (jours métier, fenêtre bornée). */
export async function productionLotDaily(
  executor: Executor,
  lot: { readonly id: string; readonly stockLotId: string; readonly lotType: string },
  fromDay: string,
  toDay: string,
): Promise<readonly LotDay[]> {
  const days: string[] = [];
  for (let day = fromDay; day <= toDay; day = nextBusinessDay(day)) days.push(day);
  const fromUtc = businessDayStartUtc(fromDay);
  const toUtc = businessDayEndUtc(toDay);
  const [deaths, consumptions, weighings, observations, entries] = await Promise.all([
    productionLotMortalityByDay(executor, { productionLotId: lot.id, fromUtc, toUtc }),
    costObjectConsumptionsByDay(executor, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lot.id,
      fromUtc,
      toUtc,
    }),
    executor
      .selectFrom('production_lot_weighings')
      .select(['avg_weight_g', 'sample_size', 'occurred_at'])
      .where('production_lot_id', '=', toBin(lot.id))
      .where('status', '=', 'RECORDED')
      .where('occurred_at', '>=', fromUtc)
      .where('occurred_at', '<', toUtc)
      .execute(),
    executor
      .selectFrom('production_lot_observations')
      .select(['observation_type', 'severity', 'text', 'occurred_at'])
      .where('production_lot_id', '=', toBin(lot.id))
      .where('occurred_at', '>=', fromUtc)
      .where('occurred_at', '<', toUtc)
      .orderBy('occurred_at', 'asc')
      .execute(),
    executor
      .selectFrom('production_lot_entries')
      .select(['quantity_base', 'occurred_at'])
      .where('production_lot_id', '=', toBin(lot.id))
      .where('status', '=', 'RECORDED')
      .where('occurred_at', '>=', fromUtc)
      .where('occurred_at', '<', toUtc)
      .execute(),
  ]);
  const laysEggs = lotTypeProfile(lot.lotType as ProductionLotType).laysEggs;
  const collections = laysEggs
    ? await executor
        .selectFrom('production_egg_collections')
        .select([
          'collection_date',
          'collected_qty',
          'marketable_qty',
          'hatching_qty',
          'broken_qty',
          'nonconforming_qty',
        ])
        .where('production_lot_id', '=', toBin(lot.id))
        .where('status', '=', 'RECORDED')
        .where('collection_date', '>=', sql<Date>`${fromDay}`)
        .where('collection_date', '<=', sql<Date>`${toDay}`)
        .execute()
    : [];
  const dayOf = (at: Date) => {
    const douala = new Date(at.getTime() + 3_600_000);
    return douala.toISOString().slice(0, 10);
  };
  const result: LotDay[] = [];
  for (const day of days) {
    const headcountEnd = await lotHeadcount(executor, {
      lotId: lot.stockLotId,
      scope: 'REARING',
      at: new Date(businessDayEndUtc(day).getTime() - 1),
    });
    const death = deaths.find((d) => d.day === day);
    const dayCollections = collections.filter((c) => formatDate(c.collection_date) === day);
    result.push({
      day,
      headcountEnd,
      deaths: { counted: death?.countedQuantity ?? 0, pending: death?.pendingQuantity ?? 0 },
      consumptions: consumptions.filter((c) => c.day === day).map(({ day: _day, ...line }) => line),
      weighings: weighings
        .filter((w) => dayOf(w.occurred_at) === day)
        .map((w) => ({ avgWeightG: Number(w.avg_weight_g), sampleSize: w.sample_size })),
      observations: observations
        .filter((o) => dayOf(o.occurred_at) === day)
        .map((o) => ({ observationType: o.observation_type, severity: o.severity, text: o.text })),
      eggs: laysEggs
        ? {
            collected: dayCollections.reduce((s, c) => s + c.collected_qty, 0),
            marketable: dayCollections.reduce((s, c) => s + c.marketable_qty, 0),
            hatching: dayCollections.reduce((s, c) => s + c.hatching_qty, 0),
            broken: dayCollections.reduce((s, c) => s + c.broken_qty, 0),
            nonconforming: dayCollections.reduce((s, c) => s + c.nonconforming_qty, 0),
          }
        : null,
      enteredQuantity: entries
        .filter((e) => dayOf(e.occurred_at) === day)
        .reduce((s, e) => s + Number(e.quantity_base), 0),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Collectes d'œufs
// ---------------------------------------------------------------------------------------------

export interface EggCollectionSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly productionLotId: string;
  readonly siteId: string;
  readonly collectionDate: string;
  readonly storageLocationId: string;
  readonly stockLotId: string;
  readonly hatchingProductId: string | null;
  readonly collected: number;
  readonly broken: number;
  readonly nonconforming: number;
  readonly marketable: number;
  readonly hatching: number;
  readonly valueXaf: number | null;
  readonly grades: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly unitCostXaf: number | null;
  }[];
  readonly status: string;
  readonly occurredAt: string;
}

export interface EggCollectionFilter extends PageFilter {
  readonly siteIds?: readonly string[];
  readonly siteId?: string;
  readonly productionLotId?: string;
  readonly fromDay?: string;
  readonly toDay?: string;
}

async function toCollections(
  executor: Executor,
  rows: readonly Selectable<ProductionEggCollections>[],
): Promise<EggCollectionSummary[]> {
  const lines =
    rows.length === 0
      ? []
      : await executor
          .selectFrom('production_egg_collection_lines')
          .selectAll()
          .where(
            'collection_id',
            'in',
            rows.map((row) => row.id),
          )
          .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    docNumber: row.doc_number,
    productionLotId: fromBin(row.production_lot_id),
    siteId: fromBin(row.site_id),
    collectionDate: formatDate(row.collection_date)!,
    storageLocationId: fromBin(row.storage_location_id),
    stockLotId: fromBin(row.stock_lot_id),
    hatchingProductId: fromBinOrNull(row.hatching_product_id),
    collected: row.collected_qty,
    broken: row.broken_qty,
    nonconforming: row.nonconforming_qty,
    marketable: row.marketable_qty,
    hatching: row.hatching_qty,
    valueXaf: Number(row.standard_value_xaf),
    grades: lines
      .filter((line) => line.collection_id.equals(row.id))
      .map((line) => ({
        productId: fromBin(line.product_id),
        quantity: line.quantity,
        unitCostXaf: Number(line.unit_cost_xaf),
      })),
    status: row.status,
    occurredAt: row.occurred_at.toISOString(),
  }));
}

export async function listEggCollections(
  executor: Executor,
  filter: EggCollectionFilter,
): Promise<Page<EggCollectionSummary>> {
  if (filter.siteIds && filter.siteIds.length === 0) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('production_egg_collections')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.productionLotId !== undefined, (qb) =>
      qb.where('production_lot_id', '=', toBin(filter.productionLotId!)),
    )
    .$if(filter.fromDay !== undefined, (qb) =>
      qb.where('collection_date', '>=', sql<Date>`${filter.fromDay!}`),
    )
    .$if(filter.toDay !== undefined, (qb) =>
      qb.where('collection_date', '<=', sql<Date>`${filter.toDay!}`),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  return { items: await toCollections(executor, page.rows), nextCursor: page.nextCursor };
}

export async function getEggCollection(
  executor: Executor,
  id: string,
): Promise<EggCollectionSummary | undefined> {
  const row = await executor
    .selectFrom('production_egg_collections')
    .selectAll()
    .where('id', '=', toBin(id))
    .executeTakeFirst();
  return row ? (await toCollections(executor, [row]))[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Incubation
// ---------------------------------------------------------------------------------------------

export interface IncubationBatchSummary {
  readonly id: string;
  readonly batchCode: string;
  readonly stockLotId: string;
  readonly siteId: string;
  readonly species: string;
  readonly eggProductId: string;
  readonly chickProductId: string;
  readonly incubatorLocationId: string;
  readonly hatcherLocationId: string | null;
  readonly eggSource: string;
  readonly eggsSet: number;
  readonly setAt: string;
  readonly expectedCandlingDate: string | null;
  readonly expectedTransferDate: string | null;
  readonly expectedHatchDate: string | null;
  readonly counters: {
    readonly infertile: number;
    readonly earlyDead: number;
    readonly accidentalLoss: number;
    readonly transferred: number;
    readonly hatchedViable: number;
    readonly hatchedNonviable: number;
    readonly unhatched: number;
  };
  readonly hatchRate: number | null;
  readonly fertileHatchRate: number | null;
  readonly status: string;
  /** Coût du lot d'incubation (écritures), masqué sans droit de valorisation. */
  readonly costXaf: number | null;
}

export interface IncubationEventSummary {
  readonly id: string;
  readonly eventType: string;
  readonly infertile: number | null;
  readonly earlyDead: number | null;
  readonly transferred: number | null;
  readonly hatchedViable: number | null;
  readonly hatchedNonviable: number | null;
  readonly unhatched: number | null;
  readonly outputLocationId: string | null;
  readonly status: string;
  readonly occurredAt: string;
}

export interface IncubationBatchDetail extends IncubationBatchSummary {
  readonly events: readonly IncubationEventSummary[];
}

export interface IncubationFilter extends PageFilter {
  readonly siteIds?: readonly string[];
  readonly siteId?: string;
  readonly status?: string;
}

async function toIncubation(
  executor: Executor,
  row: Selectable<ProductionIncubationBatches>,
): Promise<IncubationBatchSummary> {
  const counters = {
    eggsSet: row.eggs_set_qty,
    infertile: row.infertile_qty,
    earlyDead: row.early_dead_qty,
    accidentalLoss: row.accidental_loss_qty,
    unhatched: row.unhatched_qty,
    hatchedViable: row.hatched_viable_qty,
    hatchedNonviable: row.hatched_nonviable_qty,
  };
  const rates = row.status === 'CLOSED' ? hatchRates(counters) : null;
  const cost = await costObjectBalance(executor, {
    costObjectType: 'INCUBATION_BATCH',
    costObjectId: fromBin(row.id),
  });
  return {
    id: fromBin(row.id),
    batchCode: row.batch_code,
    stockLotId: fromBin(row.stock_lot_id),
    siteId: fromBin(row.site_id),
    species: row.species,
    eggProductId: fromBin(row.egg_product_id),
    chickProductId: fromBin(row.chick_product_id),
    incubatorLocationId: fromBin(row.incubator_location_id),
    hatcherLocationId: fromBinOrNull(row.hatcher_location_id),
    eggSource: row.egg_source,
    eggsSet: row.eggs_set_qty,
    setAt: row.set_at.toISOString(),
    expectedCandlingDate: formatDate(row.expected_candling_date),
    expectedTransferDate: formatDate(row.expected_transfer_date),
    expectedHatchDate: formatDate(row.expected_hatch_date),
    counters: {
      infertile: row.infertile_qty,
      earlyDead: row.early_dead_qty,
      accidentalLoss: row.accidental_loss_qty,
      transferred: row.transferred_qty,
      hatchedViable: row.hatched_viable_qty,
      hatchedNonviable: row.hatched_nonviable_qty,
      unhatched: row.unhatched_qty,
    },
    hatchRate: rates?.hatchRate ?? null,
    fertileHatchRate: rates?.fertileHatchRate ?? null,
    status: row.status,
    costXaf: cost.netXaf,
  };
}

export async function listIncubationBatches(
  executor: Executor,
  filter: IncubationFilter,
): Promise<Page<IncubationBatchSummary>> {
  if (filter.siteIds && filter.siteIds.length === 0) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('production_incubation_batches')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  const items: IncubationBatchSummary[] = [];
  for (const row of page.rows) items.push(await toIncubation(executor, row));
  return { items, nextCursor: page.nextCursor };
}

export async function getIncubationBatch(
  executor: Executor,
  id: string,
): Promise<IncubationBatchDetail | undefined> {
  const row = await executor
    .selectFrom('production_incubation_batches')
    .selectAll()
    .where('id', '=', toBin(id))
    .executeTakeFirst();
  if (!row) return undefined;
  const events = await executor
    .selectFrom('production_incubation_events')
    .selectAll()
    .where('batch_id', '=', row.id)
    .orderBy('occurred_at', 'asc')
    .execute();
  return {
    ...(await toIncubation(executor, row)),
    events: events.map((event) => ({
      id: fromBin(event.id),
      eventType: event.event_type,
      infertile: event.qty_infertile,
      earlyDead: event.qty_early_dead,
      transferred: event.qty_transferred,
      hatchedViable: event.qty_hatched_viable,
      hatchedNonviable: event.qty_hatched_nonviable,
      unhatched: event.qty_unhatched,
      outputLocationId: fromBinOrNull(event.output_location_id),
      status: event.status,
      occurredAt: event.occurred_at.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Abattages
// ---------------------------------------------------------------------------------------------

export interface SlaughterSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly productionLotId: string;
  readonly siteId: string;
  readonly sourceLocationId: string;
  readonly locationId: string;
  readonly inputProductId: string;
  readonly heads: number;
  readonly condemnedHeads: number;
  readonly liveWeightG: number;
  readonly outputWeightG: number;
  readonly yieldRate: number | null;
  readonly inputValueXaf: number | null;
  readonly stockLotId: string;
  readonly outputs: readonly {
    readonly productId: string;
    readonly toLocationId: string;
    readonly quantity: number;
    readonly weightG: number;
    readonly valueXaf: number | null;
    readonly unitCostXaf: number | null;
  }[];
  readonly status: string;
  readonly occurredAt: string;
}

export interface SlaughterFilter extends PageFilter {
  readonly siteIds?: readonly string[];
  readonly siteId?: string;
  readonly productionLotId?: string;
}

async function toSlaughters(
  executor: Executor,
  rows: readonly Selectable<ProductionSlaughterBatches>[],
): Promise<SlaughterSummary[]> {
  const outputs =
    rows.length === 0
      ? []
      : await executor
          .selectFrom('production_slaughter_outputs')
          .selectAll()
          .where(
            'slaughter_id',
            'in',
            rows.map((row) => row.id),
          )
          .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    docNumber: row.doc_number,
    productionLotId: fromBin(row.production_lot_id),
    siteId: fromBin(row.site_id),
    sourceLocationId: fromBin(row.source_location_id),
    locationId: fromBin(row.location_id),
    inputProductId: fromBin(row.input_product_id),
    heads: row.heads_qty,
    condemnedHeads: row.condemned_heads,
    liveWeightG: Number(row.live_weight_g),
    outputWeightG: Number(row.output_weight_g),
    yieldRate: row.yield_rate === null ? null : Number(row.yield_rate),
    inputValueXaf: Number(row.total_input_value_xaf),
    stockLotId: fromBin(row.stock_lot_id),
    outputs: outputs
      .filter((output) => output.slaughter_id.equals(row.id))
      .map((output) => ({
        productId: fromBin(output.product_id),
        toLocationId: fromBin(output.to_location_id),
        quantity: qty(output.quantity_base)!,
        weightG: Number(output.weight_g),
        valueXaf: Number(output.allocated_value_xaf),
        unitCostXaf: Number(output.unit_cost_xaf),
      })),
    status: row.status,
    occurredAt: row.occurred_at.toISOString(),
  }));
}

export async function listSlaughters(
  executor: Executor,
  filter: SlaughterFilter,
): Promise<Page<SlaughterSummary>> {
  if (filter.siteIds && filter.siteIds.length === 0) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('production_slaughter_batches')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.productionLotId !== undefined, (qb) =>
      qb.where('production_lot_id', '=', toBin(filter.productionLotId!)),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  return { items: await toSlaughters(executor, page.rows), nextCursor: page.nextCursor };
}

export async function getSlaughter(
  executor: Executor,
  id: string,
): Promise<SlaughterSummary | undefined> {
  const row = await executor
    .selectFrom('production_slaughter_batches')
    .selectAll()
    .where('id', '=', toBin(id))
    .executeTakeFirst();
  return row ? (await toSlaughters(executor, [row]))[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Répartitions des frais généraux
// ---------------------------------------------------------------------------------------------

export interface OverheadAllocationSummary {
  readonly id: string;
  readonly siteId: string;
  readonly speciesGroup: string;
  readonly period: string;
  readonly runKind: string;
  readonly sequence: number;
  readonly poolXaf: number | null;
  readonly allocatedXaf: number | null;
  readonly headDaysTotal: number;
  readonly productionLotId: string | null;
  readonly lines: readonly {
    readonly productionLotId: string;
    readonly headDays: number;
    readonly amountXaf: number | null;
  }[];
  readonly occurredAt: string;
}

export interface OverheadAllocationFilter extends PageFilter {
  readonly siteIds?: readonly string[];
  readonly siteId?: string;
  readonly speciesGroup?: string;
  readonly period?: string;
}

export async function listOverheadAllocations(
  executor: Executor,
  filter: OverheadAllocationFilter,
): Promise<Page<OverheadAllocationSummary>> {
  if (filter.siteIds && filter.siteIds.length === 0) return { items: [], nextCursor: null };
  const rows = await executor
    .selectFrom('production_overhead_allocations')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.speciesGroup !== undefined, (qb) =>
      qb.where('species_group', '=', filter.speciesGroup!),
    )
    .$if(filter.period !== undefined, (qb) => qb.where('period', '=', filter.period!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const page = pageOf(rows, filter.limit);
  const lines =
    page.rows.length === 0
      ? []
      : await executor
          .selectFrom('production_overhead_allocation_lines')
          .selectAll()
          .where(
            'allocation_id',
            'in',
            page.rows.map((row) => row.id),
          )
          .execute();
  return {
    items: page.rows.map((row) => ({
      id: fromBin(row.id),
      siteId: fromBin(row.site_id),
      speciesGroup: row.species_group,
      period: row.period,
      runKind: row.run_kind,
      sequence: row.sequence,
      poolXaf: Number(row.pool_xaf),
      allocatedXaf: Number(row.allocated_xaf),
      headDaysTotal: Number(row.head_days_total),
      productionLotId: fromBinOrNull(row.production_lot_id),
      lines: lines
        .filter((line) => line.allocation_id.equals(row.id))
        .map((line) => ({
          productionLotId: fromBin(line.production_lot_id),
          headDays: Number(line.head_days),
          amountXaf: Number(line.amount_xaf),
        })),
      occurredAt: row.occurred_at.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

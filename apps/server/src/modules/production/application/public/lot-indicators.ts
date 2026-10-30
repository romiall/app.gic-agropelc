/**
 * Indicateurs d'élevage d'un lot sans fonction publique avant P9-27 (AV-462 choix (b), ADR-065 §1) :
 * - **Aliment consommé** (KPI-PRD-04, AV-476) : somme des consommations d'intrant de nature `ALIMENT` imputées aux
 *   lots du périmètre sur une période (flux), lots de tout statut — `inventory` lit les consommations, `production`
 *   choisit les lots ;
 * - **Poids moyen** (KPI-PRD-05, AV-477, BR-PRD-015) : poids de la dernière pesée enregistrée de chaque lot en
 *   élevage à un instant, moyenné par type de lot en pondérant par l'effectif en élevage (instant) ;
 * - **Coût par tête** (KPI-PRD-09, AV-478, BR-PRD-012, ADR-027) : coût restant ÷ effectif non vendu, par type de lot
 *   sur les lots en élevage (la somme sur la somme, jamais la moyenne des coûts par tête), à l'instant de lecture.
 *
 * Un poids moyen ou un coût par tête ne se mêle pas entre espèces (AV-475) : les deux fonctions rendent le détail
 * **par type de lot** et {@link referenceLotType} désigne le type que le tableau affiche en indicateur.
 *
 * Périmètre (`ReadScope`) : le site du lot ; les personnes sont l'auteur du lot (comme `eggSummary`). Un périmètre
 * vide donne un résultat vide, jamais « tout » (TB-9). Le fichier ne contrôle aucun droit : la valeur au coût
 * (KPI-PRD-09) est masquée par le bloc du tableau (`inventory.valuation.read`).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { costPerHeadXaf, quantityFromDecimal } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { num, type UtcWindow } from '../../../../platform/indicator-window.js';
import { isEmptyScope, scopeSql, type ReadScope } from '../../../../platform/read-scope.js';
import {
  biologicalLotRemainingCostXaf,
  feedConsumedByCostObjects,
  lotHeadcount,
} from '../../../inventory/application/public/index.js';
import { REARING_LOT_STATUSES } from './production-indicators.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Lots traités ensemble : deux lectures d'`inventory` par lot, sans épuiser le pool de connexions. */
const LOT_BATCH = 10;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(...(await Promise.all(items.slice(start, start + size).map(fn))));
  }
  return out;
}

/** Ordre stable des types : plus de têtes en élevage d'abord, puis code croissant. */
function byHeadsThenCode(
  a: { readonly lotType: string; readonly rearingHeads: number },
  b: { readonly lotType: string; readonly rearingHeads: number },
): number {
  if (a.rearingHeads !== b.rearingHeads) return b.rearingHeads - a.rearingHeads;
  return a.lotType < b.lotType ? -1 : a.lotType > b.lotType ? 1 : 0;
}

/**
 * Type de lot comptant le plus de têtes en élevage ; égalité : code croissant ; `null` si la liste est vide ou
 * sans aucune tête (AV-475).
 */
export function referenceLotType(
  types: readonly { readonly lotType: string; readonly rearingHeads: number }[],
): string | null {
  const ranked = types.filter((type) => type.rearingHeads > 0).sort(byHeadsThenCode);
  return ranked[0]?.lotType ?? null;
}

// ---------------------------------------------------------------------------------------------
// KPI-PRD-04 — aliment consommé
// ---------------------------------------------------------------------------------------------

export interface FeedConsumption {
  /** Quantité d'aliment consommée (unité de base, kg), somme des lots, 3 décimales. */
  readonly quantity: number;
  /** Lots qui ont consommé de l'aliment dans la période, tri par identifiant de lot. */
  readonly lots: readonly { readonly lotId: string; readonly quantity: number }[];
}

export async function feedConsumption(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<FeedConsumption> {
  if (isEmptyScope(scope)) return { quantity: 0, lots: [] };
  // Tous les lots du périmètre, de tout statut : un lot clos a consommé dans la période (AV-476).
  const { rows } = await sql<{ id: Buffer }>`
    SELECT pl.id AS id
      FROM production_production_lots pl
     WHERE ${scopeSql(scope, { site: 'pl.site_id', users: ['pl.created_by'] })}
  `.execute(executor);
  const byLot = await feedConsumedByCostObjects(executor, {
    costObjectType: 'PRODUCTION_LOT',
    costObjectIds: rows.map((row) => fromBin(row.id)),
    fromUtc: window.fromUtc,
    toUtc: window.toUtc,
  });
  const lots = [...byLot.entries()]
    .map(([lotId, quantity]) => ({ lotId, quantity }))
    .sort((a, b) => (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0));
  return { quantity: round3(lots.reduce((sum, lot) => sum + lot.quantity, 0)), lots };
}

// ---------------------------------------------------------------------------------------------
// Lots en élevage du périmètre (socle de KPI-PRD-05 et 09)
// ---------------------------------------------------------------------------------------------

interface RearingLot {
  readonly lotId: string;
  readonly stockLotId: string;
  readonly lotCode: string;
  readonly lotType: string;
}

async function rearingLots(executor: Executor, scope: ReadScope): Promise<readonly RearingLot[]> {
  if (isEmptyScope(scope)) return [];
  const { rows } = await sql<{
    id: Buffer;
    stock_lot_id: Buffer;
    lot_code: string;
    lot_type: string;
  }>`
    SELECT pl.id, pl.stock_lot_id, pl.lot_code, pl.lot_type
      FROM production_production_lots pl
     WHERE pl.status IN (${sql.join(REARING_LOT_STATUSES.map((status) => sql`${status}`))})
       AND ${scopeSql(scope, { site: 'pl.site_id', users: ['pl.created_by'] })}
     ORDER BY pl.lot_code ASC
  `.execute(executor);
  return rows.map((row) => ({
    lotId: fromBin(row.id),
    stockLotId: fromBin(row.stock_lot_id),
    lotCode: row.lot_code,
    lotType: row.lot_type,
  }));
}

// ---------------------------------------------------------------------------------------------
// KPI-PRD-05 — poids moyen (dernière pesée)
// ---------------------------------------------------------------------------------------------

export interface LatestWeighingLot {
  readonly lotId: string;
  readonly lotCode: string;
  readonly lotType: string;
  /** Effectif en élevage à l'instant de lecture. */
  readonly rearingHeads: number;
  /** Poids moyen (g) de la dernière pesée enregistrée à l'instant de lecture ; `null` sans pesée. */
  readonly avgWeightG: number | null;
  readonly sampleSize: number | null;
  /** Instant (ISO) de cette pesée. */
  readonly weighedAt: string | null;
}

export interface LatestWeighingType {
  readonly lotType: string;
  /** Lots en élevage du type. */
  readonly lots: number;
  /** Dont lots ayant au moins une pesée. */
  readonly weighedLots: number;
  /** Têtes en élevage de tous les lots du type (choix du type de référence, AV-475). */
  readonly rearingHeads: number;
  /** Têtes en élevage des lots pesés d'effectif > 0 (base de la pondération). */
  readonly weighedHeads: number;
  /** Poids moyen (g) pondéré par l'effectif en élevage, arrondi à 0,1 g ; `null` sans lot pesé à effectif. */
  readonly avgWeightG: number | null;
}

export interface LatestWeighing {
  /** Lots en élevage du périmètre, tri par code de lot. */
  readonly lots: readonly LatestWeighingLot[];
  /** Par type de lot : plus de têtes en élevage d'abord, puis code croissant. */
  readonly byLotType: readonly LatestWeighingType[];
}

/** Instant lu en base : `Date` (connexion en UTC) ou, par prudence, chaîne UTC `AAAA-MM-JJ hh:mm:ss`. */
function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  return new Date(`${value.replace(' ', 'T')}${hasZone ? '' : 'Z'}`).toISOString();
}

/**
 * Poids moyen des lots en élevage (AV-477) : par lot, la pesée `RECORDED` la plus récente à `input.at` (instant
 * égal : identifiant le plus grand), quel que soit son âge ; par type, la moyenne de ces poids pondérée par
 * l'effectif en élevage à `input.at`. Les poids sont en grammes.
 */
export async function latestWeighing(
  executor: Executor,
  scope: ReadScope,
  input: { readonly at: Date },
): Promise<LatestWeighing> {
  if (isEmptyScope(scope)) return { lots: [], byLotType: [] };
  const { rows } = await sql<{
    id: Buffer;
    stock_lot_id: Buffer;
    lot_code: string;
    lot_type: string;
    avg_weight_g: unknown;
    sample_size: unknown;
    weighed_at: Date | string | null;
  }>`
    SELECT pl.id, pl.stock_lot_id, pl.lot_code, pl.lot_type,
           w.avg_weight_g, w.sample_size, w.occurred_at AS weighed_at
      FROM production_production_lots pl
      LEFT JOIN production_lot_weighings w ON w.id = (
             SELECT w2.id
               FROM production_lot_weighings w2
              WHERE w2.production_lot_id = pl.id
                AND w2.status = 'RECORDED'
                AND w2.occurred_at <= ${input.at}
              ORDER BY w2.occurred_at DESC, w2.id DESC
              LIMIT 1)
     WHERE pl.status IN (${sql.join(REARING_LOT_STATUSES.map((status) => sql`${status}`))})
       AND ${scopeSql(scope, { site: 'pl.site_id', users: ['pl.created_by'] })}
     ORDER BY pl.lot_code ASC
  `.execute(executor);
  const lots = await mapInBatches(rows, LOT_BATCH, async (row): Promise<LatestWeighingLot> => {
    const rearingHeads = await lotHeadcount(executor, {
      lotId: fromBin(row.stock_lot_id),
      scope: 'REARING',
      at: input.at,
    });
    const weighed = row.weighed_at !== null;
    return {
      lotId: fromBin(row.id),
      lotCode: row.lot_code,
      lotType: row.lot_type,
      rearingHeads,
      avgWeightG: weighed ? num(row.avg_weight_g) : null,
      sampleSize: weighed ? num(row.sample_size) : null,
      weighedAt: row.weighed_at !== null ? toIso(row.weighed_at) : null,
    };
  });

  const groups = new Map<
    string,
    { lots: number; weighedLots: number; heads: number; weighedHeads: number; weightedSum: number }
  >();
  for (const lot of lots) {
    const group = groups.get(lot.lotType) ?? {
      lots: 0,
      weighedLots: 0,
      heads: 0,
      weighedHeads: 0,
      weightedSum: 0,
    };
    group.lots += 1;
    group.heads += lot.rearingHeads;
    if (lot.avgWeightG !== null) {
      group.weighedLots += 1;
      if (lot.rearingHeads > 0) {
        group.weighedHeads += lot.rearingHeads;
        group.weightedSum += lot.avgWeightG * lot.rearingHeads;
      }
    }
    groups.set(lot.lotType, group);
  }
  const byLotType = [...groups.entries()]
    .map(([lotType, group]): LatestWeighingType => ({
      lotType,
      lots: group.lots,
      weighedLots: group.weighedLots,
      rearingHeads: round3(group.heads),
      weighedHeads: round3(group.weighedHeads),
      avgWeightG:
        group.weighedHeads > 0
          ? Math.round((group.weightedSum / group.weighedHeads) * 10) / 10
          : null,
    }))
    .sort(byHeadsThenCode);
  return { lots, byLotType };
}

// ---------------------------------------------------------------------------------------------
// KPI-PRD-09 — coût par tête
// ---------------------------------------------------------------------------------------------

export interface CostPerHeadLot {
  readonly lotId: string;
  readonly lotCode: string;
  readonly lotType: string;
  /** Effectif non vendu à l'instant de lecture. */
  readonly unsoldHeads: number;
  /** Coût restant du lot (ADR-027), `0` si le lot n'en porte pas. */
  readonly remainingCostXaf: number;
  /** Coût restant (borné à 0) ÷ effectif non vendu, franc demi supérieur ; `null` si l'effectif est nul. */
  readonly costPerHeadXaf: number | null;
}

export interface CostPerHeadType {
  readonly lotType: string;
  readonly lots: number;
  /** Têtes en élevage de tous les lots du type (choix du type de référence, AV-475). */
  readonly rearingHeads: number;
  /** Somme des effectifs non vendus des lots d'effectif > 0. */
  readonly unsoldHeads: number;
  /** Somme des coûts restants (bornés à 0) de ces lots. */
  readonly remainingCostXaf: number;
  /** Somme des coûts ÷ somme des effectifs, franc demi supérieur ; `null` si l'effectif est nul. */
  readonly costPerHeadXaf: number | null;
}

export interface CostPerHead {
  /** Lots en élevage du périmètre, tri par code de lot. */
  readonly lots: readonly CostPerHeadLot[];
  /** Par type de lot : plus de têtes en élevage d'abord, puis code croissant. */
  readonly byLotType: readonly CostPerHeadType[];
}

/**
 * Coût par tête des lots en élevage (AV-478) à l'instant de lecture : le coût restant n'existe qu'à l'instant
 * courant (`biologicalLotRemainingCostXaf`). Par type : Σ coûts restants ÷ Σ effectifs non vendus — la moyenne
 * des coûts par tête de lots de tailles différentes serait fausse.
 */
export async function costPerHead(executor: Executor, scope: ReadScope): Promise<CostPerHead> {
  const rearing = await rearingLots(executor, scope);
  const measured = await mapInBatches(rearing, LOT_BATCH, async (lot) => {
    const [unsoldHeads, rearingHeads, remaining] = await Promise.all([
      lotHeadcount(executor, { lotId: lot.stockLotId, scope: 'UNSOLD' }),
      lotHeadcount(executor, { lotId: lot.stockLotId, scope: 'REARING' }),
      biologicalLotRemainingCostXaf(executor, lot.stockLotId),
    ]);
    const remainingCostXaf = remaining ?? 0;
    return {
      lot: {
        lotId: lot.lotId,
        lotCode: lot.lotCode,
        lotType: lot.lotType,
        unsoldHeads,
        remainingCostXaf,
        costPerHeadXaf:
          unsoldHeads > 0
            ? costPerHeadXaf(Math.max(0, remainingCostXaf), quantityFromDecimal(unsoldHeads))
            : null,
      } satisfies CostPerHeadLot,
      rearingHeads,
    };
  });

  const groups = new Map<
    string,
    { lots: number; rearingHeads: number; unsoldHeads: number; remainingCostXaf: number }
  >();
  for (const { lot, rearingHeads } of measured) {
    const group = groups.get(lot.lotType) ?? {
      lots: 0,
      rearingHeads: 0,
      unsoldHeads: 0,
      remainingCostXaf: 0,
    };
    group.lots += 1;
    group.rearingHeads += rearingHeads;
    if (lot.unsoldHeads > 0) {
      group.unsoldHeads += lot.unsoldHeads;
      group.remainingCostXaf += Math.max(0, lot.remainingCostXaf);
    }
    groups.set(lot.lotType, group);
  }
  const byLotType = [...groups.entries()]
    .map(([lotType, group]): CostPerHeadType => {
      const unsoldHeads = round3(group.unsoldHeads);
      return {
        lotType,
        lots: group.lots,
        rearingHeads: round3(group.rearingHeads),
        unsoldHeads,
        remainingCostXaf: group.remainingCostXaf,
        costPerHeadXaf:
          unsoldHeads > 0
            ? costPerHeadXaf(group.remainingCostXaf, quantityFromDecimal(unsoldHeads))
            : null,
      };
    })
    .sort(byHeadsThenCode);
  return { lots: measured.map((entry) => entry.lot), byLotType };
}

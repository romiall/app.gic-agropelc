/**
 * Répartition des frais généraux d'une ferme entre les lots d'une espèce (ADR-026 amendé ;
 * AV-043, AV-104, AV-105, AV-106 ; P7-10). Utilisée par la commande à la demande
 * `production.overhead.allocate` et par la clôture d'un lot (part estimée).
 *
 * - Masse du mois = solde des écritures `FRAIS_GENERAUX` de l'objet de coût `SITE` pour
 *   l'espèce et le mois métier : saisies − annulations − parts déjà réparties. Une nouvelle
 *   exécution ne porte donc que sur le montant non encore réparti (régularisation, AV-106) ;
 *   rien n'est jamais réécrit.
 * - Lots candidats : lots actifs ou en vente de la ferme et de l'espèce, sans part estimée déjà
 *   reçue pour ce mois (AV-105) ; clé = têtes × jours en élevage (bâtiments et cases) sur les
 *   jours du mois écoulés (mois en cours : jusqu'au jour de l'opération).
 * - Parts au prorata, exactes au franc (plus fort reste) ; chaque part est une écriture
 *   `FRAIS_GENERAUX` (débit) du lot, la somme répartie une écriture inverse (crédit) du site ;
 *   écritures datées au plus tard de la fin du mois réparti.
 * - Part estimée d'un lot à sa clôture (`CLOSING_ESTIMATE`) : même calcul, seule la part du lot
 *   est écrite ; les exécutions suivantes du mois l'excluent.
 */
import {
  allocateProRata,
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  businessMonthDays,
  lotTypeProfile,
  type IdGenerator,
  type ProductionLotType,
} from '@gic/domain';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';
import {
  costObjectBalance,
  lotHeadDays,
  recordCostEntry,
  type SpeciesGroup,
} from '../../inventory/application/public/index.js';

export type AllocationRunKind = 'INITIAL' | 'REGULARIZATION' | 'CLOSING_ESTIMATE';

export interface AllocationInput {
  readonly runId: string;
  readonly siteId: string;
  readonly speciesGroup: SpeciesGroup;
  /** Mois métier `AAAA-MM`. */
  readonly period: string;
  /** Part estimée d'un seul lot, à sa clôture (AV-105). */
  readonly closingLotId?: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
  readonly commandId: string | null;
}

export type AllocationResult =
  | {
      readonly ok: true;
      readonly runKind: AllocationRunKind;
      readonly poolXaf: number;
      readonly allocatedXaf: number;
      readonly headDaysTotal: number;
      readonly lines: readonly {
        readonly lotId: string;
        readonly headDays: number;
        readonly amountXaf: number;
      }[];
    }
  | { readonly ok: false; readonly reason: 'NOTHING_TO_ALLOCATE' | 'NO_LOT_TO_ALLOCATE' };

/** Bornes UTC d'un mois métier et jours à compter (jusqu'au jour de l'opération). */
export function periodWindow(
  period: string,
  at: Date,
): { readonly start: Date; readonly end: Date; readonly days: readonly string[] } {
  const all = businessMonthDays(period);
  return {
    start: businessDayStartUtc(all[0]!),
    end: businessDayEndUtc(all[all.length - 1]!),
    days: businessMonthDays(period, businessDayOf(at)),
  };
}

/** Masse non encore répartie du mois (saisies − annulations − parts réparties). */
export async function overheadPool(
  uow: UnitOfWork,
  input: {
    readonly siteId: string;
    readonly speciesGroup: SpeciesGroup;
    readonly start: Date;
    readonly end: Date;
  },
): Promise<number> {
  return (
    await costObjectBalance(uow, {
      costObjectType: 'SITE',
      costObjectId: input.siteId,
      from: input.start,
      at: new Date(input.end.getTime() - 1),
      costTypes: ['FRAIS_GENERAUX'],
      speciesGroup: input.speciesGroup,
    })
  ).netXaf;
}

export async function allocateOverheads(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: AllocationInput,
): Promise<AllocationResult> {
  const { start, end, days } = periodWindow(input.period, input.occurredAt);
  const pool = await overheadPool(uow, { ...input, start, end });
  if (pool <= 0 || days.length === 0) return { ok: false, reason: 'NOTHING_TO_ALLOCATE' };

  const previous = await uow
    .selectFrom('production_overhead_allocations')
    .select(['sequence', 'run_kind', 'production_lot_id'])
    .where('site_id', '=', toBin(input.siteId))
    .where('species_group', '=', input.speciesGroup)
    .where('period', '=', input.period)
    .forUpdate()
    .execute();
  const estimated = new Set(
    previous
      .filter((run) => run.production_lot_id !== null)
      .map((run) => fromBin(run.production_lot_id!)),
  );
  const lots = (
    await uow
      .selectFrom('production_production_lots')
      .select(['id', 'lot_type', 'stock_lot_id'])
      .where('site_id', '=', toBin(input.siteId))
      .where('status', 'in', ['ACTIVE', 'SELLING'])
      .orderBy('lot_code', 'asc')
      .execute()
  ).filter(
    (lot) =>
      lotTypeProfile(lot.lot_type as ProductionLotType).species === input.speciesGroup &&
      !estimated.has(fromBin(lot.id)),
  );
  const weights: { key: string; weight: number; headDays: number }[] = [];
  for (const lot of lots) {
    const headDays = await lotHeadDays(uow, {
      lotId: fromBin(lot.stock_lot_id),
      scope: 'REARING',
      fromUtc: start,
      toUtc: businessDayEndUtc(days[days.length - 1]!),
      days,
    });
    if (headDays > 0) {
      weights.push({ key: fromBin(lot.id), weight: Math.round(headDays * 1000), headDays });
    }
  }
  if (
    weights.length === 0 ||
    (input.closingLotId !== undefined && !weights.some((w) => w.key === input.closingLotId))
  ) {
    return { ok: false, reason: 'NO_LOT_TO_ALLOCATE' };
  }
  const shares = allocateProRata(
    pool,
    weights.map((w) => ({ key: w.key, weight: w.weight })),
  );
  const kept =
    input.closingLotId === undefined
      ? shares
      : shares.filter((share) => share.key === input.closingLotId);
  const allocated = kept.reduce((sum, share) => sum + share.amountXaf, 0);
  const headDaysTotal = Math.round(weights.reduce((sum, w) => sum + w.headDays, 0) * 1000) / 1000;
  const runKind: AllocationRunKind =
    input.closingLotId !== undefined
      ? 'CLOSING_ESTIMATE'
      : previous.some((run) => run.run_kind !== 'CLOSING_ESTIMATE')
        ? 'REGULARIZATION'
        : 'INITIAL';
  const sequence = previous.reduce((max, run) => Math.max(max, run.sequence), 0) + 1;
  // Écritures datées au plus tard de la fin du mois réparti (masse du mois, ADR-026).
  const entriesAt = new Date(Math.min(input.occurredAt.getTime(), end.getTime() - 1));

  await uow
    .insertInto('production_overhead_allocations')
    .values({
      id: toBin(input.runId),
      site_id: toBin(input.siteId),
      species_group: input.speciesGroup,
      period: input.period,
      run_kind: runKind,
      sequence,
      pool_xaf: pool,
      allocated_xaf: allocated,
      head_days_total: String(headDaysTotal),
      production_lot_id: input.closingLotId === undefined ? null : toBin(input.closingLotId),
      occurred_at: input.occurredAt,
      command_id: input.commandId === null ? null : toBin(input.commandId),
      created_by: toBin(input.createdBy),
    })
    .execute();
  const headDaysOf = new Map(weights.map((w) => [w.key, w.headDays]));
  const lines: { lotId: string; headDays: number; amountXaf: number }[] = [];
  for (const share of kept) {
    const lineId = deps.idGenerator.newId();
    const costEntryId = await recordCostEntry(uow, deps, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: share.key,
      costType: 'FRAIS_GENERAUX',
      speciesGroup: input.speciesGroup,
      amountXaf: share.amountXaf,
      direction: 'DEBIT',
      sourceType: 'ALLOCATION',
      sourceId: lineId,
      occurredAt: entriesAt,
      createdBy: input.createdBy,
      comment: `Frais généraux ${input.period} (${runKind})`,
    });
    await uow
      .insertInto('production_overhead_allocation_lines')
      .values({
        id: toBin(lineId),
        allocation_id: toBin(input.runId),
        production_lot_id: toBin(share.key),
        head_days: String(headDaysOf.get(share.key) ?? 0),
        amount_xaf: share.amountXaf,
        cost_entry_id: costEntryId === null ? null : toBin(costEntryId),
      })
      .execute();
    lines.push({
      lotId: share.key,
      headDays: headDaysOf.get(share.key) ?? 0,
      amountXaf: share.amountXaf,
    });
  }
  await recordCostEntry(uow, deps, {
    costObjectType: 'SITE',
    costObjectId: input.siteId,
    costType: 'FRAIS_GENERAUX',
    speciesGroup: input.speciesGroup,
    amountXaf: allocated,
    direction: 'CREDIT',
    sourceType: 'ALLOCATION',
    sourceId: input.runId,
    occurredAt: entriesAt,
    createdBy: input.createdBy,
    comment: `Frais généraux ${input.period} répartis (${runKind})`,
  });
  return { ok: true, runKind, poolXaf: pool, allocatedXaf: allocated, headDaysTotal, lines };
}

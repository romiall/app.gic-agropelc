/**
 * Mouvements de vente d'un ensemble de lots (P4-09 : chiffre d'affaires et marge d'un lot, stratégie
 * finance §6.2-6.3). Le module `sales` connaît les montants, ce module les quantités et les lots :
 * il rend, pour les lignes de vente qui ont puisé dans ces lots, **tous** leurs mouvements `SALE`
 * (une ligne répartie sur plusieurs lots par le FIFO doit être partagée entre eux) et les retours
 * `CUSTOMER_RETURN` rattachés à ces mouvements (annulations, ADR-029). Lecture simple, sans verrou.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface SaleLineMove {
  readonly moveId: string;
  readonly saleId: string;
  readonly saleLineId: string;
  readonly lotId: string | null;
  readonly quantity: number;
  /** Valeur figée (coût des ventes). */
  readonly valueXaf: number;
  readonly occurredAt: Date;
}

export interface SaleReturnMove {
  readonly moveId: string;
  readonly originMoveId: string;
  /** Document d'annulation de vente et sa ligne (source du retour). */
  readonly cancellationId: string;
  readonly cancellationLineId: string | null;
  readonly lotId: string | null;
  readonly quantity: number;
  readonly valueXaf: number;
  readonly occurredAt: Date;
}

export interface LotSaleMoves {
  readonly saleMoves: readonly SaleLineMove[];
  readonly returns: readonly SaleReturnMove[];
}

export async function saleMovesOfLots(
  executor: Executor,
  lotIds: readonly string[],
): Promise<LotSaleMoves> {
  if (lotIds.length === 0) return { saleMoves: [], returns: [] };
  const lines = await executor
    .selectFrom('inventory_stock_moves')
    .select('source_line_id')
    .distinct()
    .where('move_type', '=', 'SALE')
    .where('source_doc_type', '=', 'SALE')
    .where(
      'lot_id',
      'in',
      lotIds.map((id) => toBin(id)),
    )
    .where('source_line_id', 'is not', null)
    .execute();
  const lineIds = lines.map((row) => row.source_line_id!);
  if (lineIds.length === 0) return { saleMoves: [], returns: [] };
  const saleRows = await executor
    .selectFrom('inventory_stock_moves')
    .select([
      'id',
      'source_doc_id',
      'source_line_id',
      'lot_id',
      'quantity',
      'value_xaf',
      'occurred_at',
    ])
    .where('move_type', '=', 'SALE')
    .where('source_doc_type', '=', 'SALE')
    .where('source_line_id', 'in', lineIds)
    .orderBy('occurred_at', 'asc')
    .orderBy('recorded_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const saleMoves = saleRows.map((row) => ({
    moveId: fromBin(row.id),
    saleId: fromBin(row.source_doc_id),
    saleLineId: fromBin(row.source_line_id!),
    lotId: fromBinOrNull(row.lot_id),
    quantity: Number(row.quantity),
    valueXaf: Number(row.value_xaf),
    occurredAt: row.occurred_at,
  }));
  const returnRows = await executor
    .selectFrom('inventory_stock_moves')
    .select([
      'id',
      'origin_move_id',
      'source_doc_id',
      'source_line_id',
      'lot_id',
      'quantity',
      'value_xaf',
      'occurred_at',
    ])
    .where('move_type', '=', 'CUSTOMER_RETURN')
    .where(
      'origin_move_id',
      'in',
      saleRows.map((row) => row.id),
    )
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return {
    saleMoves,
    returns: returnRows.map((row) => ({
      moveId: fromBin(row.id),
      originMoveId: fromBin(row.origin_move_id!),
      cancellationId: fromBin(row.source_doc_id),
      cancellationLineId: fromBinOrNull(row.source_line_id),
      lotId: fromBinOrNull(row.lot_id),
      quantity: Number(row.quantity),
      valueXaf: Number(row.value_xaf),
      occurredAt: row.occurred_at,
    })),
  };
}

export interface SaleCostOfPeriod {
  /** Σ des valeurs figées des mouvements `SALE` de la vente dans la période. */
  readonly soldXaf: number;
  /** Σ des valeurs des retours `CUSTOMER_RETURN` de la vente dans la période. */
  readonly returnedXaf: number;
}

/**
 * Coût des ventes d'une période par vente (BR-FIN-043, mêmes principes de date que le CA) : le
 * module `sales` filtre ensuite par site, commercial ou client. Début inclus, fin exclue.
 */
export async function saleCostsInPeriod(
  executor: Executor,
  period: { readonly fromUtc: Date; readonly toUtc: Date },
): Promise<ReadonlyMap<string, SaleCostOfPeriod>> {
  const sold = await executor
    .selectFrom('inventory_stock_moves')
    .select(['source_doc_id', sql<string>`SUM(value_xaf)`.as('value')])
    .where('move_type', '=', 'SALE')
    .where('source_doc_type', '=', 'SALE')
    .where('occurred_at', '>=', period.fromUtc)
    .where('occurred_at', '<', period.toUtc)
    .groupBy('source_doc_id')
    .execute();
  const returned = await executor
    .selectFrom('inventory_stock_moves as r')
    .innerJoin('inventory_stock_moves as o', 'o.id', 'r.origin_move_id')
    .select(['o.source_doc_id as source_doc_id', sql<string>`SUM(r.value_xaf)`.as('value')])
    .where('r.move_type', '=', 'CUSTOMER_RETURN')
    .where('o.source_doc_type', '=', 'SALE')
    .where('r.occurred_at', '>=', period.fromUtc)
    .where('r.occurred_at', '<', period.toUtc)
    .groupBy('o.source_doc_id')
    .execute();
  const result = new Map<string, { soldXaf: number; returnedXaf: number }>();
  for (const row of sold) {
    result.set(fromBin(row.source_doc_id), { soldXaf: Number(row.value), returnedXaf: 0 });
  }
  for (const row of returned) {
    const key = fromBin(row.source_doc_id);
    const current = result.get(key) ?? { soldXaf: 0, returnedXaf: 0 };
    result.set(key, { ...current, returnedXaf: Number(row.value) });
  }
  return result;
}

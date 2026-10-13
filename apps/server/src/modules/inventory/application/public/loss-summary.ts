/**
 * Valeur des pertes d'une période (P8-11 ; BR-FIN-044, KPI-FIN-08 ; AT-041 « quelles pertes ? » ;
 * ADR-062 §3) : déclarations de pertes regroupées par produit, par lot de production ou par motif,
 * en quantité et en valeur (coût figé de la déclaration). Indicateur, jamais une charge ajoutée au
 * coût d'un lot (BR-PRD-013).
 *
 * Statuts comptés : une perte constatée (`RECORDED`, `APPROVED`), non justifiée (`REJECTED_UNJUSTIFIED`)
 * ou en cours d'annulation (`CANCELLATION_PENDING`) ; à part, en attente de validation
 * (`PENDING_APPROVAL`). Une déclaration rejetée et rendue (`REJECTED_RETURNED`) ou annulée n'est pas une
 * perte.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

export const LOSS_SUMMARY_GROUPS = ['product', 'lot', 'reason'] as const;
export type LossSummaryGroup = (typeof LOSS_SUMMARY_GROUPS)[number];

const COUNTED = ['RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING'] as const;

export interface LossSummaryLine {
  readonly productId: string | null;
  readonly productionLotId: string | null;
  readonly category: string | null;
  readonly reasonCodeId: string | null;
  readonly declarations: number;
  readonly quantityBase: number;
  readonly valueXaf: number;
  readonly pendingQuantityBase: number;
  readonly pendingValueXaf: number;
}

export async function lossValueSummary(
  executor: Kysely<DB> | Transaction<DB>,
  filter: {
    readonly fromUtc: Date;
    readonly toUtc: Date;
    readonly groupBy: LossSummaryGroup;
    readonly siteIds?: readonly string[];
  },
): Promise<readonly LossSummaryLine[]> {
  if (filter.siteIds !== undefined && filter.siteIds.length === 0) return [];
  const keys =
    filter.groupBy === 'product'
      ? (['product_id'] as const)
      : filter.groupBy === 'lot'
        ? (['production_lot_id'] as const)
        : (['category', 'reason_code_id'] as const);
  const counted = sql.join(COUNTED.map((status) => sql`${status}`));
  const rows = await executor
    .selectFrom('inventory_loss_declarations')
    .select([
      ...keys,
      sql<string>`SUM(CASE WHEN status IN (${counted}) THEN 1 ELSE 0 END)`.as('declarations'),
      sql<string>`COALESCE(SUM(CASE WHEN status IN (${counted}) THEN quantity_base ELSE 0 END), 0)`.as(
        'quantity',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN status IN (${counted}) THEN value_xaf ELSE 0 END), 0)`.as(
        'value',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN quantity_base ELSE 0 END), 0)`.as(
        'pending_quantity',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN value_xaf ELSE 0 END), 0)`.as(
        'pending_value',
      ),
    ])
    .where('occurred_at', '>=', filter.fromUtc)
    .where('occurred_at', '<', filter.toUtc)
    .where('status', 'in', [...COUNTED, 'PENDING_APPROVAL'])
    .$if(filter.groupBy === 'lot', (qb) => qb.where('production_lot_id', 'is not', null))
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .groupBy([...keys])
    .execute();
  return rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        productId:
          'product_id' in record ? fromBinOrNull(record.product_id as Buffer | null) : null,
        productionLotId:
          'production_lot_id' in record
            ? fromBinOrNull(record.production_lot_id as Buffer | null)
            : null,
        category: 'category' in record ? (record.category as string) : null,
        reasonCodeId:
          'reason_code_id' in record ? fromBinOrNull(record.reason_code_id as Buffer | null) : null,
        declarations: Number(row.declarations),
        quantityBase: Number(row.quantity),
        valueXaf: Number(row.value),
        pendingQuantityBase: Number(row.pending_quantity),
        pendingValueXaf: Number(row.pending_value),
      };
    })
    .sort((a, b) => b.valueXaf - a.valueXaf || b.pendingValueXaf - a.pendingValueXaf);
}

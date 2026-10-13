/**
 * Lots de stock qui portent les ventes d'un lot de production (P8-11 ; ADR-062 §1 ; D07 l.234 « ventes
 * des têtes et produits du lot » ; AV-366) : outre le lot de stock du lot lui-même (`stockLotId` du
 * détail), les lots de stock de ses abattages enregistrés (origine `TRANSFORMATION`, ADR-027 §4). Les
 * œufs n'en sont pas : ils sortent du lot pondeur au coût standard par un crédit
 * `PRODUCTION_TRANSFEREE`, qui réduit déjà son coût net (compter leur CA doublerait leur valeur).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export async function slaughterStockLotIds(
  executor: Kysely<DB> | Transaction<DB>,
  productionLotId: string,
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('production_slaughter_batches')
    .select('stock_lot_id')
    .where('production_lot_id', '=', toBin(productionLotId))
    .where('status', '=', 'RECORDED')
    .orderBy('occurred_at')
    .execute();
  return rows.map((row) => fromBin(row.stock_lot_id));
}

/**
 * Réception d'animaux vue par la mise en place directe (AV-112, BR-PRD-004) : `production`
 * enchaîne, dans le même lot de commandes, `procurement.receipt.record` puis
 * `production.lot.record_entry` (source `PURCHASE`) et reclasse les têtes acceptées depuis
 * l'emplacement de réception, lot fournisseur par lot fournisseur. Lecture seule, par clé.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Réceptions dont le stock est entré et utilisable pour une mise en place. */
export const PLACEABLE_RECEIPT_STATUSES: readonly string[] = ['POSTED', 'POSTED_PENDING_REVIEW'];

export interface ReceiptForPlacement {
  readonly id: string;
  readonly siteId: string;
  readonly locationId: string;
  readonly status: string;
  readonly lines: readonly {
    readonly id: string;
    readonly productId: string;
    readonly acceptedBase: number;
    readonly stockLotId: string | null;
  }[];
}

export async function findReceiptForPlacement(
  executor: Kysely<DB> | Transaction<DB>,
  receiptId: string,
): Promise<ReceiptForPlacement | undefined> {
  const receipt = await executor
    .selectFrom('procurement_goods_receipts as r')
    .innerJoin('organization_locations as l', 'l.id', 'r.location_id')
    .select(['r.id', 'r.location_id', 'r.status', 'l.site_id'])
    .where('r.id', '=', toBin(receiptId))
    .executeTakeFirst();
  if (!receipt || !receipt.site_id) return undefined;
  const lines = await executor
    .selectFrom('procurement_goods_receipt_lines')
    .select(['id', 'product_id', 'qty_delivered_base', 'qty_rejected_base', 'stock_lot_id'])
    .where('receipt_id', '=', receipt.id)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return {
    id: fromBin(receipt.id),
    siteId: fromBin(receipt.site_id),
    locationId: fromBin(receipt.location_id),
    status: receipt.status,
    lines: lines.map((line) => ({
      id: fromBin(line.id),
      productId: fromBin(line.product_id),
      acceptedBase:
        Math.round((Number(line.qty_delivered_base) - Number(line.qty_rejected_base)) * 1000) /
        1000,
      stockLotId: fromBinOrNull(line.stock_lot_id),
    })),
  };
}

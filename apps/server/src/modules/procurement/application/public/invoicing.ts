/**
 * Facturation d'un bon de commande, vue de `procurement` (P8-07 ; ADR-043 §3 ; D08 l.93, D09 l.171 ;
 * SM-SUPPLIER-INVOICE). `finance` rapproche une facture fournisseur du BC et de ses réceptions, puis
 * fait écrire par `procurement`, seul propriétaire de la table, les quantités facturées
 * (`invoiced_qty_base`) quand une facture devient `APPROVED` (+) ou qu'une facture approuvée est
 * annulée (−). `procurement` n'importe jamais `finance` : il expose ces fonctions, `finance` les appelle
 * dans sa transaction.
 *
 * Verrous (ADR-038, ADR-043 §9) : en-tête du BC puis ses lignes, par identifiant croissant — l'ordre des
 * réceptions de P6. `lockOrderForInvoicing` est appelé avant `applyInvoicedQuantities` dans la même
 * transaction : deux factures concurrentes sur les mêmes lignes se rapprochent l'une après l'autre.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface InvoicingOrderLine {
  readonly poLineId: string;
  readonly productId: string;
  readonly unitPriceXaf: number;
  /** Quantités en unité de base, décimales (`numeric(14,3)`). */
  readonly acceptedQtyBase: number;
  readonly invoicedQtyBase: number;
}

export interface InvoicingOrder {
  readonly orderId: string;
  readonly docNumber: string;
  readonly supplierId: string;
  readonly siteId: string;
  readonly status: string;
  readonly lines: readonly InvoicingOrderLine[];
}

/** BC et lignes verrouillés (`FOR UPDATE`, en-tête puis lignes par identifiant) ; `undefined` s'il n'existe pas. */
export async function lockOrderForInvoicing(
  uow: Transaction<DB>,
  orderId: string,
): Promise<InvoicingOrder | undefined> {
  const order = await uow
    .selectFrom('procurement_purchase_orders')
    .select(['id', 'doc_number', 'supplier_id', 'site_id', 'status'])
    .where('id', '=', toBin(orderId))
    .forUpdate()
    .executeTakeFirst();
  if (!order) return undefined;
  const lines = await uow
    .selectFrom('procurement_purchase_order_lines')
    .select(['id', 'product_id', 'unit_price_xaf', 'accepted_qty_base', 'invoiced_qty_base'])
    .where('order_id', '=', order.id)
    .orderBy('id')
    .forUpdate()
    .execute();
  return {
    orderId: fromBin(order.id),
    docNumber: order.doc_number,
    supplierId: fromBin(order.supplier_id),
    siteId: fromBin(order.site_id),
    status: order.status,
    lines: lines.map((line) => ({
      poLineId: fromBin(line.id),
      productId: fromBin(line.product_id),
      unitPriceXaf: Number(line.unit_price_xaf),
      acceptedQtyBase: Number(line.accepted_qty_base),
      invoicedQtyBase: Number(line.invoiced_qty_base),
    })),
  };
}

/**
 * Ajoute (delta positif) ou retire (delta négatif) des quantités facturées aux lignes d'un BC déjà
 * verrouillé par `lockOrderForInvoicing`. Les deltas sont arrondis au millième (`numeric(14,3)`) ; le
 * CHECK du BC refuse un facturé négatif (filet : le code n'enlève que ce qu'il a ajouté).
 */
export async function applyInvoicedQuantities(
  uow: Transaction<DB>,
  input: {
    readonly orderId: string;
    readonly lines: readonly { readonly poLineId: string; readonly deltaBase: number }[];
  },
): Promise<void> {
  for (const line of [...input.lines].sort((a, b) => a.poLineId.localeCompare(b.poLineId))) {
    if (line.deltaBase === 0) continue;
    const delta = (Math.round(line.deltaBase * 1000) / 1000).toFixed(3);
    await uow
      .updateTable('procurement_purchase_order_lines')
      .set({ invoiced_qty_base: sql`invoiced_qty_base + ${delta}` })
      .where('id', '=', toBin(line.poLineId))
      .where('order_id', '=', toBin(input.orderId))
      .execute();
  }
}

export interface InvoicingReceiptLine {
  readonly receiptLineId: string;
  readonly receiptId: string;
  readonly poLineId: string | null;
  readonly supplierId: string;
  readonly receiptStatus: string;
}

/** Lignes de réception citées par une facture (BR-FIN-030) : rattachement et fournisseur. */
export async function receiptLinesForInvoicing(
  executor: Executor,
  receiptLineIds: readonly string[],
): Promise<ReadonlyMap<string, InvoicingReceiptLine>> {
  if (receiptLineIds.length === 0) return new Map();
  const rows = await executor
    .selectFrom('procurement_goods_receipt_lines as l')
    .innerJoin('procurement_goods_receipts as r', 'r.id', 'l.receipt_id')
    .select([
      'l.id as id',
      'l.receipt_id as receipt_id',
      'l.po_line_id as po_line_id',
      'r.supplier_id as supplier_id',
      'r.status as status',
    ])
    .where(
      'l.id',
      'in',
      receiptLineIds.map((id) => toBin(id)),
    )
    .execute();
  return new Map(
    rows.map((row) => [
      fromBin(row.id),
      {
        receiptLineId: fromBin(row.id),
        receiptId: fromBin(row.receipt_id),
        poLineId: fromBinOrNull(row.po_line_id),
        supplierId: fromBin(row.supplier_id),
        receiptStatus: row.status,
      },
    ]),
  );
}

/** Σ quantités facturées d'un BC (lecture du rapprochement, sans verrou). */
export async function invoicedQuantitiesOfOrder(
  executor: Executor,
  orderId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await executor
    .selectFrom('procurement_purchase_order_lines')
    .select(['id', 'invoiced_qty_base'])
    .where('order_id', '=', toBin(orderId))
    .execute();
  return new Map(rows.map((row) => [fromBin(row.id), Number(row.invoiced_qty_base)]));
}

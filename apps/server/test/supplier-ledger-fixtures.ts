/**
 * Données de test des factures et paiements fournisseurs (P8-07, P8-08) : fournisseur, bon de commande
 * envoyé avec ses lignes (accepté déjà porté par la ligne, comme après des réceptions comptabilisées),
 * ligne de réception, lecture du facturé d'une ligne. Écritures directes en base : ces tests portent sur
 * `finance`, les commandes d'achat de P6 ont leurs propres tests (AT-025 les enchaîne de bout en bout).
 */
import { db, freshUuid, insertTestLocation, insertTestProduct } from './helpers.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { tx } from './cash-transfer-fixtures.js';

export async function newSupplier(
  createdBy: string,
  options: { readonly paymentTermsDays?: number | null } = {},
): Promise<string> {
  const id = freshUuid();
  await db
    .insertInto('procurement_suppliers')
    .values({
      id: toBin(id),
      code: `F-${id.slice(-10)}`,
      name: `Provenderie ${id.slice(-4)}`,
      supplied_categories: JSON.stringify([]),
      payment_terms_days: options.paymentTermsDays ?? null,
      created_by: toBin(createdBy),
    })
    .execute();
  return id;
}

export interface TestOrder {
  readonly orderId: string;
  readonly lineIds: readonly string[];
  readonly productId: string;
  readonly locationId: string;
}

/** BC `PARTIALLY_RECEIVED` : lignes (commandé, prix par unité de base, accepté). */
export async function newOrder(input: {
  readonly createdBy: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly lines: readonly {
    readonly ordered: number;
    readonly priceXaf: number;
    readonly accepted: number;
  }[];
  readonly occurredAt: string;
}): Promise<TestOrder> {
  const { productId, locationId } = await tx(async (trx) => ({
    productId: await insertTestProduct(trx, input.createdBy),
    locationId: await insertTestLocation(trx, input.createdBy, input.siteId),
  }));
  const orderId = freshUuid();
  const total = input.lines.reduce(
    (sum, line) => sum + Math.round(line.ordered * line.priceXaf),
    0,
  );
  await db
    .insertInto('procurement_purchase_orders')
    .values({
      id: toBin(orderId),
      doc_number: `BC-T-${orderId.slice(-12)}`,
      site_id: toBin(input.siteId),
      supplier_id: toBin(input.supplierId),
      delivery_location_id: toBin(locationId),
      total_xaf: total,
      status: 'PARTIALLY_RECEIVED',
      sent_at: new Date(input.occurredAt),
      occurred_at: new Date(input.occurredAt),
      created_by: toBin(input.createdBy),
    })
    .execute();
  const lineIds: string[] = [];
  for (const [index, line] of input.lines.entries()) {
    const lineId = freshUuid();
    lineIds.push(lineId);
    await db
      .insertInto('procurement_purchase_order_lines')
      .values({
        id: toBin(lineId),
        order_id: toBin(orderId),
        line_no: index + 1,
        product_id: toBin(productId),
        unit_code: 'TETE',
        ordered_qty_base: line.ordered.toFixed(3),
        unit_price_xaf: line.priceXaf,
        line_total_xaf: Math.round(line.ordered * line.priceXaf),
        accepted_qty_base: line.accepted.toFixed(3),
      })
      .execute();
  }
  return { orderId, lineIds, productId, locationId };
}

/** Réception comptabilisée (`POSTED`) d'une ligne de BC ; renvoie l'identifiant de sa ligne. */
export async function newReceiptLine(input: {
  readonly createdBy: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly order: TestOrder;
  readonly poLineId: string;
  readonly delivered: number;
  readonly rejected: number;
  readonly unitCostXaf: number;
  readonly occurredAt: string;
}): Promise<string> {
  const receiptId = freshUuid();
  await db
    .insertInto('procurement_goods_receipts')
    .values({
      id: toBin(receiptId),
      doc_number: `REC-T-${receiptId.slice(-12)}`,
      site_id: toBin(input.siteId),
      purchase_order_id: toBin(input.order.orderId),
      supplier_id: toBin(input.supplierId),
      location_id: toBin(input.order.locationId),
      received_by: toBin(input.createdBy),
      status: 'POSTED',
      occurred_at: new Date(input.occurredAt),
      created_by: toBin(input.createdBy),
    })
    .execute();
  const lineId = freshUuid();
  await db
    .insertInto('procurement_goods_receipt_lines')
    .values({
      id: toBin(lineId),
      receipt_id: toBin(receiptId),
      po_line_id: toBin(input.poLineId),
      product_id: toBin(input.order.productId),
      unit_code: 'TETE',
      qty_delivered_base: input.delivered.toFixed(3),
      qty_rejected_base: input.rejected.toFixed(3),
      unit_cost_xaf: input.unitCostXaf,
    })
    .execute();
  return lineId;
}

export async function invoicedOf(poLineId: string): Promise<number> {
  const row = await db
    .selectFrom('procurement_purchase_order_lines')
    .select('invoiced_qty_base')
    .where('id', '=', toBin(poLineId))
    .executeTakeFirstOrThrow();
  return Number(row.invoiced_qty_base);
}

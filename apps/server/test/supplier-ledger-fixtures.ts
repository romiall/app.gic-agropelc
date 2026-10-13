/**
 * Données de test des factures et paiements fournisseurs (P8-07, P8-08) : fournisseur, bon de commande
 * envoyé avec ses lignes et leurs réceptions comptabilisées, ligne de réception, lecture du facturé d'une
 * ligne. Écritures directes en base : ces tests portent sur `finance`, les commandes d'achat de P6 ont
 * leurs propres tests (AT-025 les enchaîne de bout en bout).
 *
 * Revue de P8-14 : la base de test est partagée et les invariants de P6 la balaient en entier
 * (`procurement-invariants.test.ts`). L'accepté d'une ligne de BC est donc toujours la somme de
 * réceptions comptabilisées (INV-APP-02), chacune avec son entrée `PURCHASE_RECEIPT` en stock (API
 * publique d'`inventory`, INV-STK-12) et sa valeur acceptée (Σ accepté × coût).
 */
import { sql } from 'kysely';
import { db, freshUuid, insertTestLocation, insertTestProduct } from './helpers.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { Uuidv7Generator, SystemClock } from '@gic/domain';
import { tx } from './cash-transfer-fixtures.js';

const idGenerator = new Uuidv7Generator(new SystemClock());

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
  /** Ligne de la réception comptabilisée de chaque ligne de BC acceptée (`null` si rien d'accepté). */
  readonly receiptLineIds: readonly (string | null)[];
  readonly productId: string;
  readonly locationId: string;
  readonly siteId: string;
  readonly supplierId: string;
}

/** Valeur acceptée d'une ligne de réception (arrondi au franc, comme P6). */
const acceptedValue = (quantity: number, unitCostXaf: number) =>
  Math.floor((Math.round(quantity * 1000) * unitCostXaf + 500) / 1000);

/**
 * Réception d'une ligne de BC, au statut donné (`POSTED` par défaut) ; renvoie l'identifiant de sa
 * ligne. Comptabilisée : entrée en stock de l'accepté et accepté de la ligne de BC augmenté d'autant
 * (l'appelant reste sous le commandé : aucun excédent n'est tracé ici). En quarantaine ou rejetée :
 * aucun mouvement, aucun accepté (INV-APP-03).
 */
export async function newReceiptLine(input: {
  readonly createdBy: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly order: Pick<TestOrder, 'orderId' | 'productId' | 'locationId'>;
  readonly poLineId: string;
  readonly delivered: number;
  readonly rejected: number;
  readonly unitCostXaf: number;
  readonly occurredAt: string;
  readonly status?: 'POSTED' | 'QUARANTINED';
}): Promise<string> {
  const status = input.status ?? 'POSTED';
  const accepted = input.delivered - input.rejected;
  const receiptId = freshUuid();
  const lineId = freshUuid();
  await tx(async (trx) => {
    await trx
      .insertInto('procurement_goods_receipts')
      .values({
        id: toBin(receiptId),
        doc_number: `REC-T-${receiptId.slice(-12)}`,
        site_id: toBin(input.siteId),
        purchase_order_id: toBin(input.order.orderId),
        supplier_id: toBin(input.supplierId),
        location_id: toBin(input.order.locationId),
        received_by: toBin(input.createdBy),
        status,
        total_accepted_value_xaf: acceptedValue(accepted, input.unitCostXaf),
        occurred_at: new Date(input.occurredAt),
        created_by: toBin(input.createdBy),
      })
      .execute();
    await trx
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
    if (status !== 'POSTED' || accepted <= 0) return;
    await recordStockMove(
      trx,
      { idGenerator },
      {
        productId: input.order.productId,
        quantityBase: accepted,
        fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
        toLocationId: input.order.locationId,
        moveType: 'PURCHASE_RECEIPT',
        declaredUnitCostXaf: input.unitCostXaf,
        occurredAt: new Date(input.occurredAt),
        sourceDocType: 'GOODS_RECEIPT',
        sourceDocId: receiptId,
        sourceLineId: lineId,
        createdBy: input.createdBy,
        allowNegative: false,
      },
    );
    await trx
      .updateTable('procurement_purchase_order_lines')
      .set({ accepted_qty_base: sql`accepted_qty_base + ${accepted.toFixed(3)}` })
      .where('id', '=', toBin(input.poLineId))
      .execute();
  });
  return lineId;
}

/**
 * BC `PARTIALLY_RECEIVED` : lignes (commandé, prix par unité de base, accepté) ; l'accepté de chaque
 * ligne vient d'une réception comptabilisée créée ici, au prix du BC.
 */
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
  const receiptLineIds: (string | null)[] = [];
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
      })
      .execute();
    receiptLineIds.push(
      line.accepted > 0
        ? await newReceiptLine({
            createdBy: input.createdBy,
            siteId: input.siteId,
            supplierId: input.supplierId,
            order: { orderId, productId, locationId },
            poLineId: lineId,
            delivered: line.accepted,
            rejected: 0,
            unitCostXaf: line.priceXaf,
            occurredAt: input.occurredAt,
          })
        : null,
    );
  }
  return {
    orderId,
    lineIds,
    receiptLineIds,
    productId,
    locationId,
    siteId: input.siteId,
    supplierId: input.supplierId,
  };
}

export async function invoicedOf(poLineId: string): Promise<number> {
  const row = await db
    .selectFrom('procurement_purchase_order_lines')
    .select('invoiced_qty_base')
    .where('id', '=', toBin(poLineId))
    .executeTakeFirstOrThrow();
  return Number(row.invoiced_qty_base);
}

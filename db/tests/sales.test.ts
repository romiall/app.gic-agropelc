// Contraintes de base du module `sales` (P4-02 2/2, ADR-028) : commandes et quantités de ligne
// (INV-VEN-04), vente immuable avec montant annulé monotone (INV-VEN-02, INV-VEN-06, INV-VEN-07),
// montant de ligne arrondi (INV-VEN-03), documents d'annulation, bons de livraison en ajout seul,
// encaissements (unicité de la référence normalisée par moyen, INV-FIN-03) et registre d'affectation
// (INV-FIN-04). Chaque test crée ses propres référentiels dans une transaction annulée.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

const T0 = '2026-10-01 08:00:00.000000';
const T1 = '2026-10-01 09:00:00.000000';

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

interface Refs {
  readonly admin: Buffer;
  readonly zoneId: Buffer;
  readonly siteId: Buffer;
  readonly storeId: Buffer;
  readonly toDeliverId: Buffer;
  readonly customerId: Buffer;
  readonly channel: string;
  readonly productId: Buffer;
  readonly unitCode: string;
  readonly methodCode: string;
  readonly accountId: Buffer;
  readonly reasonId: Buffer;
}

async function setup(conn: PoolConnection): Promise<Refs> {
  const admin = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
    [admin, `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, admin],
  );
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, randomCode('Z'), admin],
  );
  const siteId = randomId();
  await conn.query(
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by) VALUES (?, ?, 'Magasin', 'MAGASIN', ?, ?)`,
    [siteId, randomCode('S'), zoneId, admin],
  );
  const storeId = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'Réserve', 'STORE', ?)`,
    [storeId, siteId, randomCode('L'), admin],
  );
  const toDeliverId = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'À livrer', 'V_TO_DELIVER', ?)`,
    [toDeliverId, siteId, randomCode('TD'), admin],
  );
  const stepId = randomId();
  await conn.query(
    `INSERT INTO crm_pipeline_steps (id, code, label, sort_order, created_by) VALUES (?, ?, 'Nouveau', 10, ?)`,
    [stepId, randomCode('STEP_'), admin],
  );
  const sourceCode = randomCode('SRC_');
  await conn.query(
    `INSERT INTO crm_lead_sources (id, code, label, created_by) VALUES (?, ?, 'Terrain', ?)`,
    [randomId(), sourceCode, admin],
  );
  const customerId = randomId();
  await conn.query(
    `INSERT INTO crm_customers (id, stage, pipeline_step_id, display_name, phone_primary, zone_id, source_code,
       acquired_by_user_id, acquired_at, occurred_at, created_by)
     VALUES (?, 'PROSPECT', ?, 'Boutique test', ?, ?, ?, ?, ?, ?, ?)`,
    [
      customerId,
      stepId,
      `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      zoneId,
      sourceCode,
      admin,
      T0,
      T0,
      admin,
    ],
  );
  const channel = randomCode('CH').slice(0, 20);
  await conn.query(`INSERT INTO catalog_sales_channels (code, name) VALUES (?, 'Test')`, [channel]);
  const unitCode = randomCode('U').slice(0, 20);
  await conn.query(`INSERT INTO catalog_units (code, name, is_count) VALUES (?, 'Pièce', TRUE)`, [
    unitCode,
  ]);
  const categoryId = randomId();
  await conn.query(
    `INSERT INTO catalog_product_categories (id, code, name, created_by) VALUES (?, ?, 'Divers', ?)`,
    [categoryId, randomCode('C'), admin],
  );
  const productId = randomId();
  await conn.query(
    `INSERT INTO catalog_products (id, code, name, category_id, stock_family, base_unit_code, created_by)
     VALUES (?, ?, 'Produit', ?, 'MARCHANDISE', ?, ?)`,
    [productId, randomCode('P'), categoryId, unitCode, admin],
  );
  const methodCode = randomCode('MP').slice(0, 40);
  await conn.query(
    `INSERT INTO finance_payment_methods (code, label, requires_reference, default_account_type)
     VALUES (?, 'Mobile money test', TRUE, 'MOBILE_MONEY')`,
    [methodCode],
  );
  const accountId = randomId();
  await conn.query(
    `INSERT INTO finance_cash_accounts (id, code, name, account_type, holder_user_id, responsible_user_id, created_by)
     VALUES (?, ?, 'Caisse', 'CAISSE_UTILISATEUR', ?, ?, ?)`,
    [accountId, randomCode('CPT'), admin, admin, admin],
  );
  const reasonId = randomId();
  await conn.query(
    `INSERT INTO catalog_reason_codes (id, category, code, label, created_by) VALUES (?, 'REJECTION', ?, 'Motif test', ?)`,
    [reasonId, randomCode('R'), admin],
  );
  return {
    admin,
    reasonId,
    zoneId,
    siteId,
    storeId,
    toDeliverId,
    customerId,
    channel,
    productId,
    unitCode,
    methodCode,
    accountId,
  };
}

async function insertOrder(
  conn: PoolConnection,
  refs: Refs,
  overrides: { readonly status?: string; readonly extra?: string } = {},
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO sales_sales_orders (id, doc_number, site_id, customer_id, commercial_user_id, channel_code,
       fulfilment_location_id, status, confirmed_at, occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      randomCode('CMD-'),
      refs.siteId,
      refs.customerId,
      refs.admin,
      refs.channel,
      refs.storeId,
      overrides.status ?? 'CONFIRMED',
      T0,
      T0,
      refs.admin,
    ],
  );
  return id;
}

async function insertOrderLine(
  conn: PoolConnection,
  refs: Refs,
  orderId: Buffer,
  q: { readonly ordered: number; readonly sold?: number; readonly delivered?: number },
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO sales_sales_order_lines (id, order_id, line_no, product_id, product_name_snapshot, quantity, unit_code,
       quantity_base, sold_quantity_base, delivered_quantity_base, quoted_unit_price_xaf, line_total_xaf)
     VALUES (?, ?, 1, ?, 'Produit', ?, ?, ?, ?, ?, 1000, ?)`,
    [
      id,
      orderId,
      refs.productId,
      q.ordered,
      refs.unitCode,
      q.ordered,
      q.sold ?? 0,
      q.delivered ?? 0,
      q.ordered * 1000,
    ],
  );
  return id;
}

interface SaleInput {
  readonly type?: 'DIRECT' | 'ORDER';
  readonly orderId?: Buffer | null;
  readonly customer?: Buffer | null;
  readonly total?: number;
  readonly paid?: number;
  readonly cancelled?: number;
  readonly status?: string;
}

async function insertSale(
  conn: PoolConnection,
  refs: Refs,
  input: SaleInput = {},
): Promise<Buffer> {
  const id = randomId();
  const total = input.total ?? 10_000;
  const type = input.type ?? 'DIRECT';
  await conn.query(
    `INSERT INTO sales_sales (id, doc_number, site_id, sale_type, order_id, customer_id, channel_code, from_location_id,
       to_deliver_location_id, zone_id, seller_user_id, status, subtotal_xaf, total_xaf, cancelled_xaf, amount_paid_xaf,
       occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      randomCode('VTE-'),
      refs.siteId,
      type,
      input.orderId ?? null,
      input.customer === undefined ? refs.customerId : input.customer,
      refs.channel,
      refs.storeId,
      type === 'ORDER' ? refs.toDeliverId : null,
      refs.zoneId,
      refs.admin,
      input.status ?? 'CONFIRMED',
      total,
      total,
      input.cancelled ?? 0,
      input.paid ?? 0,
      T0,
      refs.admin,
    ],
  );
  return id;
}

async function insertSaleLine(
  conn: PoolConnection,
  refs: Refs,
  saleId: Buffer,
  input: {
    readonly quantity?: number;
    readonly pricingQuantity?: number;
    readonly unitPrice?: number;
    readonly discount?: number;
    readonly lineTotal?: number;
    readonly priceSource?: string;
    readonly reasonId?: Buffer | null;
    readonly lineNo?: number;
    readonly orderLineId?: Buffer | null;
  } = {},
): Promise<Buffer> {
  const id = randomId();
  const quantity = input.quantity ?? 10;
  // Par défaut une dérogation motivée : la source `RULE` exige une règle, une version et un prix catalogue.
  const priceSource = input.priceSource ?? 'MANUAL_OVERRIDE';
  const reasonId =
    input.reasonId === undefined
      ? priceSource === 'MANUAL_OVERRIDE'
        ? refs.reasonId
        : null
      : input.reasonId;
  await conn.query(
    `INSERT INTO sales_sale_lines (id, sale_id, line_no, order_line_id, product_id, product_name_snapshot, quantity,
       unit_code, quantity_base, pricing_quantity, pricing_unit_code, unit_price_xaf, price_source,
       override_reason_code_id, discount_xaf, line_total_xaf)
     VALUES (?, ?, ?, ?, ?, 'Produit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      saleId,
      input.lineNo ?? 1,
      input.orderLineId ?? null,
      refs.productId,
      quantity,
      refs.unitCode,
      quantity,
      input.pricingQuantity ?? quantity,
      refs.unitCode,
      input.unitPrice ?? 1000,
      priceSource,
      reasonId,
      input.discount ?? 0,
      input.lineTotal ?? 10_000,
    ],
  );
  return id;
}

describe('sales_sales_orders et lignes (INV-VEN-04, ADR-028)', () => {
  it('impose 0 ≤ livré ≤ vendu ≤ commandé sur la ligne, et que le livré ne diminue jamais', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const orderId = await insertOrder(conn, refs);
      await expect(insertOrderLine(conn, refs, orderId, { ordered: 10, sold: 11 })).rejects.toThrow(
        /ck_sales_sales_order_lines_quantities/,
      );
      await expect(
        insertOrderLine(conn, refs, orderId, { ordered: 10, sold: 6, delivered: 7 }),
      ).rejects.toThrow(/ck_sales_sales_order_lines_quantities/);
      const lineId = await insertOrderLine(conn, refs, orderId, {
        ordered: 10,
        sold: 6,
        delivered: 4,
      });
      // En attente = 10 − 6 ; à livrer = 6 − 4 : une livraison de plus reste dans les bornes.
      await conn.query(
        `UPDATE sales_sales_order_lines SET delivered_quantity_base = 6 WHERE id = ?`,
        [lineId],
      );
      await expect(
        conn.query(`UPDATE sales_sales_order_lines SET delivered_quantity_base = 3 WHERE id = ?`, [
          lineId,
        ]),
      ).rejects.toThrow(/la quantité livrée ne diminue jamais/);
      await expect(
        conn.query(`UPDATE sales_sales_order_lines SET delivered_quantity_base = 8 WHERE id = ?`, [
          lineId,
        ]),
      ).rejects.toThrow(/ck_sales_sales_order_lines_quantities/);
      // Le prix convenu est figé.
      await expect(
        conn.query(`UPDATE sales_sales_order_lines SET quoted_unit_price_xaf = 1 WHERE id = ?`, [
          lineId,
        ]),
      ).rejects.toThrow(/immuables/);
      // Une baisse retire d'abord l'attente (commandé 10 → 6) : permis jusqu'au vendu.
      await conn.query(
        `UPDATE sales_sales_order_lines SET quantity_base = 6, quantity = 6, withdrawn_quantity_base = 4 WHERE id = ?`,
        [lineId],
      );
      await expect(
        conn.query(`UPDATE sales_sales_order_lines SET quantity_base = 5 WHERE id = ?`, [lineId]),
      ).rejects.toThrow(/ck_sales_sales_order_lines_quantities/);
      await expect(
        conn.query(`DELETE FROM sales_sales_order_lines WHERE id = ?`, [lineId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });

  it("garde l'identité de la commande, la cohérence des statuts et la clôture du reliquat", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const orderId = await insertOrder(conn, refs);
      // Le lieu de préparation peut changer (BR-VEN-005), pas le client ni le commercial.
      await conn.query(`UPDATE sales_sales_orders SET fulfilment_location_id = ? WHERE id = ?`, [
        refs.storeId,
        orderId,
      ]);
      await expect(
        conn.query(`UPDATE sales_sales_orders SET commercial_user_id = ? WHERE id = ?`, [
          randomId(),
          orderId,
        ]),
      ).rejects.toThrow();
      await expect(
        conn.query(`UPDATE sales_sales_orders SET channel_code = 'AUTRE' WHERE id = ?`, [orderId]),
      ).rejects.toThrow();
      // CLOSED exige closed_at/closed_by ; CANCELLED exige les colonnes d'annulation.
      await expect(
        conn.query(`UPDATE sales_sales_orders SET status = 'CLOSED' WHERE id = ?`, [orderId]),
      ).rejects.toThrow(/ck_sales_sales_orders_closed/);
      await expect(
        conn.query(`UPDATE sales_sales_orders SET status = 'CANCELLED' WHERE id = ?`, [orderId]),
      ).rejects.toThrow(/ck_sales_sales_orders_cancel/);
      await conn.query(
        `UPDATE sales_sales_orders SET status = 'CLOSED', closed_at = ?, closed_by = ?, closed_reason = 'Reste annulé' WHERE id = ?`,
        [T1, refs.admin, orderId],
      );
      // Statut terminal : plus de retour en arrière.
      await expect(
        conn.query(
          `UPDATE sales_sales_orders SET status = 'CONFIRMED', closed_at = NULL, closed_by = NULL WHERE id = ?`,
          [orderId],
        ),
      ).rejects.toThrow(/commande terminée/);
      await expect(
        conn.query(`DELETE FROM sales_sales_orders WHERE id = ?`, [orderId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('sales_sales : vente immuable, annulée par document (INV-VEN-02/06/07)', () => {
  it('dérive le net, le solde et le statut de paiement (colonnes générées)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await insertSale(conn, refs, { total: 10_000 });
      const read = async () => {
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT net_total_xaf, balance_due_xaf, payment_status FROM sales_sales WHERE id = ?`,
          [sale],
        );
        return rows[0]!;
      };
      expect(await read()).toMatchObject({
        net_total_xaf: 10_000,
        balance_due_xaf: 10_000,
        payment_status: 'UNPAID',
      });
      await conn.query(`UPDATE sales_sales SET amount_paid_xaf = 4000 WHERE id = ?`, [sale]);
      expect(await read()).toMatchObject({
        balance_due_xaf: 6000,
        payment_status: 'PARTIALLY_PAID',
      });
      // Annulation partielle : le payé en excès doit être libéré dans le même ordre (INV-VEN-06).
      await expect(
        conn.query(`UPDATE sales_sales SET cancelled_xaf = 7000 WHERE id = ?`, [sale]),
      ).rejects.toThrow(/ck_sales_sales_paid/);
      await conn.query(
        `UPDATE sales_sales SET cancelled_xaf = 7000, amount_paid_xaf = 3000 WHERE id = ?`,
        [sale],
      );
      expect(await read()).toMatchObject({
        net_total_xaf: 3000,
        balance_due_xaf: 0,
        payment_status: 'PAID',
      });
      await expect(
        conn.query(`UPDATE sales_sales SET amount_paid_xaf = 3001 WHERE id = ?`, [sale]),
      ).rejects.toThrow(/ck_sales_sales_paid/);
    });
  });

  it('interdit de modifier une vente (total, attribution) et de diminuer ou dépasser le montant annulé', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await insertSale(conn, refs, { total: 10_000 });
      await expect(
        conn.query(`UPDATE sales_sales SET total_xaf = 9000, subtotal_xaf = 9000 WHERE id = ?`, [
          sale,
        ]),
      ).rejects.toThrow(/vente immuable/);
      await expect(
        conn.query(`UPDATE sales_sales SET seller_user_id = ? WHERE id = ?`, [randomId(), sale]),
      ).rejects.toThrow(/vente immuable/);
      await conn.query(`UPDATE sales_sales SET cancelled_xaf = 2500 WHERE id = ?`, [sale]);
      await expect(
        conn.query(`UPDATE sales_sales SET cancelled_xaf = 1000 WHERE id = ?`, [sale]),
      ).rejects.toThrow(/ne diminue jamais/);
      await expect(
        conn.query(`UPDATE sales_sales SET cancelled_xaf = 10001 WHERE id = ?`, [sale]),
      ).rejects.toThrow(/ck_sales_sales_cancelled/);
      // CANCELLED exige que tout le montant soit annulé ; puis la vente ne revient pas en arrière.
      await expect(
        conn.query(`UPDATE sales_sales SET status = 'CANCELLED' WHERE id = ?`, [sale]),
      ).rejects.toThrow(/ck_sales_sales_cancelled_status/);
      await conn.query(
        `UPDATE sales_sales SET cancelled_xaf = 10000, status = 'CANCELLED' WHERE id = ?`,
        [sale],
      );
      await expect(
        conn.query(`UPDATE sales_sales SET status = 'CONFIRMED' WHERE id = ?`, [sale]),
      ).rejects.toThrow(/ne revient pas à CONFIRMED/);
      await expect(conn.query(`DELETE FROM sales_sales WHERE id = ?`, [sale])).rejects.toThrow(
        /suppression physique interdite/,
      );
    });
  });

  it('lie une vente sur commande à sa commande et à « à livrer », et accepte une vente anonyme hors ligne', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(insertSale(conn, refs, { type: 'ORDER' })).rejects.toThrow(
        /ck_sales_sales_order_link/,
      );
      const orderId = await insertOrder(conn, refs);
      const orderSale = await insertSale(conn, refs, { type: 'ORDER', orderId });
      expect(orderSale).toBeTruthy();
      // Une vente directe ne porte pas de commande.
      await expect(insertSale(conn, refs, { type: 'DIRECT', orderId })).rejects.toThrow(
        /ck_sales_sales_order_link/,
      );
      // INV-VEN-07 se vérifie à l'enregistrement en ligne (TX) : la base accepte une vente anonyme
      // avec un reste dû, fait accompli saisi hors ligne (BR-SYN-007).
      await insertSale(conn, refs, { customer: null, total: 5000, paid: 2000 });
      await insertSale(conn, refs, { customer: null, total: 5000, paid: 5000 });
      // Une vente sur commande exige un client (BR-VEN-001).
      await expect(
        insertSale(conn, refs, { type: 'ORDER', orderId, customer: null }),
      ).rejects.toThrow(/ck_sales_sales_order_customer/);
    });
  });
});

describe('sales_sale_lines (INV-VEN-03) et compteurs', () => {
  it('impose montant = arrondi(quantité de tarification × prix) − remise, demi supérieur', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await insertSale(conn, refs, { total: 2503 });
      // 2,5 × 1 001 = 2 502,5 → 2 503 (demi supérieur).
      await expect(
        insertSaleLine(conn, refs, sale, {
          quantity: 3,
          pricingQuantity: 2.5,
          unitPrice: 1001,
          lineTotal: 2502,
        }),
      ).rejects.toThrow(/ck_sales_sale_lines_total/);
      await insertSaleLine(conn, refs, sale, {
        quantity: 3,
        pricingQuantity: 2.5,
        unitPrice: 1001,
        lineTotal: 2503,
      });
      // Avec remise de 503 : 2 503 − 503 = 2 000.
      await insertSaleLine(conn, refs, sale, {
        lineNo: 2,
        quantity: 3,
        pricingQuantity: 2.5,
        unitPrice: 1001,
        discount: 503,
        lineTotal: 2000,
      });
    });
  });

  it('exige un motif pour une dérogation, et une dernière annulation qui emporte le montant exact', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await insertSale(conn, refs, { total: 10_000 });
      await expect(
        insertSaleLine(conn, refs, sale, { priceSource: 'MANUAL_OVERRIDE', reasonId: null }),
      ).rejects.toThrow(/ck_sales_sale_lines_override/);
      const line = await insertSaleLine(conn, refs, sale);
      // Annulation de 4 sur 10 (4 000 au prorata), puis des 6 restants : le montant restant exact.
      await conn.query(
        `UPDATE sales_sale_lines SET cancelled_quantity_base = 4, cancelled_xaf = 4000 WHERE id = ?`,
        [line],
      );
      await expect(
        conn.query(
          `UPDATE sales_sale_lines SET cancelled_quantity_base = 10, cancelled_xaf = 9000 WHERE id = ?`,
          [line],
        ),
      ).rejects.toThrow(/ck_sales_sale_lines_cancelled/);
      await conn.query(
        `UPDATE sales_sale_lines SET cancelled_quantity_base = 10, cancelled_xaf = 10000 WHERE id = ?`,
        [line],
      );
      await expect(
        conn.query(
          `UPDATE sales_sale_lines SET cancelled_quantity_base = 5, cancelled_xaf = 5000 WHERE id = ?`,
          [line],
        ),
      ).rejects.toThrow(/ne diminuent jamais/);
      await expect(
        conn.query(`UPDATE sales_sale_lines SET unit_price_xaf = 1 WHERE id = ?`, [line]),
      ).rejects.toThrow(/ligne de vente immuable/);
    });
  });

  it('plafonne le livré au vendu net et fige le coût une fois renseigné', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const orderId = await insertOrder(conn, refs);
      const sale = await insertSale(conn, refs, { type: 'ORDER', orderId });
      const line = await insertSaleLine(conn, refs, sale);
      await conn.query(`UPDATE sales_sale_lines SET delivered_quantity_base = 6 WHERE id = ?`, [
        line,
      ]);
      // Annuler 5 alors que 6 sont livrés dépasserait le vendu net (10 − 5 = 5 < 6).
      await expect(
        conn.query(
          `UPDATE sales_sale_lines SET cancelled_quantity_base = 5, cancelled_xaf = 5000 WHERE id = ?`,
          [line],
        ),
      ).rejects.toThrow(/ck_sales_sale_lines_delivered/);
      await conn.query(
        `UPDATE sales_sale_lines SET unit_cost_xaf = 700, cost_xaf = 7001 WHERE id = ?`,
        [line],
      );
      await expect(
        conn.query(`UPDATE sales_sale_lines SET cost_xaf = 7002 WHERE id = ?`, [line]),
      ).rejects.toThrow(/le coût figé de la ligne ne change plus/);
    });
  });
});

describe('sales_sale_cancellations : contre-écriture (ADR-028 §5)', () => {
  async function insertCancellation(
    conn: PoolConnection,
    refs: Refs,
    saleId: Buffer,
    status: string,
    appliedAt: string | null,
  ): Promise<Buffer> {
    const id = randomId();
    await conn.query(
      `INSERT INTO sales_sale_cancellations (id, doc_number, site_id, sale_id, cause, status, requested_by,
         cancelled_total_xaf, applied_at, occurred_at, created_by)
       VALUES (?, ?, ?, ?, 'SALE_CANCELLATION', ?, ?, 4000, ?, ?, ?)`,
      [id, randomCode('ANV-'), refs.siteId, saleId, status, refs.admin, appliedAt, T1, refs.admin],
    );
    return id;
  }

  it("une annulation n'est effective que si elle est APPLIED ; sa demande ne change de statut qu'une fois", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await insertSale(conn, refs);
      await expect(insertCancellation(conn, refs, sale, 'APPLIED', null)).rejects.toThrow(
        /ck_sales_sale_cancellations_applied/,
      );
      await expect(insertCancellation(conn, refs, sale, 'REQUESTED', T1)).rejects.toThrow(
        /ck_sales_sale_cancellations_applied/,
      );
      const cancellation = await insertCancellation(conn, refs, sale, 'REQUESTED', null);
      // Plusieurs documents par vente : command_id et sale_id ne sont pas uniques.
      await insertCancellation(conn, refs, sale, 'REQUESTED', null);
      await conn.query(
        `UPDATE sales_sale_cancellations SET status = 'APPLIED', applied_at = ? WHERE id = ?`,
        [T1, cancellation],
      );
      await expect(
        conn.query(
          `UPDATE sales_sale_cancellations SET status = 'REJECTED', applied_at = NULL WHERE id = ?`,
          [cancellation],
        ),
      ).rejects.toThrow(/ne change plus de statut/);
      await expect(
        conn.query(`UPDATE sales_sale_cancellations SET cancelled_total_xaf = 1 WHERE id = ?`, [
          cancellation,
        ]),
      ).rejects.toThrow(/document d'annulation immuable/);
    });
  });

  it('ses lignes sont en ajout seul, une par ligne de vente', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await insertSale(conn, refs);
      const line = await insertSaleLine(conn, refs, sale);
      const cancellation = await insertCancellation(conn, refs, sale, 'REQUESTED', null);
      const id = randomId();
      await conn.query(
        `INSERT INTO sales_sale_cancellation_lines (id, cancellation_id, sale_line_id, quantity_base, amount_xaf)
         VALUES (?, ?, ?, 4, 4000)`,
        [id, cancellation, line],
      );
      await expect(
        conn.query(
          `INSERT INTO sales_sale_cancellation_lines (id, cancellation_id, sale_line_id, quantity_base, amount_xaf)
           VALUES (?, ?, ?, 1, 1000)`,
          [randomId(), cancellation, line],
        ),
      ).rejects.toThrow(/uq_sales_sale_cancellation_lines_line/);
      await expect(
        conn.query(`UPDATE sales_sale_cancellation_lines SET quantity_base = 5 WHERE id = ?`, [id]),
      ).rejects.toThrow(/immuable/);
      await expect(
        conn.query(`DELETE FROM sales_sale_cancellation_lines WHERE id = ?`, [id]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('sales_delivery_notes : ajout seul (ADR-028 §7)', () => {
  it("refuse toute modification et toute suppression d'un bon de livraison et de ses lignes", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const orderId = await insertOrder(conn, refs);
      const orderLine = await insertOrderLine(conn, refs, orderId, { ordered: 10, sold: 10 });
      const sale = await insertSale(conn, refs, { type: 'ORDER', orderId });
      const saleLine = await insertSaleLine(conn, refs, sale, { orderLineId: orderLine });
      const note = randomId();
      await conn.query(
        `INSERT INTO sales_delivery_notes (id, doc_number, site_id, order_id, delivered_by_user_id, recipient_name,
           occurred_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'Client', ?, ?)`,
        [note, randomCode('LIV-'), refs.siteId, orderId, refs.admin, T1, refs.admin],
      );
      const noteLine = randomId();
      await conn.query(
        `INSERT INTO sales_delivery_note_lines (id, delivery_note_id, order_line_id, sale_line_id, quantity_base)
         VALUES (?, ?, ?, ?, 4)`,
        [noteLine, note, orderLine, saleLine],
      );
      await expect(
        conn.query(
          `INSERT INTO sales_delivery_note_lines (id, delivery_note_id, order_line_id, sale_line_id, quantity_base)
           VALUES (?, ?, ?, ?, 0)`,
          [randomId(), note, orderLine, saleLine],
        ),
      ).rejects.toThrow();
      await expect(
        conn.query(`UPDATE sales_delivery_notes SET recipient_name = 'Autre' WHERE id = ?`, [note]),
      ).rejects.toThrow(/bon de livraison immuable/);
      await expect(
        conn.query(`UPDATE sales_delivery_note_lines SET quantity_base = 9 WHERE id = ?`, [
          noteLine,
        ]),
      ).rejects.toThrow(/ligne de livraison immuable/);
      await expect(
        conn.query(`DELETE FROM sales_delivery_notes WHERE id = ?`, [note]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('sales_customer_payments et sales_payment_allocations (INV-FIN-03/04, AV-056)', () => {
  async function insertMovement(conn: PoolConnection, refs: Refs): Promise<Buffer> {
    const id = randomId();
    await conn.query(
      `INSERT INTO finance_cash_movements (id, cash_account_id, direction, amount_xaf, movement_type, source_doc_type,
         source_doc_id, occurred_at, created_by)
       VALUES (?, ?, 'IN', 5000, 'CUSTOMER_PAYMENT', 'CUSTOMER_PAYMENT', ?, ?, ?)`,
      [id, refs.accountId, randomId(), T1, refs.admin],
    );
    return id;
  }

  async function insertPayment(
    conn: PoolConnection,
    refs: Refs,
    input: {
      readonly reference?: string | null;
      readonly status?: string;
      readonly withMovement?: boolean;
      readonly normalized?: string | null;
      readonly movementId?: Buffer;
    },
  ): Promise<Buffer> {
    const id = randomId();
    const status = input.status ?? 'RECORDED';
    const movement = input.withMovement ?? ['RECORDED', 'CANCELLATION_REQUESTED'].includes(status);
    const reference = input.reference === undefined ? null : input.reference;
    await conn.query(
      `INSERT INTO sales_customer_payments (id, doc_number, site_id, customer_id, payment_method_code, amount_xaf,
         external_reference, reference_normalized, received_by_user_id, cash_account_id, cash_movement_id, status,
         unallocated_xaf, occurred_at, created_by)
       VALUES (?, ?, ?, ?, ?, 5000, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        randomCode('ENC-'),
        refs.siteId,
        refs.customerId,
        refs.methodCode,
        reference,
        input.normalized !== undefined
          ? input.normalized
          : reference === null
            ? null
            : reference.replace(/\s+/g, '').toUpperCase(),
        refs.admin,
        refs.accountId,
        input.movementId ?? (movement ? await insertMovement(conn, refs) : null),
        status,
        // Le crédit client n'existe que sur un encaissement enregistré (INV-FIN-09).
        ['RECORDED', 'CANCELLATION_REQUESTED'].includes(status) ? 5000 : 0,
        T1,
        refs.admin,
      ],
    );
    return id;
  }

  it('rend la référence normalisée unique par moyen parmi les encaissements enregistrés', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const first = await insertPayment(conn, refs, { reference: 'mp 2309.123' });
      // « MP2309.123 » est la même transaction (espaces retirés, majuscules).
      await expect(insertPayment(conn, refs, { reference: 'MP2309.123' })).rejects.toThrow(
        /uq_sales_customer_payments_reference/,
      );
      // Le doublon suspect est consigné sans trésorerie et ne compte pas dans l'unicité.
      await insertPayment(conn, refs, { reference: 'MP2309.123', status: 'SUSPECT_DUPLICATE' });
      // Un encaissement annulé libère sa référence.
      await conn.query(
        `UPDATE sales_customer_payments SET status = 'CANCELLED', unallocated_xaf = 0, cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
        [T1, refs.admin, first],
      );
      await insertPayment(conn, refs, { reference: 'MP2309.123' });
    });
  });

  it("n'a de mouvement de trésorerie que s'il est enregistré, et ses colonnes restent figées", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(
        insertPayment(conn, refs, { status: 'RECORDED', withMovement: false }),
      ).rejects.toThrow(/ck_sales_customer_payments_movement/);
      await expect(
        insertPayment(conn, refs, {
          reference: 'X1',
          status: 'SUSPECT_DUPLICATE',
          withMovement: true,
        }),
      ).rejects.toThrow(/ck_sales_customer_payments_movement/);
      const payment = await insertPayment(conn, refs, { reference: 'X2' });
      await expect(
        conn.query(`UPDATE sales_customer_payments SET amount_xaf = 1 WHERE id = ?`, [payment]),
      ).rejects.toThrow(/encaissement immuable/);
      await expect(
        conn.query(`UPDATE sales_customer_payments SET unallocated_xaf = 5001 WHERE id = ?`, [
          payment,
        ]),
      ).rejects.toThrow(/ck_sales_customer_payments_unallocated/);
      await conn.query(`UPDATE sales_customer_payments SET unallocated_xaf = 1000 WHERE id = ?`, [
        payment,
      ]);
      await conn.query(
        `UPDATE sales_customer_payments SET status = 'CANCELLED', unallocated_xaf = 0, cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
        [T1, refs.admin, payment],
      );
      await expect(
        conn.query(
          `UPDATE sales_customer_payments SET status = 'RECORDED', cancelled_at = NULL, cancelled_by = NULL WHERE id = ?`,
          [payment],
        ),
      ).rejects.toThrow(/ne change plus/);
      await expect(
        conn.query(`DELETE FROM sales_customer_payments WHERE id = ?`, [payment]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });

  it("affecte à une vente ou à une commande (jamais les deux) et ne se renverse qu'une fois", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const payment = await insertPayment(conn, refs, { reference: 'ALLOC1' });
      const sale = await insertSale(conn, refs);
      const orderId = await insertOrder(conn, refs);
      const insertAllocation = (saleId: Buffer | null, order: Buffer | null) =>
        conn.query(
          `INSERT INTO sales_payment_allocations (id, payment_id, sale_id, order_id, amount_xaf, allocated_at, created_by)
           VALUES (?, ?, ?, ?, 2000, ?, ?)`,
          [randomId(), payment, saleId, order, T1, refs.admin],
        );
      await expect(insertAllocation(sale, orderId)).rejects.toThrow(
        /ck_sales_payment_allocations_target/,
      );
      await expect(insertAllocation(null, null)).rejects.toThrow(
        /ck_sales_payment_allocations_target/,
      );
      const id = randomId();
      await conn.query(
        `INSERT INTO sales_payment_allocations (id, payment_id, sale_id, amount_xaf, allocated_at, created_by)
         VALUES (?, ?, ?, 2000, ?, ?)`,
        [id, payment, sale, T1, refs.admin],
      );
      await insertAllocation(null, orderId);
      await expect(
        conn.query(`UPDATE sales_payment_allocations SET amount_xaf = 1 WHERE id = ?`, [id]),
      ).rejects.toThrow(/affectation immuable/);
      await expect(
        conn.query(`UPDATE sales_payment_allocations SET status = 'REVERSED' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_sales_payment_allocations_reversal/);
      await conn.query(
        `UPDATE sales_payment_allocations SET status = 'REVERSED', reversed_at = ?, reversal_cause = 'SALE_CANCELLED' WHERE id = ?`,
        [T1, id],
      );
      await expect(
        conn.query(
          `UPDATE sales_payment_allocations SET reversal_cause = 'REALLOCATED' WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/déjà renversée/);
      await expect(
        conn.query(`DELETE FROM sales_payment_allocations WHERE id = ?`, [id]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });

  it('permet à la Finance de corriger la référence en décidant un doublon suspect (AV-135)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await insertPayment(conn, refs, { reference: 'MP2309.123' });
      const suspect = await insertPayment(conn, refs, {
        reference: 'MP2309.123',
        status: 'SUSPECT_DUPLICATE',
      });
      // Hors décision, la référence est figée.
      await expect(
        conn.query(
          `UPDATE sales_customer_payments SET external_reference = 'X', reference_normalized = 'X' WHERE id = ?`,
          [suspect],
        ),
      ).rejects.toThrow(/référence figée/);
      // Promouvoir sans correction viole l'unicité de la référence.
      await expect(
        conn.query(
          `UPDATE sales_customer_payments SET status = 'RECORDED', cash_movement_id = ?, unallocated_xaf = 5000 WHERE id = ?`,
          [await insertMovement(conn, refs), suspect],
        ),
      ).rejects.toThrow(/uq_sales_customer_payments_reference/);
      // Avec la référence corrigée, la décision aboutit ; le montant reste figé.
      await expect(
        conn.query(`UPDATE sales_customer_payments SET amount_xaf = 1 WHERE id = ?`, [suspect]),
      ).rejects.toThrow(/encaissement immuable/);
      await conn.query(
        `UPDATE sales_customer_payments SET status = 'RECORDED', external_reference = 'MP2309.124',
           reference_normalized = 'MP2309.124', cash_movement_id = ?, unallocated_xaf = 5000 WHERE id = ?`,
        [await insertMovement(conn, refs), suspect],
      );
    });
  });

  it('garde un mouvement de trésorerie par encaissement et un format de référence normalisé', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const first = await insertPayment(conn, refs, { reference: 'UN1' });
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT cash_movement_id FROM sales_customer_payments WHERE id = ?`,
        [first],
      );
      // INV-FIN-09 : relation 1 pour 1 entre l'encaissement et son mouvement.
      await expect(
        insertPayment(conn, refs, {
          reference: 'DEUX2',
          movementId: rows[0]!.cash_movement_id as Buffer,
        }),
      ).rejects.toThrow(/uq_sales_customer_payments_movement/);
      // Référence non normalisée (minuscules, espaces) ou saisie sans forme normalisée.
      await expect(
        insertPayment(conn, refs, { reference: 'mp 1', normalized: 'mp1' }),
      ).rejects.toThrow(/ck_sales_customer_payments_reference/);
      await expect(
        insertPayment(conn, refs, { reference: 'MP 1', normalized: 'MP 1' }),
      ).rejects.toThrow(/ck_sales_customer_payments_reference/);
      await expect(
        insertPayment(conn, refs, { reference: 'MP1', normalized: null }),
      ).rejects.toThrow(/ck_sales_customer_payments_reference_pair/);
    });
  });

  it("borne le crédit, le remboursé et la demande d'annulation d'un encaissement", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const payment = await insertPayment(conn, refs, { reference: 'CR1' });
      // Le crédit n'existe que sur un encaissement enregistré : annuler exige de le solder.
      await expect(
        conn.query(
          `UPDATE sales_customer_payments SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
          [T1, refs.admin, payment],
        ),
      ).rejects.toThrow(/ck_sales_customer_payments_credit/);
      // Non affecté + remboursé ≤ montant ; le remboursé ne diminue jamais.
      await expect(
        conn.query(`UPDATE sales_customer_payments SET refunded_xaf = 1000 WHERE id = ?`, [
          payment,
        ]),
      ).rejects.toThrow(/ck_sales_customer_payments_unallocated/);
      await conn.query(
        `UPDATE sales_customer_payments SET unallocated_xaf = 4000, refunded_xaf = 1000 WHERE id = ?`,
        [payment],
      );
      await expect(
        conn.query(`UPDATE sales_customer_payments SET refunded_xaf = 500 WHERE id = ?`, [payment]),
      ).rejects.toThrow(/la part remboursée ne diminue jamais/);
      // Le motif d'une demande d'annulation se consigne dès CANCELLATION_REQUESTED, pas avant.
      await expect(
        conn.query(`UPDATE sales_customer_payments SET cancel_reason_code_id = ? WHERE id = ?`, [
          refs.reasonId,
          payment,
        ]),
      ).rejects.toThrow(/ck_sales_customer_payments_cancel_request/);
      await conn.query(
        `UPDATE sales_customer_payments SET status = 'CANCELLATION_REQUESTED', cancel_reason_code_id = ? WHERE id = ?`,
        [refs.reasonId, payment],
      );
      // Encaissement terminé : montants et annulation figés.
      await conn.query(
        `UPDATE sales_customer_payments SET status = 'CANCELLED', unallocated_xaf = 0, cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
        [T1, refs.admin, payment],
      );
      await expect(
        conn.query(`UPDATE sales_customer_payments SET cancelled_by = ? WHERE id = ?`, [
          randomId(),
          payment,
        ]),
      ).rejects.toThrow(/encaissement terminé/);
    });
  });

  it("ne cible qu'une vente ou une commande visée, et n'affecte qu'un encaissement enregistré à une cible non annulée", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await insertSale(conn, refs);
      const orderId = await insertOrder(conn, refs);
      await expect(
        conn.query(`UPDATE sales_customer_payments SET intended_sale_id = ? WHERE id = ?`, [
          sale,
          await insertPayment(conn, refs, { reference: 'IT1' }),
        ]),
      ).rejects.toThrow(/encaissement immuable/);
      // Un suspect ne s'affecte pas (INV-FIN-09).
      const suspect = await insertPayment(conn, refs, {
        reference: 'SU1',
        status: 'SUSPECT_DUPLICATE',
      });
      const allocate = (paymentId: Buffer, saleId: Buffer | null, order: Buffer | null) =>
        conn.query(
          `INSERT INTO sales_payment_allocations (id, payment_id, sale_id, order_id, amount_xaf, allocated_at, created_by)
           VALUES (?, ?, ?, ?, 1000, ?, ?)`,
          [randomId(), paymentId, saleId, order, T1, refs.admin],
        );
      await expect(allocate(suspect, sale, null)).rejects.toThrow(
        /seul un encaissement enregistré/,
      );
      // Une vente annulée ne reçoit plus d'affectation (INV-FIN-10).
      const cancelled = await insertSale(conn, refs, {
        total: 1000,
        cancelled: 1000,
        status: 'CANCELLED',
      });
      const recorded = await insertPayment(conn, refs, { reference: 'RE1' });
      await expect(allocate(recorded, cancelled, null)).rejects.toThrow(
        /pas d'affectation à une vente ou une commande annulée/,
      );
      await allocate(recorded, sale, null);
      await allocate(recorded, null, orderId);
    });
  });
});

describe('durcissement des commandes, ventes, annulations et livraisons (relecture P4-02)', () => {
  async function insertCancellation(
    conn: PoolConnection,
    refs: Refs,
    saleId: Buffer,
    overrides: {
      readonly cause?: string;
      readonly orderId?: Buffer | null;
      readonly commandId?: Buffer | null;
      readonly status?: string;
      readonly appliedAt?: string | null;
    } = {},
  ): Promise<Buffer> {
    const id = randomId();
    const status = overrides.status ?? 'REQUESTED';
    await conn.query(
      `INSERT INTO sales_sale_cancellations (id, doc_number, site_id, sale_id, order_id, cause, status, requested_by,
         cancelled_total_xaf, applied_at, occurred_at, command_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 4000, ?, ?, ?, ?)`,
      [
        id,
        randomCode('ANV-'),
        refs.siteId,
        saleId,
        overrides.orderId ?? null,
        overrides.cause ?? 'SALE_CANCELLATION',
        status,
        refs.admin,
        overrides.appliedAt === undefined
          ? status === 'APPLIED'
            ? T1
            : null
          : overrides.appliedAt,
        T1,
        overrides.commandId ?? null,
        refs.admin,
      ],
    );
    return id;
  }

  it('permet d’annuler un brouillon, interdit de repasser en brouillon et fige la clôture terminée', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const draft = randomId();
      await conn.query(
        `INSERT INTO sales_sales_orders (id, doc_number, site_id, customer_id, commercial_user_id, channel_code,
           fulfilment_location_id, status, occurred_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
        [
          draft,
          randomCode('CMD-'),
          refs.siteId,
          refs.customerId,
          refs.admin,
          refs.channel,
          refs.storeId,
          T0,
          refs.admin,
        ],
      );
      await conn.query(
        `UPDATE sales_sales_orders SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
        [T1, refs.admin, draft],
      );
      const confirmed = await insertOrder(conn, refs);
      await expect(
        conn.query(`UPDATE sales_sales_orders SET status = 'DRAFT' WHERE id = ?`, [confirmed]),
      ).rejects.toThrow(/ne redevient pas brouillon/);
      await conn.query(
        `UPDATE sales_sales_orders SET status = 'CLOSED', closed_at = ?, closed_by = ?, closed_reason = 'Reste annulé' WHERE id = ?`,
        [T1, refs.admin, confirmed],
      );
      await expect(
        conn.query(`UPDATE sales_sales_orders SET closed_reason = 'Autre' WHERE id = ?`, [
          confirmed,
        ]),
      ).rejects.toThrow(/figées une fois la commande terminée/);
      // Le sort de l'acompte libéré s'écrit une seule fois, même après la clôture.
      await conn.query(
        `UPDATE sales_sales_orders SET released_payment_treatment = 'REFUND' WHERE id = ?`,
        [confirmed],
      );
      await expect(
        conn.query(
          `UPDATE sales_sales_orders SET released_payment_treatment = 'CUSTOMER_CREDIT' WHERE id = ?`,
          [confirmed],
        ),
      ).rejects.toThrow(/s'écrit une seule fois/);
    });
  });

  it('exige un motif pour une dérogation de ligne de commande et une source cohérente sur la ligne de vente', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const orderId = await insertOrder(conn, refs);
      const insertLine = (source: string, reason: Buffer | null) =>
        conn.query(
          `INSERT INTO sales_sales_order_lines (id, order_id, line_no, product_id, product_name_snapshot, quantity,
             unit_code, quantity_base, quoted_unit_price_xaf, price_source, override_reason_code_id, line_total_xaf)
           VALUES (?, ?, ?, ?, 'Produit', 10, ?, 10, 900, ?, ?, 9000)`,
          [
            randomId(),
            orderId,
            Math.floor(Math.random() * 30000),
            refs.productId,
            refs.unitCode,
            source,
            reason,
          ],
        );
      await expect(insertLine('MANUAL_OVERRIDE', null)).rejects.toThrow(
        /ck_sales_sales_order_lines_override/,
      );
      await insertLine('MANUAL_OVERRIDE', refs.reasonId);
      // Ligne de vente : la source `RULE` porte sa règle, sa version et le prix catalogue.
      const sale = await insertSale(conn, refs);
      await expect(insertSaleLine(conn, refs, sale, { priceSource: 'RULE' })).rejects.toThrow(
        /ck_sales_sale_lines_rule/,
      );
      await expect(
        insertSaleLine(conn, refs, sale, { priceSource: 'ORDER_QUOTE' }),
      ).rejects.toThrow(/ck_sales_sale_lines_quote/);
      const line = await insertSaleLine(conn, refs, sale);
      // Un montant annulé exige une quantité annulée.
      await expect(
        conn.query(`UPDATE sales_sale_lines SET cancelled_xaf = 100 WHERE id = ?`, [line]),
      ).rejects.toThrow(/ck_sales_sale_lines_cancelled_amount/);
    });
  });

  it("garde l'emplacement « à livrer » du site de la préparation sur une vente sur commande", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const orderId = await insertOrder(conn, refs);
      // Un « à livrer » d'un autre site.
      const siteB = randomId();
      await conn.query(
        `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by) VALUES (?, ?, 'Autre', 'MAGASIN', ?, ?)`,
        [siteB, randomCode('S'), refs.zoneId, refs.admin],
      );
      const otherToDeliver = randomId();
      await conn.query(
        `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'À livrer', 'V_TO_DELIVER', ?)`,
        [otherToDeliver, siteB, randomCode('TD'), refs.admin],
      );
      const insertOrderSale = (toDeliver: Buffer) =>
        conn.query(
          `INSERT INTO sales_sales (id, doc_number, site_id, sale_type, order_id, customer_id, channel_code, from_location_id,
             to_deliver_location_id, zone_id, seller_user_id, subtotal_xaf, total_xaf, occurred_at, created_by)
           VALUES (?, ?, ?, 'ORDER', ?, ?, ?, ?, ?, ?, ?, 1000, 1000, ?, ?)`,
          [
            randomId(),
            randomCode('VTE-'),
            refs.siteId,
            orderId,
            refs.customerId,
            refs.channel,
            refs.storeId,
            toDeliver,
            refs.zoneId,
            refs.admin,
            T0,
            refs.admin,
          ],
        );
      await expect(insertOrderSale(otherToDeliver)).rejects.toThrow(/doit être celui du site/);
      // Un emplacement qui n'est pas « à livrer » est refusé de même.
      await expect(insertOrderSale(refs.storeId)).rejects.toThrow(/doit être celui du site/);
      await insertOrderSale(refs.toDeliverId);
    });
  });

  it("un document d'annulation par vente et par commande, date d'effet figée, cause cohérente", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const saleA = await insertSale(conn, refs);
      const saleB = await insertSale(conn, refs);
      const command = randomId();
      await insertCancellation(conn, refs, saleA, { commandId: command });
      // Une commande de synchronisation : un document par vente, pas deux sur la même vente.
      await insertCancellation(conn, refs, saleB, { commandId: command });
      await expect(insertCancellation(conn, refs, saleA, { commandId: command })).rejects.toThrow(
        /uq_sales_sale_cancellations_command_sale/,
      );
      // Une cause liée à une commande porte la commande.
      await expect(
        insertCancellation(conn, refs, saleA, { cause: 'ORDER_CLOSURE' }),
      ).rejects.toThrow(/ck_sales_sale_cancellations_order_cause/);
      // Après décision : date d'effet et validation figées ; le sort du paiement s'écrit une fois.
      const applied = await insertCancellation(conn, refs, saleA, { status: 'APPLIED' });
      await expect(
        conn.query(`UPDATE sales_sale_cancellations SET applied_at = ? WHERE id = ?`, [
          T0,
          applied,
        ]),
      ).rejects.toThrow(/ne change plus de statut ni de date d'effet/);
      await conn.query(
        `UPDATE sales_sale_cancellations SET released_payment_treatment = 'REFUND' WHERE id = ?`,
        [applied],
      );
      await expect(
        conn.query(
          `UPDATE sales_sale_cancellations SET released_payment_treatment = 'CUSTOMER_CREDIT' WHERE id = ?`,
          [applied],
        ),
      ).rejects.toThrow(/s'écrit une seule fois/);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT applied_business_date AS d FROM sales_sale_cancellations WHERE id = ?`,
        [applied],
      );
      expect(String(rows[0]!.d)).toContain('2026');
    });
  });

  it("n'accepte que la ligne de vente du document d'annulation et que des lignes de bon concordantes", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const saleA = await insertSale(conn, refs);
      const saleB = await insertSale(conn, refs);
      const lineOfB = await insertSaleLine(conn, refs, saleB);
      const cancellationOfA = await insertCancellation(conn, refs, saleA);
      await expect(
        conn.query(
          `INSERT INTO sales_sale_cancellation_lines (id, cancellation_id, sale_line_id, quantity_base, amount_xaf)
           VALUES (?, ?, ?, 1, 1000)`,
          [randomId(), cancellationOfA, lineOfB],
        ),
      ).rejects.toThrow(/doit appartenir à la vente du document/);
      // Bon de livraison : la ligne de vente doit venir de la ligne de commande citée.
      const orderId = await insertOrder(conn, refs);
      const orderLine = await insertOrderLine(conn, refs, orderId, { ordered: 10, sold: 10 });
      const orderSale = await insertSale(conn, refs, { type: 'ORDER', orderId });
      const unlinkedLine = await insertSaleLine(conn, refs, orderSale);
      const note = randomId();
      await conn.query(
        `INSERT INTO sales_delivery_notes (id, doc_number, site_id, order_id, delivered_by_user_id, occurred_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [note, randomCode('LIV-'), refs.siteId, orderId, refs.admin, T1, refs.admin],
      );
      await expect(
        conn.query(
          `INSERT INTO sales_delivery_note_lines (id, delivery_note_id, order_line_id, sale_line_id, quantity_base)
           VALUES (?, ?, ?, ?, 4)`,
          [randomId(), note, orderLine, unlinkedLine],
        ),
      ).rejects.toThrow(/doivent concorder/);
    });
  });
});

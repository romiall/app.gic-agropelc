// Contraintes de base des documents d'achat (P6-02) : invariants portés par la base elle-même
// (INV-APP-01, INV-APP-02 avec excédent tracé, INV-APP-04, BR-APP-002, BR-APP-012, motif de rejet,
// immuabilité des réceptions). Chaque test crée ses propres référentiels dans une transaction
// annulée : aucune dépendance à l'ordre d'exécution ni au seed.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

const T0 = '2026-10-01 08:00:00.000000';

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

interface Refs {
  readonly admin: Buffer;
  readonly siteId: Buffer;
  readonly locationId: Buffer;
  readonly supplierId: Buffer;
  readonly productId: Buffer;
  readonly unitCode: string;
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
  const locationId = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'Réserve', 'STORE', ?)`,
    [locationId, siteId, randomCode('L'), admin],
  );
  const supplierId = randomId();
  await conn.query(
    `INSERT INTO procurement_suppliers (id, code, name, supplied_categories, created_by) VALUES (?, ?, 'Provenderie', JSON_ARRAY(), ?)`,
    [supplierId, randomCode('F'), admin],
  );
  const unitCode = randomCode('U').slice(0, 20);
  await conn.query(`INSERT INTO catalog_units (code, name, is_count) VALUES (?, 'Sac', TRUE)`, [
    unitCode,
  ]);
  const categoryId = randomId();
  await conn.query(
    `INSERT INTO catalog_product_categories (id, code, name, created_by) VALUES (?, ?, 'Aliments', ?)`,
    [categoryId, randomCode('C'), admin],
  );
  const productId = randomId();
  await conn.query(
    `INSERT INTO catalog_products (id, code, name, category_id, stock_family, base_unit_code, is_purchasable, created_by)
     VALUES (?, ?, 'Aliment démarrage', ?, 'INTRANT', ?, TRUE, ?)`,
    [productId, randomCode('P'), categoryId, unitCode, admin],
  );
  const reasonId = randomId();
  await conn.query(
    `INSERT INTO catalog_reason_codes (id, category, code, label, created_by) VALUES (?, 'REJECTION', ?, 'Sac percé', ?)`,
    [reasonId, randomCode('R'), admin],
  );
  return { admin, siteId, locationId, supplierId, productId, unitCode, reasonId };
}

async function insertOrder(
  conn: PoolConnection,
  refs: Refs,
  status: string,
): Promise<{ readonly orderId: Buffer; readonly lineId: Buffer }> {
  const orderId = randomId();
  await conn.query(
    `INSERT INTO procurement_purchase_orders (id, doc_number, site_id, supplier_id, delivery_location_id, total_xaf,
       status, sent_at, occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, 1500000, ?, ?, ?, ?)`,
    [
      orderId,
      randomCode('BC-'),
      refs.siteId,
      refs.supplierId,
      refs.locationId,
      status,
      ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(status) ? T0 : null,
      T0,
      refs.admin,
    ],
  );
  const lineId = randomId();
  await conn.query(
    `INSERT INTO procurement_purchase_order_lines (id, order_id, line_no, product_id, unit_code, ordered_qty_base,
       unit_price_xaf, line_total_xaf)
     VALUES (?, ?, 1, ?, ?, 100, 15000, 1500000)`,
    [lineId, orderId, refs.productId, refs.unitCode],
  );
  return { orderId, lineId };
}

async function insertReceipt(
  conn: PoolConnection,
  refs: Refs,
  input: { readonly status: string; readonly noteRef: string | null; readonly orderId?: Buffer },
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO procurement_goods_receipts (id, doc_number, site_id, purchase_order_id, supplier_id, location_id,
       received_by, supplier_delivery_note_ref, status, occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      randomCode('REC-'),
      refs.siteId,
      input.orderId ?? null,
      refs.supplierId,
      refs.locationId,
      refs.admin,
      input.noteRef,
      input.status,
      T0,
      refs.admin,
    ],
  );
  return id;
}

describe('procurement_goods_receipt_lines', () => {
  it('INV-APP-01 : accepté = livré − rejeté (colonne générée) ; bornes et motif de rejet', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const receiptId = await insertReceipt(conn, refs, {
        status: 'POSTED',
        noteRef: randomCode('BL'),
      });
      const insertLine = (delivered: number, rejected: number, reason: Buffer | null) =>
        conn.query(
          `INSERT INTO procurement_goods_receipt_lines (id, receipt_id, product_id, unit_code, qty_delivered_base,
             qty_rejected_base, rejection_reason_code_id, unit_cost_xaf)
           VALUES (?, ?, ?, ?, ?, ?, ?, 15000)`,
          [randomId(), receiptId, refs.productId, refs.unitCode, delivered, rejected, reason],
        );
      await insertLine(98, 3, refs.reasonId);
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT qty_accepted_base FROM procurement_goods_receipt_lines WHERE receipt_id = ?',
        [receiptId],
      );
      expect(Number(rows[0]!.qty_accepted_base)).toBe(95);
      await expect(insertLine(10, 11, refs.reasonId)).rejects.toThrow(
        /ck_procurement_goods_receipt_lines_qty/,
      );
      await expect(insertLine(0, 0, null)).rejects.toThrow(
        /ck_procurement_goods_receipt_lines_qty/,
      );
      await expect(insertLine(10, 2, null)).rejects.toThrow(
        /ck_procurement_goods_receipt_lines_rejection/,
      );
    });
  });

  it('ligne de réception immuable, sauf le lot de stock renseigné après coup', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const receiptId = await insertReceipt(conn, refs, { status: 'QUARANTINED', noteRef: null });
      const lineId = randomId();
      await conn.query(
        `INSERT INTO procurement_goods_receipt_lines (id, receipt_id, product_id, unit_code, qty_delivered_base, unit_cost_xaf)
         VALUES (?, ?, ?, ?, 10, 900)`,
        [lineId, receiptId, refs.productId, refs.unitCode],
      );
      await expect(
        conn.query(
          'UPDATE procurement_goods_receipt_lines SET qty_delivered_base = 12 WHERE id = ?',
          [lineId],
        ),
      ).rejects.toThrow(/immuable/);
      await expect(
        conn.query('DELETE FROM procurement_goods_receipt_lines WHERE id = ?', [lineId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

describe('procurement_goods_receipts', () => {
  it('BR-APP-012 : un bon de livraison fournisseur ne se comptabilise qu’une fois ; la quarantaine ne compte pas', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const noteRef = randomCode('BL');
      await insertReceipt(conn, refs, { status: 'POSTED', noteRef });
      await expect(insertReceipt(conn, refs, { status: 'POSTED', noteRef })).rejects.toThrow(
        /uq_procurement_goods_receipts_posted_note/,
      );
      // Doublon suspecté : enregistré en quarantaine, sans effet (INV-APP-03).
      const quarantined = await insertReceipt(conn, refs, { status: 'QUARANTINED', noteRef });
      // Confirmé doublon : rejeté ; la contrainte n'est jamais levée par un statut non comptabilisé.
      await conn.query(`UPDATE procurement_goods_receipts SET status = 'REJECTED' WHERE id = ?`, [
        quarantined,
      ]);
      await expect(
        conn.query(
          `UPDATE procurement_goods_receipts SET supplier_delivery_note_ref = 'X' WHERE id = ?`,
          [quarantined],
        ),
      ).rejects.toThrow(/non modifiable/);
    });
  });

  it('[STD-CANCEL] : colonnes d’annulation renseignées si et seulement si CANCELLED', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const receiptId = await insertReceipt(conn, refs, { status: 'POSTED', noteRef: null });
      await expect(
        conn.query(`UPDATE procurement_goods_receipts SET status = 'CANCELLED' WHERE id = ?`, [
          receiptId,
        ]),
      ).rejects.toThrow(/ck_procurement_goods_receipts_cancel/);
      await conn.query(
        `UPDATE procurement_goods_receipts SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ? WHERE id = ?`,
        [T0, refs.admin, receiptId],
      );
    });
  });
});

describe('procurement_purchase_orders et lignes', () => {
  it('INV-APP-04 : ligne d’un BC envoyé jamais augmentée ; réduction admise', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const draft = await insertOrder(conn, refs, 'DRAFT');
      await conn.query(
        'UPDATE procurement_purchase_order_lines SET ordered_qty_base = 120 WHERE id = ?',
        [draft.lineId],
      );
      const sent = await insertOrder(conn, refs, 'SENT');
      await expect(
        conn.query(
          'UPDATE procurement_purchase_order_lines SET ordered_qty_base = 120 WHERE id = ?',
          [sent.lineId],
        ),
      ).rejects.toThrow(/INV-APP-04/);
      await expect(
        conn.query(
          'UPDATE procurement_purchase_order_lines SET unit_price_xaf = 16000 WHERE id = ?',
          [sent.lineId],
        ),
      ).rejects.toThrow(/INV-APP-04/);
      await conn.query(
        'UPDATE procurement_purchase_order_lines SET closed_qty_base = 5 WHERE id = ?',
        [sent.lineId],
      );
    });
  });

  it('INV-APP-02 : Σ accepté ≤ commandé, sauf excédent tracé', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const { lineId } = await insertOrder(conn, refs, 'SENT');
      await conn.query(
        'UPDATE procurement_purchase_order_lines SET accepted_qty_base = 95 WHERE id = ?',
        [lineId],
      );
      await expect(
        conn.query(
          'UPDATE procurement_purchase_order_lines SET accepted_qty_base = 103 WHERE id = ?',
          [lineId],
        ),
      ).rejects.toThrow(/ck_procurement_purchase_order_lines_received/);
      await conn.query(
        'UPDATE procurement_purchase_order_lines SET accepted_qty_base = 103, excess_qty_base = 3 WHERE id = ?',
        [lineId],
      );
    });
  });

  it('BR-APP-006 : un BC approuvé ne change plus de total ; envoyé ⇒ date d’envoi', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const { orderId } = await insertOrder(conn, refs, 'APPROVED');
      await expect(
        conn.query('UPDATE procurement_purchase_orders SET total_xaf = 2000000 WHERE id = ?', [
          orderId,
        ]),
      ).rejects.toThrow(/BR-APP-006/);
      await expect(
        conn.query(`UPDATE procurement_purchase_orders SET status = 'SENT' WHERE id = ?`, [
          orderId,
        ]),
      ).rejects.toThrow(/ck_procurement_purchase_orders_sent/);
      await conn.query(
        `UPDATE procurement_purchase_orders SET status = 'SENT', sent_at = ? WHERE id = ?`,
        [T0, orderId],
      );
    });
  });
});

describe('procurement_purchase_requests', () => {
  it('BR-APP-002 : demande soumise non modifiable ; seule la quantité commandée d’une ligne évolue', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const requestId = randomId();
      await conn.query(
        `INSERT INTO procurement_purchase_requests (id, doc_number, site_id, requested_by, justification, occurred_at, created_by)
         VALUES (?, ?, ?, ?, 'Aliment pour la bande 12', ?, ?)`,
        [requestId, randomCode('DA-'), refs.siteId, refs.admin, T0, refs.admin],
      );
      const lineId = randomId();
      await conn.query(
        `INSERT INTO procurement_purchase_request_lines (id, request_id, product_id, quantity_base, unit_code, quantity)
         VALUES (?, ?, ?, 100, ?, 100)`,
        [lineId, requestId, refs.productId, refs.unitCode],
      );
      await expect(
        conn.query(
          `UPDATE procurement_purchase_requests SET justification = 'Autre' WHERE id = ?`,
          [requestId],
        ),
      ).rejects.toThrow(/BR-APP-002/);
      await conn.query(
        `UPDATE procurement_purchase_requests SET status = 'APPROVED' WHERE id = ?`,
        [requestId],
      );
      await conn.query(
        'UPDATE procurement_purchase_request_lines SET ordered_qty_base = 60 WHERE id = ?',
        [lineId],
      );
      await expect(
        conn.query(
          'UPDATE procurement_purchase_request_lines SET ordered_qty_base = 120 WHERE id = ?',
          [lineId],
        ),
      ).rejects.toThrow(/ck_procurement_purchase_request_lines_qty/);
      await expect(
        conn.query(
          'UPDATE procurement_purchase_request_lines SET quantity_base = 50 WHERE id = ?',
          [lineId],
        ),
      ).rejects.toThrow(/BR-APP-002/);
    });
  });
});

describe('approvals_control_policies', () => {
  it('catalogue des types d’opération étendu aux réceptions en quarantaine et annulées (D08 §11)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      for (const operationType of ['RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION']) {
        await conn.query(
          `INSERT INTO approvals_control_policies (id, code, version, operation_type, requires_approval,
             approver_permission, valid_from, created_by)
           VALUES (?, ?, 1, ?, TRUE, 'procurement.receipt_exception.approve', ?, ?)`,
          [randomId(), randomCode('POL_'), operationType, T0, refs.admin],
        );
      }
    });
  });
});

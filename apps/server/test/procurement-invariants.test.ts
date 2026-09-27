/**
 * P6-08 — invariants des achats vérifiés sur **toute** la base de test (02-domain-model/
 * 01-invariants.md ; plan de développement §4, P6 : « Tests d'intégration INV-APP-01 à 04,
 * INV-STK-12 »). Les tests de commande de P6-03 à P6-08 écrivent réellement (aucun retour
 * arrière) : ce balayage porte sur toutes les DA, BC, réceptions et mouvements produits par le vrai
 * pipeline, et vaut à tout moment de la suite.
 *
 * Les contraintes déclaratives (INV-APP-01 colonne générée et CHECK, INV-APP-04 déclencheur) sont
 * aussi démontrées par `db/tests/procurement-documents.test.ts` ; ici, leur respect sur les données
 * produites et les invariants que seule la transaction garantit (INV-APP-02, INV-APP-03,
 * INV-STK-12, couverture des DA, totaux).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeTestDb, db } from './helpers.js';

async function count(query: ReturnType<typeof sql<{ n: number }>>): Promise<number> {
  const result = await query.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

/** Réceptions dont le stock est entré (SM-RECEIPT) ; `CANCELLED` : entré puis inversé. */
const COUNTED = `('POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'CANCELLATION_PENDING')`;

describe('P6-08 : invariants des achats sur les données produites', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('INV-APP-01 : 0 ≤ rejeté ≤ livré, accepté = livré − rejeté, motif présent si rejet', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_goods_receipt_lines
        WHERE qty_rejected_base < 0 OR qty_rejected_base > qty_delivered_base
           OR qty_accepted_base <> qty_delivered_base - qty_rejected_base
           OR (qty_rejected_base > 0 AND rejection_reason_code_id IS NULL)`),
    ).toBe(0);
  });

  it('INV-STK-12 : Σ entrées PURCHASE_RECEIPT d’une ligne = quantité acceptée (réceptions comptabilisées)', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_goods_receipt_lines l
        JOIN procurement_goods_receipts r ON r.id = l.receipt_id
        LEFT JOIN (
          SELECT source_line_id, SUM(quantity) AS qty FROM inventory_stock_moves
          WHERE source_doc_type = 'GOODS_RECEIPT' AND move_type = 'PURCHASE_RECEIPT'
          GROUP BY source_line_id) m ON m.source_line_id = l.id
        WHERE r.status IN ${sql.raw(COUNTED)} AND COALESCE(m.qty, 0) <> l.qty_accepted_base`),
    ).toBe(0);
    // Réception annulée : chaque entrée a son inverse au même coût (BR-APP-013, BR-STK-052).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM inventory_stock_moves e
        JOIN procurement_goods_receipts r ON r.id = e.source_doc_id
        LEFT JOIN inventory_stock_moves x ON x.reverses_move_id = e.id
        WHERE e.source_doc_type = 'GOODS_RECEIPT' AND e.move_type = 'PURCHASE_RECEIPT'
          AND r.status = 'CANCELLED'
          AND (x.id IS NULL OR x.move_type <> 'SUPPLIER_RETURN' OR x.quantity <> e.quantity
               OR x.unit_cost_xaf <> e.unit_cost_xaf)`),
    ).toBe(0);
  });

  it('INV-APP-03 : une réception QUARANTINED ou REJECTED n’a aucun mouvement de stock', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM inventory_stock_moves m
        JOIN procurement_goods_receipts r ON r.id = m.source_doc_id
        WHERE m.source_doc_type = 'GOODS_RECEIPT' AND r.status IN ('QUARANTINED', 'REJECTED')`),
    ).toBe(0);
  });

  it('INV-APP-02 : accepté d’une ligne de BC = Σ réceptions comptabilisées ; tout dépassement est un excédent tracé', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_purchase_order_lines pl
        LEFT JOIN (
          SELECT l.po_line_id, SUM(l.qty_accepted_base) AS qty
          FROM procurement_goods_receipt_lines l
          JOIN procurement_goods_receipts r ON r.id = l.receipt_id
          WHERE r.status IN ${sql.raw(COUNTED)}
          GROUP BY l.po_line_id) a ON a.po_line_id = pl.id
        WHERE COALESCE(a.qty, 0) <> pl.accepted_qty_base`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_purchase_order_lines
        WHERE excess_qty_base <> GREATEST(0, accepted_qty_base + closed_qty_base - ordered_qty_base)`),
    ).toBe(0);
    // Excédent en revue (OVER_RECEIPT) : porté par au moins une ligne de réception.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_purchase_order_lines pl
        WHERE pl.excess_qty_base > 0 AND NOT EXISTS (
          SELECT 1 FROM procurement_goods_receipt_lines l
          WHERE l.po_line_id = pl.id AND l.over_receipt_qty_base > 0)`),
    ).toBe(0);
  });

  it('INV-APP-04 : une ligne de BC envoyé ne peut pas être augmentée (déclencheur)', async () => {
    const sent = await db
      .selectFrom('procurement_purchase_order_lines as l')
      .innerJoin('procurement_purchase_orders as o', 'o.id', 'l.order_id')
      .select(['l.id as id', 'l.ordered_qty_base as ordered', 'l.unit_price_xaf as price'])
      .where('o.status', 'in', ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'])
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable('procurement_purchase_order_lines')
        .set({ ordered_qty_base: String(Number(sent.ordered) + 1) })
        .where('id', '=', sent.id)
        .execute(),
    ).rejects.toThrow(/INV-APP-04|non modifiable|BR-APP-006/);
    await expect(
      db
        .updateTable('procurement_purchase_order_lines')
        .set({ unit_price_xaf: Number(sent.price) + 1 })
        .where('id', '=', sent.id)
        .execute(),
    ).rejects.toThrow(/INV-APP-04|non modifiable|BR-APP-006/);
  });

  it('BR-APP-004 : quantité commandée d’une ligne de DA = Σ lignes de BC actives qui la couvrent', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_purchase_request_lines rl
        LEFT JOIN (
          SELECT pl.request_line_id, SUM(pl.ordered_qty_base) AS qty
          FROM procurement_purchase_order_lines pl
          JOIN procurement_purchase_orders o ON o.id = pl.order_id
          WHERE pl.request_line_id IS NOT NULL AND pl.status <> 'CANCELLED' AND o.status <> 'CANCELLED'
          GROUP BY pl.request_line_id) c ON c.request_line_id = rl.id
        WHERE COALESCE(c.qty, 0) <> rl.ordered_qty_base`),
    ).toBe(0);
  });

  it('totaux : BC = Σ lignes actives ; valeur acceptée d’une réception = Σ accepté × coût (arrondi au franc)', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_purchase_orders o
        LEFT JOIN (
          SELECT order_id, SUM(line_total_xaf) AS total FROM procurement_purchase_order_lines
          WHERE status <> 'CANCELLED' GROUP BY order_id) t ON t.order_id = o.id
        WHERE o.status <> 'CANCELLED' AND COALESCE(t.total, 0) <> o.total_xaf`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM procurement_goods_receipts r
        JOIN (
          SELECT receipt_id, SUM(FLOOR((ROUND(qty_accepted_base * 1000) * unit_cost_xaf + 500) / 1000)) AS total
          FROM procurement_goods_receipt_lines GROUP BY receipt_id) v ON v.receipt_id = r.id
        WHERE v.total <> r.total_accepted_value_xaf`),
    ).toBe(0);
  });
});

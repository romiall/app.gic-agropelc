/**
 * P4-13 — invariants des ventes, des encaissements et de la trésorerie vérifiés sur **toute** la
 * base de test (02-domain-model/01-invariants.md ; plan de développement §4, P4 : « Tests
 * d'intégration INV-VEN-01 à 10, INV-FIN-01 à 04, 09, 10, INV-STK-16 »). Les tests de commande de
 * P4-04 à P4-11 écrivent réellement (aucun retour arrière) : ce balayage porte sur les ventes,
 * commandes, livraisons, annulations, encaissements, affectations et mouvements produits par le
 * vrai pipeline, et vaut à tout moment de la suite (même modèle que P3-08).
 *
 * Les gardes déclaratives sont démontrées par `db/tests/sales.test.ts` et `db/tests/finance.test.ts`
 * (vente immuable et attribution figée, INV-VEN-02 et INV-VEN-10 ; montant de ligne, INV-VEN-03 ;
 * livré ≤ vendu ≤ commandé, INV-VEN-04 ; référence unique, INV-FIN-03 ; aucune suppression,
 * INV-FIN-01) ; ici, leur respect sur les données produites, et les invariants que seule la
 * transaction garantit (sorties de stock, affectations, soldes, contre-écritures).
 *
 * Les mouvements de trésorerie écrits directement par les tests unitaires de `finance` (sans
 * commande, sur des documents fictifs : `finance-cash.test.ts`) sont hors du contrôle de leur
 * document source.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeTestDb, db } from './helpers.js';

async function count(query: ReturnType<typeof sql<{ n: number }>>): Promise<number> {
  const result = await query.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

describe('P4-13 : invariants ventes et trésorerie sur les données produites', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('INV-VEN-01 : une vente synchronisée n’est créée qu’une fois', async () => {
    // Toute commande de vente appliquée a sa vente, sous l'identifiant de l'agrégat…
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sync_command_inbox i
        WHERE i.command_type = 'sales.sale.record'
          AND i.status IN ('APPLIED', 'APPLIED_WITH_WARNINGS')
          AND NOT EXISTS (SELECT 1 FROM sales_sales s WHERE s.id = i.aggregate_id)`),
    ).toBe(0);
    // … et une commande ne produit jamais deux ventes (rejeu sans effet).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM (
          SELECT command_id FROM sales_sales WHERE command_id IS NOT NULL
          GROUP BY command_id HAVING COUNT(*) > 1) d`),
    ).toBe(0);
  });

  it('INV-VEN-02 : montants et compteurs d’annulation et de livraison dans leurs bornes', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales
        WHERE cancelled_xaf < 0 OR cancelled_xaf > total_xaf`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sale_lines
        WHERE cancelled_quantity_base > quantity_base OR cancelled_xaf > line_total_xaf
           OR delivered_quantity_base > quantity_base - cancelled_quantity_base`),
    ).toBe(0);
  });

  it('INV-VEN-03 : montant de ligne = arrondi(quantité de tarification × prix) − remise ; total = Σ lignes', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sale_lines
        WHERE line_total_xaf <> ROUND(pricing_quantity * unit_price_xaf) - discount_xaf`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales s
        JOIN (SELECT sale_id, SUM(line_total_xaf) AS t FROM sales_sale_lines GROUP BY sale_id) l
          ON l.sale_id = s.id
        WHERE s.total_xaf <> l.t`),
    ).toBe(0);
  });

  it('INV-VEN-04 : par ligne de commande, 0 ≤ livré ≤ vendu ≤ commandé', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales_order_lines
        WHERE delivered_quantity_base < 0
           OR delivered_quantity_base > sold_quantity_base
           OR sold_quantity_base > quantity_base`),
    ).toBe(0);
  });

  it('INV-VEN-05 : chaque ligne garde son prix, sa règle et sa version, ou le motif de sa dérogation', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sale_lines
        WHERE price_source = 'RULE'
          AND (price_rule_id IS NULL OR price_rule_version IS NULL OR list_unit_price_xaf IS NULL)`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sale_lines
        WHERE price_source = 'MANUAL_OVERRIDE' AND override_reason_code_id IS NULL`),
    ).toBe(0);
  });

  it('INV-VEN-06 / INV-FIN-04 : payé = affectations actives ≤ net ; encaissement = affecté + crédit + remboursé', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales s
        LEFT JOIN (
          SELECT sale_id, SUM(amount_xaf) AS t FROM sales_payment_allocations
          WHERE status = 'ACTIVE' AND sale_id IS NOT NULL GROUP BY sale_id) a ON a.sale_id = s.id
        WHERE s.amount_paid_xaf <> COALESCE(a.t, 0) OR s.amount_paid_xaf > s.net_total_xaf`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales_orders o
        LEFT JOIN (
          SELECT order_id, SUM(amount_xaf) AS t FROM sales_payment_allocations
          WHERE status = 'ACTIVE' AND order_id IS NOT NULL GROUP BY order_id) a ON a.order_id = o.id
        WHERE o.advance_paid_xaf <> COALESCE(a.t, 0)`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_customer_payments p
        LEFT JOIN (
          SELECT payment_id, SUM(amount_xaf) AS t FROM sales_payment_allocations
          WHERE status = 'ACTIVE' GROUP BY payment_id) a ON a.payment_id = p.id
        WHERE p.status IN ('RECORDED', 'CANCELLATION_REQUESTED')
          AND p.amount_xaf <> COALESCE(a.t, 0) + p.unallocated_xaf + p.refunded_xaf`),
    ).toBe(0);
  });

  it('INV-VEN-07 : une vente sans client saisie en ligne est soldée', async () => {
    // Hors ligne, une vente anonyme impayée est un fait accompli signalé (`ANONYMOUS_UNPAID`).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales
        WHERE customer_id IS NULL AND captured_offline = 0
          AND status <> 'CANCELLED' AND balance_due_xaf > 0`),
    ).toBe(0);
  });

  it('INV-VEN-08 : une vente confirmée sort du stock la quantité de chaque ligne non SERVICE', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales s
        JOIN sales_sale_lines l ON l.sale_id = s.id
        JOIN catalog_products p ON p.id = l.product_id
        LEFT JOIN (
          SELECT source_line_id, SUM(quantity) AS q FROM inventory_stock_moves
          WHERE move_type = 'SALE' GROUP BY source_line_id) m ON m.source_line_id = l.id
        WHERE s.status = 'CONFIRMED' AND p.stock_family <> 'SERVICE'
          AND COALESCE(m.q, 0) <> l.quantity_base`),
    ).toBe(0);
  });

  it('INV-VEN-09 : une vente annulée n’a plus d’effet net', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales s
        WHERE s.status = 'CANCELLED' AND (
          s.cancelled_xaf <> s.total_xaf
          OR EXISTS (SELECT 1 FROM sales_sale_lines l
                     WHERE l.sale_id = s.id AND l.cancelled_quantity_base <> l.quantity_base)
          OR EXISTS (SELECT 1 FROM sales_payment_allocations a
                     WHERE a.sale_id = s.id AND a.status = 'ACTIVE'))`),
    ).toBe(0);
  });

  it('INV-VEN-10 : l’attribution d’une vente reste celle de sa création', async () => {
    // Commercial et zone figés (déclencheur, db/tests) : chaque vente garde la zone de son site au
    // jour de la vente ; ici, la cohérence avec la commande dont elle provient.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sales s
        JOIN sales_sales_orders o ON o.id = s.order_id
        WHERE NOT (s.customer_id <=> o.customer_id)
           OR NOT (s.site_id <=> o.site_id)`),
    ).toBe(0);
  });

  it('INV-FIN-01 / INV-FIN-02 : trésorerie en contre-écriture seulement, soldes = registre', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM finance_cash_accounts a
        LEFT JOIN (
          SELECT cash_account_id,
                 SUM(CASE direction WHEN 'IN' THEN amount_xaf ELSE -amount_xaf END) AS s
          FROM finance_cash_movements GROUP BY cash_account_id) m ON m.cash_account_id = a.id
        WHERE a.balance_xaf <> COALESCE(m.s, 0)`),
    ).toBe(0);
    // Tout mouvement d'encaissement issu d'une commande cite un encaissement existant ; un inverse
    // cite un mouvement de même compte et de même montant, une seule fois.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM finance_cash_movements m
        WHERE m.command_id IS NOT NULL AND m.source_doc_type = 'CUSTOMER_PAYMENT'
          AND NOT EXISTS (SELECT 1 FROM sales_customer_payments p WHERE p.id = m.source_doc_id)`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM finance_cash_movements r
        JOIN finance_cash_movements o ON o.id = r.reverses_movement_id
        WHERE r.cash_account_id <> o.cash_account_id OR r.amount_xaf <> o.amount_xaf
           OR r.direction = o.direction`),
    ).toBe(0);
    // Un encaissement enregistré a son mouvement d'entrée, du même montant.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_customer_payments p
        LEFT JOIN finance_cash_movements m ON m.id = p.cash_movement_id
        WHERE p.status IN ('RECORDED', 'CANCELLATION_REQUESTED', 'CANCELLED')
          AND (m.id IS NULL OR m.amount_xaf <> p.amount_xaf OR m.direction <> 'IN')`),
    ).toBe(0);
  });

  it('INV-FIN-03 : (moyen, référence normalisée) unique parmi les encaissements enregistrés', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM (
          SELECT payment_method_code, reference_normalized FROM sales_customer_payments
          WHERE status IN ('RECORDED', 'CANCELLATION_REQUESTED') AND reference_normalized IS NOT NULL
          GROUP BY payment_method_code, reference_normalized HAVING COUNT(*) > 1) d`),
    ).toBe(0);
  });

  it('INV-FIN-09 : un encaissement mis de côté ou rejeté n’a ni trésorerie ni affectation active', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_customer_payments p
        WHERE p.status IN ('SUSPECT_DUPLICATE', 'REJECTED') AND (
          p.cash_movement_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM finance_cash_movements m
                     WHERE m.source_doc_type = 'CUSTOMER_PAYMENT' AND m.source_doc_id = p.id)
          OR EXISTS (SELECT 1 FROM sales_payment_allocations a
                     WHERE a.payment_id = p.id AND a.status = 'ACTIVE'))`),
    ).toBe(0);
  });

  it('INV-FIN-10 : une affectation active vise une vente ou une commande non annulée', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_payment_allocations a
        LEFT JOIN sales_sales s ON s.id = a.sale_id
        LEFT JOIN sales_sales_orders o ON o.id = a.order_id
        WHERE a.status = 'ACTIVE' AND (s.status = 'CANCELLED' OR o.status = 'CANCELLED')`),
    ).toBe(0);
  });

  it('INV-STK-16 : par ligne de vente non SERVICE, sorties − retours rattachés = quantité nette ; ligne annulée : net nul en valeur', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sale_lines l
        JOIN catalog_products p ON p.id = l.product_id
        LEFT JOIN (
          SELECT source_line_id, SUM(quantity) AS q FROM inventory_stock_moves
          WHERE move_type = 'SALE' GROUP BY source_line_id) sm ON sm.source_line_id = l.id
        LEFT JOIN (
          SELECT o.source_line_id, SUM(r.quantity) AS q FROM inventory_stock_moves r
          JOIN inventory_stock_moves o ON o.id = r.origin_move_id
          WHERE r.move_type = 'CUSTOMER_RETURN' GROUP BY o.source_line_id) rm
          ON rm.source_line_id = l.id
        WHERE p.stock_family <> 'SERVICE'
          AND COALESCE(sm.q, 0) - COALESCE(rm.q, 0) <> l.quantity_base - l.cancelled_quantity_base`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sales_sale_lines l
        JOIN catalog_products p ON p.id = l.product_id
        LEFT JOIN (
          SELECT source_line_id, SUM(value_xaf) AS v FROM inventory_stock_moves
          WHERE move_type = 'SALE' GROUP BY source_line_id) sm ON sm.source_line_id = l.id
        LEFT JOIN (
          SELECT o.source_line_id, SUM(r.value_xaf) AS v FROM inventory_stock_moves r
          JOIN inventory_stock_moves o ON o.id = r.origin_move_id
          WHERE r.move_type = 'CUSTOMER_RETURN' GROUP BY o.source_line_id) rm
          ON rm.source_line_id = l.id
        WHERE p.stock_family <> 'SERVICE' AND l.cancelled_quantity_base = l.quantity_base
          AND COALESCE(sm.v, 0) - COALESCE(rm.v, 0) <> 0`),
    ).toBe(0);
  });
});

/**
 * P7-13 — invariants de la production vérifiés sur **toute** la base de test (02-domain-model/
 * 01-invariants.md ; plan de développement §4, P7 : « Tests d'intégration INV-PRD-01 à 03,
 * INV-OEU-01, INV-INC-01 » et conservation des coûts). Les tests de commande de P7-05 à P7-12
 * écrivent réellement (aucun retour arrière) : ce balayage porte sur tous les lots, entrées,
 * collectes, lots d'incubation, abattages, répartitions, mouvements et écritures de coût produits
 * par le vrai pipeline, et vaut à tout moment de la suite.
 *
 * Les contraintes déclaratives (CHECK de bilan, déclencheurs d'immuabilité) sont aussi démontrées
 * par `db/tests/production-*.test.ts` ; ici, leur respect sur les données produites et les
 * invariants que seule la transaction garantit (effectif initial, lots clos, conservation des
 * valeurs à chaque transformation).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeTestDb, db } from './helpers.js';

async function count(query: ReturnType<typeof sql<{ n: number }>>): Promise<number> {
  const result = await query.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

/** Aucun conflit `LOT_CLOSED` sur le lot `l` (opération hors ligne reçue après la clôture). */
const NO_LOT_CLOSED_CONFLICT = sql`NOT EXISTS (
  SELECT 1 FROM sync_sync_conflicts c
  WHERE c.conflict_type = 'LOT_CLOSED' AND c.entity_id = l.id)`;

describe('P7-13 : invariants de la production sur les données produites', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('INV-PRD-01 : aucune colonne d’effectif ; effectif initial = Σ des entrées enregistrées comptées', async () => {
    // Aucun effectif stocké comme valeur saisie : l'effectif se lit dans le registre de stock.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name LIKE 'production\\_%'
          AND (column_name LIKE '%headcount%' OR column_name LIKE '%effectif%'
               OR column_name IN ('current_quantity', 'current_qty'))`),
    ).toBe(0);
    // Lots créés par le pipeline : effectif initial = Σ des têtes des entrées enregistrées, sauf
    // une entrée appliquée hors ligne après la clôture (conflit LOT_CLOSED portant son id).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_production_lots l
        WHERE l.command_id IN (SELECT command_id FROM sync_command_inbox)
          AND COALESCE(l.initial_quantity, 0) <> (
            SELECT COALESCE(SUM(e.quantity_base), 0) FROM production_lot_entries e
            WHERE e.production_lot_id = l.id AND e.status = 'RECORDED'
              AND NOT EXISTS (
                SELECT 1 FROM sync_sync_conflicts c
                WHERE c.conflict_type = 'LOT_CLOSED' AND c.entity_id = l.id
                  AND JSON_UNQUOTE(JSON_EXTRACT(c.details, '$.entryId')) = BIN_TO_UUID(e.id)))`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_production_lots l
        WHERE l.command_id IN (SELECT command_id FROM sync_command_inbox)`),
    ).toBeGreaterThan(0);
  });

  it('INV-PRD-02 : lot clos vide, lot de traçabilité clos, aucun mouvement postérieur sans conflit LOT_CLOSED', async () => {
    // Effectif non vendu (emplacements physiques, transit, pertes en attente) nul.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_production_lots l
        WHERE l.status = 'CLOSED' AND ${NO_LOT_CLOSED_CONFLICT}
          AND (SELECT COALESCE(SUM(b.qty_on_hand), 0)
               FROM inventory_stock_balances b
               JOIN organization_locations loc ON loc.id = b.location_id
               WHERE b.lot_key = l.stock_lot_id
                 AND (loc.is_virtual = 0 OR loc.code IN ('V_TRANSIT', 'V_PENDING_LOSS'))) <> 0`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_production_lots l
        JOIN inventory_stock_lots s ON s.id = l.stock_lot_id
        WHERE l.status = 'CLOSED' AND s.status <> 'CLOSED'`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_production_lots l
        WHERE l.status = 'CLOSED' AND ${NO_LOT_CLOSED_CONFLICT}
          AND EXISTS (SELECT 1 FROM inventory_stock_moves m
                      WHERE m.lot_id = l.stock_lot_id AND m.occurred_at > l.closed_at)`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_production_lots WHERE status = 'CLOSED'`),
    ).toBeGreaterThan(0);
  });

  it('INV-PRD-03 : la mortalité n’existe qu’une fois, comme perte MORTALITE rattachée à un lot', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name LIKE '%mortal%'`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM inventory_loss_declarations
        WHERE category = 'MORTALITE' AND production_lot_id IS NULL AND incubation_batch_id IS NULL`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM inventory_loss_declarations
        WHERE category = 'MORTALITE' AND production_lot_id IS NOT NULL`),
    ).toBeGreaterThan(0);
  });

  it('INV-OEU-01 : bilan de chaque collecte ; seuls commercialisables et œufs à couver entrent en stock, à leur valeur', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_egg_collections
        WHERE collected_qty <> broken_qty + nonconforming_qty + marketable_qty + hatching_qty`),
    ).toBe(0);
    // Calibres : Σ des lignes = commercialisables.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_egg_collections c
        WHERE c.marketable_qty <> (SELECT COALESCE(SUM(x.quantity), 0)
                                   FROM production_egg_collection_lines x
                                   WHERE x.collection_id = c.id)`),
    ).toBe(0);
    // Mouvements d'entrée (hors inverses) = commercialisables + à couver, valeur = valeur standard.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_egg_collections c
        WHERE c.marketable_qty + c.hatching_qty <> (
                SELECT COALESCE(SUM(m.quantity), 0) FROM inventory_stock_moves m
                WHERE m.source_doc_type = 'EGG_COLLECTION' AND m.source_doc_id = c.id
                  AND m.move_type = 'PRODUCTION_OUTPUT' AND m.is_reversal = 0)
           OR c.standard_value_xaf <> (
                SELECT COALESCE(SUM(m.value_xaf), 0) FROM inventory_stock_moves m
                WHERE m.source_doc_type = 'EGG_COLLECTION' AND m.source_doc_id = c.id
                  AND m.move_type = 'PRODUCTION_OUTPUT' AND m.is_reversal = 0)`),
    ).toBe(0);
    // Collecte annulée : entrées entièrement contrepassées.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_egg_collections c
        WHERE c.status = 'CANCELLED' AND (
          SELECT COALESCE(SUM(CASE WHEN m.is_reversal = 0 THEN m.quantity ELSE -m.quantity END), 0)
          FROM inventory_stock_moves m
          WHERE m.source_doc_type = 'EGG_COLLECTION' AND m.source_doc_id = c.id
            AND m.move_type IN ('PRODUCTION_OUTPUT', 'PRODUCTION_INPUT')
            AND ((m.is_reversal = 0 AND m.move_type = 'PRODUCTION_OUTPUT')
                 OR (m.is_reversal = 1 AND m.move_type = 'PRODUCTION_INPUT'))) <> 0`),
    ).toBe(0);
    // Crédit du lot producteur (AV-098) : net (crédit de la collecte moins sa contre-passation)
    // = valeur de la collecte, nul si annulée.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_egg_collections c
        WHERE (CASE WHEN c.status = 'RECORDED' THEN c.standard_value_xaf ELSE 0 END) <> (
          SELECT COALESCE(SUM(e.amount_xaf), 0) FROM inventory_cost_entries e
          WHERE e.cost_type = 'PRODUCTION_TRANSFEREE' AND e.direction = 'CREDIT'
            AND e.source_id = c.id) - (
          SELECT COALESCE(SUM(r.amount_xaf), 0) FROM inventory_cost_entries r
          JOIN inventory_cost_entries e ON e.id = r.reverses_entry_id
          WHERE e.cost_type = 'PRODUCTION_TRANSFEREE' AND e.direction = 'CREDIT'
            AND e.source_id = c.id)`),
    ).toBe(0);
  });

  it('INV-INC-01 : bilan d’un lot d’incubation clos ; compteurs jamais au-delà des œufs incubés', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_incubation_batches
        WHERE status = 'CLOSED'
          AND eggs_set_qty <> infertile_qty + early_dead_qty + accidental_loss_qty
                              + unhatched_qty + hatched_viable_qty + hatched_nonviable_qty`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_incubation_batches
        WHERE eggs_set_qty < infertile_qty + early_dead_qty + accidental_loss_qty
                             + unhatched_qty + hatched_viable_qty + hatched_nonviable_qty
           OR transferred_qty > eggs_set_qty`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_incubation_batches WHERE status = 'CLOSED'`),
    ).toBeGreaterThan(0);
  });

  it('conservation des coûts : entrée de lot, éclosion, abattage, répartition des frais généraux', async () => {
    // Entrée : la valeur de l'entrée est celle des animaux entrés dans le lot (ANIMAUX, ADR-027).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_lot_entries e
        JOIN production_production_lots l ON l.id = e.production_lot_id
        WHERE e.status = 'RECORDED' AND e.value_xaf <> (
          SELECT COALESCE(SUM(m.value_xaf), 0) FROM inventory_stock_moves m
          WHERE m.source_doc_type IN ('LOT_ENTRY', 'LOT_TRANSFER') AND m.source_doc_id = e.id
            AND m.lot_id = l.stock_lot_id AND m.to_location_id = e.to_location_id
            AND m.is_reversal = 0)`),
    ).toBe(0);
    // Éclosion : les poussins viables emportent tout le coût du lot d'incubation.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_incubation_batches b
        WHERE b.status = 'CLOSED' AND b.hatched_viable_qty > 0 AND (
          SELECT COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_xaf
                                   ELSE -e.amount_xaf END), 0)
          FROM inventory_cost_entries e
          WHERE e.cost_object_type = 'INCUBATION_BATCH' AND e.cost_object_id = b.id) <> (
          SELECT COALESCE(SUM(m.value_xaf), 0) FROM inventory_stock_moves m
          WHERE m.lot_id = b.stock_lot_id AND m.product_id = b.chick_product_id
            AND m.move_type = 'PRODUCTION_OUTPUT' AND m.is_reversal = 0)`),
    ).toBe(0);
    // Abattage : valeur des animaux sortis = Σ des parts des produits = Σ des entrées de produits.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_slaughter_batches s
        WHERE s.total_input_value_xaf <> (
                SELECT COALESCE(SUM(o.allocated_value_xaf), 0) FROM production_slaughter_outputs o
                WHERE o.slaughter_id = s.id)
           OR s.total_input_value_xaf <> (
                SELECT COALESCE(SUM(m.value_xaf), 0) FROM inventory_stock_moves m
                WHERE m.source_doc_type = 'SLAUGHTER' AND m.source_doc_id = s.id
                  AND m.move_type = 'PRODUCTION_INPUT' AND m.is_reversal = 0)
           OR s.total_input_value_xaf <> (
                SELECT COALESCE(SUM(m.value_xaf), 0) FROM inventory_stock_moves m
                WHERE m.source_doc_type = 'SLAUGHTER' AND m.source_doc_id = s.id
                  AND m.move_type = 'PRODUCTION_OUTPUT' AND m.is_reversal = 0)`),
    ).toBe(0);
    // Frais généraux (ADR-026) : Σ des parts = montant réparti ≤ masse ; débits des lots =
    // crédit du site = montant réparti, au franc près.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_overhead_allocations a
        WHERE a.allocated_xaf > a.pool_xaf
           OR a.allocated_xaf <> (
                SELECT COALESCE(SUM(x.amount_xaf), 0) FROM production_overhead_allocation_lines x
                WHERE x.allocation_id = a.id)
           OR a.allocated_xaf <> (
                SELECT COALESCE(SUM(e.amount_xaf), 0) FROM inventory_cost_entries e
                JOIN production_overhead_allocation_lines x ON x.id = e.source_id
                WHERE x.allocation_id = a.id AND e.source_type = 'ALLOCATION'
                  AND e.direction = 'DEBIT' AND e.cost_object_type = 'PRODUCTION_LOT')
           OR a.allocated_xaf <> (
                SELECT COALESCE(SUM(e.amount_xaf), 0) FROM inventory_cost_entries e
                WHERE e.source_type = 'ALLOCATION' AND e.source_id = a.id
                  AND e.direction = 'CREDIT' AND e.cost_object_type = 'SITE')`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM production_slaughter_batches`),
    ).toBeGreaterThan(0);
  });
});

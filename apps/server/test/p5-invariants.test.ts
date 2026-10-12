/**
 * P5-22 : invariants de la distribution balayés sur **toute la base** (même modèle que P3-08, P4-13 :
 * `sales-finance-invariants.test.ts`, `inventory-invariants.test.ts`) — INV-STK-10, 11, 19, 20 (quotas
 * d'appareil), INV-FIN-05, 06, 11 (sessions de caisse), INV-DIS-01 (configuration du PDV). Lecture seule.
 *
 * Chaque balayage rend les identifiants fautifs (au plus 20), pas seulement leur nombre. La base est
 * partagée et persistante, l'ordre des fichiers n'est pas garanti : chaque requête doit valoir à tout
 * moment de la suite. Exclusions assumées : les sessions `OPEN` ne relèvent pas d'INV-FIN-11 (sessions de
 * test posées par `openTestCashSession`, jamais closes) ; un mouvement qui **revient** à l'emplacement
 * d'un quota (retour, inverse, libération de perte) peut être d'un autre auteur (annulation par un
 * responsable) et n'entre pas dans INV-STK-11.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { verifyCashSessions } from '../src/modules/finance/application/public/index.js';
import { verifyStockLedger } from '../src/modules/inventory/application/public/index.js';
import { closeTestDb, db } from './helpers.js';

afterAll(closeTestDb);

/** Identifiants fautifs d'une requête qui sélectionne `ref` (au plus 20). */
async function offenders(query: ReturnType<typeof sql<{ ref: string }>>): Promise<string[]> {
  const { rows } = await query.execute(db);
  return rows.map((row) => row.ref);
}

describe('P5-22 : invariants de la distribution sur toute la base', () => {
  it('INV-STK-10 : un reste de quota n’est jamais négatif ni au-dessus de l’accordé', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(id) AS ref FROM inventory_stock_allocations
        WHERE quantity_remaining < 0 OR quantity_remaining > quantity_granted LIMIT 20`),
    ).toEqual([]);
  });

  it('INV-STK-11 : une sortie qui consomme un quota est de son couple (utilisateur, appareil), du même produit et du même emplacement', async () => {
    // Sortie de l'emplacement du quota : auteur et appareil du détenteur.
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(m.id) AS ref FROM inventory_stock_moves m
        JOIN inventory_stock_allocations a ON a.id = m.allocation_id
        WHERE m.from_location_id = a.location_id
          AND (m.created_by <> a.holder_user_id
               OR m.created_device_id IS NULL OR m.created_device_id <> a.holder_device_id)
        LIMIT 20`),
    ).toEqual([]);
    // Tout mouvement qui porte un quota en touche le produit et l'emplacement.
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(m.id) AS ref FROM inventory_stock_moves m
        JOIN inventory_stock_allocations a ON a.id = m.allocation_id
        WHERE m.product_id <> a.product_id
           OR (m.from_location_id <> a.location_id AND m.to_location_id <> a.location_id)
        LIMIT 20`),
    ).toEqual([]);
    // Et a son entrée de registre (CONSUME à la sortie, RESTORE au retour), du même montant.
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(m.id) AS ref FROM inventory_stock_moves m
        LEFT JOIN inventory_stock_allocation_entries e
               ON e.stock_move_id = m.id AND e.allocation_id = m.allocation_id
              AND e.entry_type IN ('CONSUME', 'RESTORE')
        WHERE m.allocation_id IS NOT NULL AND (e.id IS NULL OR ABS(e.quantity) <> m.quantity)
        LIMIT 20`),
    ).toEqual([]);
  });

  it('INV-STK-19 et INV-STK-20 : restes = registre, consommation = mouvements, quotas ≤ stock ou conflit ouvert (verifyStockLedger)', async () => {
    const result = await db.transaction().execute((trx) => verifyStockLedger(trx));
    expect(result.allocationBreaches).toEqual([]);
    expect(result.overcommitBreaches).toEqual([]);
  });

  it('INV-STK-20 : l’accordé est la somme des octrois et hausses ; chaque consommation ou restitution cite son mouvement', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(a.id) AS ref FROM inventory_stock_allocations a
        LEFT JOIN (SELECT allocation_id, SUM(quantity) AS granted
                   FROM inventory_stock_allocation_entries
                   WHERE entry_type IN ('GRANT', 'INCREASE') GROUP BY allocation_id) e
               ON e.allocation_id = a.id
        WHERE a.quantity_granted <> COALESCE(e.granted, 0)
        LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(e.id) AS ref FROM inventory_stock_allocation_entries e
        LEFT JOIN inventory_stock_moves m ON m.id = e.stock_move_id
        WHERE e.entry_type IN ('CONSUME', 'RESTORE')
          AND (m.id IS NULL OR m.allocation_id IS NULL OR m.allocation_id <> e.allocation_id
               OR ABS(e.quantity) <> m.quantity)
        LIMIT 20`),
    ).toEqual([]);
  });

  it('INV-FIN-05, 06, 11 et BR-DIS-006 : toutes les sessions de caisse (verifyCashSessions)', async () => {
    const result = await verifyCashSessions(db);
    expect(result.breaches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('INV-FIN-05 : chaque ajustement d’une session close est tracé par son conflit CASH_SESSION_REEVALUATED', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(a.id) AS ref FROM finance_cash_session_adjustments a
        WHERE NOT EXISTS (
          SELECT 1 FROM sync_sync_conflicts c
          WHERE c.conflict_type = 'CASH_SESSION_REEVALUATED' AND c.entity_id = a.session_id
            AND JSON_UNQUOTE(JSON_EXTRACT(c.details, '$.adjustmentId')) = BIN_TO_UUID(a.id))
        LIMIT 20`),
    ).toEqual([]);
  });

  it('INV-DIS-01 : l’emplacement de vente d’un PDV est le POS de son site, propre à ce PDV ; un PDV partagé ne désigne aucun appareil', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(p.site_id) AS ref FROM organization_points_of_sale p
        JOIN organization_locations l ON l.id = p.sales_location_id
        WHERE l.location_type <> 'POS' OR l.site_id <> p.site_id
        LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(sales_location_id) AS ref FROM organization_points_of_sale
        GROUP BY sales_location_id HAVING COUNT(*) > 1 LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(p.site_id) AS ref FROM organization_points_of_sale p
        JOIN organization_locations l ON l.id = p.sales_location_id
        WHERE p.custody_mode = 'SHARED'
          AND (p.designated_device_id IS NOT NULL OR l.designated_device_id IS NOT NULL)
        LIMIT 20`),
    ).toEqual([]);
  });
});

/**
 * P8-12 : invariants de la finance opérationnelle balayés sur **toute la base** (même modèle que P5-22,
 * `p5-invariants.test.ts`) — INV-FIN-07 (payé d'une facture = Σ affectations actives), INV-FIN-08 (coût
 * d'une dépense imputée), paiements et leurs mouvements, quantités facturées des BC (ADR-043 §3), demandes
 * de validation des dépenses, factures et paiements (ADR-042 §4, ADR-043 §4 et §6). Lecture seule.
 *
 * La base est partagée et persistante, l'ordre des fichiers n'est pas garanti : chaque requête doit valoir
 * à tout moment de la suite. Exclusion assumée : un mouvement `EXPENSE` ou `SUPPLIER_PAYMENT` sans document
 * n'est pas une faute ici — les tests de la trésorerie de P4 et P5 (`finance-cash`, `finance-wf15-cash-day`)
 * en écrivent avec des documents fictifs ; le sens qui compte (document → mouvement) est vérifié. Une base
 * polluée par des passes de mutation (code volontairement faux) fait échouer ce balayage : les mutations
 * tournent sur la base jetable (`17-suivi-p8.md`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  verifyExpenses,
  verifySupplierLedger,
} from '../src/modules/finance/application/public/index.js';
import { closeTestDb, db } from './helpers.js';

afterAll(closeTestDb);

/** Identifiants fautifs d'une requête qui sélectionne `ref` (au plus 20). */
async function offenders(query: ReturnType<typeof sql<{ ref: string }>>): Promise<string[]> {
  const { rows } = await query.execute(db);
  return rows.map((row) => row.ref);
}

describe('P8-12 : invariants de la finance opérationnelle sur toute la base', () => {
  it('dépenses : mouvement de la dépense payée, coût net de la dépense imputée (INV-FIN-08), reclassement du rejet après paiement (verifyExpenses)', async () => {
    const result = await verifyExpenses(db);
    expect(result.breaches).toEqual([]);
  });

  it('dépenses : payée ⇔ date de paiement et mouvement ; aucune écriture de coût EXPENSE d’origine sans sa dépense, aucune contrepassation sans son écriture EXPENSE', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT doc_number AS ref FROM finance_expenses
        WHERE (status IN ('PAID', 'PAID_PENDING_APPROVAL', 'PAID_REJECTED'))
              <> (paid_at IS NOT NULL AND cash_movement_id IS NOT NULL)
        LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(c.id) AS ref FROM inventory_cost_entries c
        LEFT JOIN finance_expenses e ON e.id = c.source_id
        WHERE c.source_type = 'EXPENSE' AND c.reverses_entry_id IS NULL AND e.id IS NULL
        LIMIT 20`),
    ).toEqual([]);
    // La contrepassation porte une source neuve (clé unique source × objet, `reverseCostEntries`) :
    // elle se rattache à la dépense par l'écriture qu'elle contrepasse.
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(c.id) AS ref FROM inventory_cost_entries c
        LEFT JOIN inventory_cost_entries o ON o.id = c.reverses_entry_id
        WHERE c.source_type = 'EXPENSE' AND c.reverses_entry_id IS NOT NULL
          AND (o.id IS NULL OR o.source_type <> 'EXPENSE' OR o.amount_xaf <> c.amount_xaf
               OR o.direction = c.direction OR o.cost_object_id <> c.cost_object_id)
        LIMIT 20`),
    ).toEqual([]);
  });

  it('fournisseurs : payé = Σ affectations actives (INV-FIN-07), paiement = affectations + avance, mouvement du décaissement et de son annulation (verifySupplierLedger)', async () => {
    const result = await verifySupplierLedger(db);
    expect(result.breaches).toEqual([]);
  });

  it('BC : le facturé de chaque ligne vaut Σ des lignes des factures approuvées, partiellement payées ou payées (ADR-043 §3) ; une ligne de facture cite une ligne du BC de sa facture', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(l.id) AS ref FROM procurement_purchase_order_lines l
        LEFT JOIN (SELECT il.po_line_id, SUM(il.quantity_base) AS quantity
                     FROM finance_supplier_invoice_lines il
                     JOIN finance_supplier_invoices i ON i.id = il.invoice_id
                    WHERE i.status IN ('APPROVED', 'PARTIALLY_PAID', 'PAID')
                      AND i.purchase_order_id IS NOT NULL AND il.po_line_id IS NOT NULL
                    GROUP BY il.po_line_id) f ON f.po_line_id = l.id
        WHERE l.invoiced_qty_base <> COALESCE(f.quantity, 0)
        LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(il.id) AS ref FROM finance_supplier_invoice_lines il
        JOIN finance_supplier_invoices i ON i.id = il.invoice_id
        JOIN procurement_purchase_order_lines l ON l.id = il.po_line_id
        WHERE i.purchase_order_id IS NULL OR l.order_id <> i.purchase_order_id
        LIMIT 20`),
    ).toEqual([]);
  });

  it('validations : un document en attente a sa demande en attente ; une demande en attente sur un document de P8 le trouve en attente', async () => {
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT e.doc_number AS ref FROM finance_expenses e
        LEFT JOIN approvals_approval_requests r ON r.id = e.approval_request_id
        WHERE e.status IN ('PENDING_APPROVAL', 'PAID_PENDING_APPROVAL')
          AND (r.id IS NULL OR r.status <> 'PENDING' OR r.subject_id <> e.id)
        UNION ALL
        SELECT p.doc_number FROM finance_supplier_payments p
        LEFT JOIN approvals_approval_requests r ON r.id = p.approval_request_id
        WHERE p.status = 'PENDING_APPROVAL'
          AND (r.id IS NULL OR r.status <> 'PENDING' OR r.subject_id <> p.id)
        LIMIT 20`),
    ).toEqual([]);
    expect(
      await offenders(sql<{ ref: string }>`
        SELECT BIN_TO_UUID(r.id) AS ref FROM approvals_approval_requests r
        LEFT JOIN finance_expenses e ON r.subject_type = 'EXPENSE' AND e.id = r.subject_id
        LEFT JOIN finance_supplier_payments p ON r.subject_type = 'SUPPLIER_PAYMENT' AND p.id = r.subject_id
        LEFT JOIN finance_supplier_invoices i ON r.subject_type = 'SUPPLIER_INVOICE' AND i.id = r.subject_id
        WHERE r.status = 'PENDING'
          AND r.subject_type IN ('EXPENSE', 'SUPPLIER_PAYMENT', 'SUPPLIER_INVOICE')
          AND NOT ((r.subject_type = 'EXPENSE' AND e.status IN ('PENDING_APPROVAL', 'PAID_PENDING_APPROVAL'))
                OR (r.subject_type = 'SUPPLIER_PAYMENT' AND p.status = 'PENDING_APPROVAL')
                OR (r.subject_type = 'SUPPLIER_INVOICE' AND i.status = 'MISMATCH'))
        LIMIT 20`),
    ).toEqual([]);
  });
});

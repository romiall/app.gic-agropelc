/**
 * Vérification de la finance opérationnelle (P8-12 ; INV-FIN-07, INV-FIN-08 ; ADR-060, ADR-061),
 * appelée par la réconciliation quotidienne (`finance.cash.reconcile_daily`) et par le balayage des
 * invariants. Lecture seule, sur toute la base ou sur des identifiants donnés.
 *
 * Dépenses :
 * - `EXPENSE_MOVEMENT` : une dépense payée a son mouvement `EXPENSE` sortant, de même montant ;
 * - `EXPENSE_COST` (INV-FIN-08, BR-FIN-022) : le coût net de la dépense (écritures source `EXPENSE` moins
 *   leurs contrepassations) vaut son montant si elle porte son coût (imputée et enregistrée sans
 *   validation, approuvée ou payée), zéro sinon ;
 * - `EXPENSE_RECLASSIFICATION` (AV-355) : une dépense rejetée après paiement est reclassée dans la
 *   catégorie système.
 *
 * Fournisseurs :
 * - `INVOICE_PAID` (INV-FIN-07) : le payé d'une facture vaut Σ de ses affectations actives ;
 * - `PAYMENT_ALLOCATION` : un paiement décaissé vaut Σ affectations actives + avance ; en attente, Σ
 *   affectations prévues + avance ; rejeté ou annulé, aucune affectation prévue ni active ;
 * - `PAYMENT_MOVEMENT` : un paiement décaissé a son mouvement `SUPPLIER_PAYMENT` sortant de même
 *   montant ; annulé après décaissement, son mouvement inverse.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface OperationsBreach {
  readonly ref: string;
  readonly invariant: string;
  readonly detail: string;
}

export interface OperationsVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly breaches: readonly OperationsBreach[];
}

const idFilter = (column: string, ids: readonly string[] | undefined) =>
  ids === undefined
    ? sql`TRUE`
    : ids.length === 0
      ? sql`FALSE`
      : sql`${sql.ref(column)} IN (${sql.join(ids.map((id) => toBin(id)))})`;

async function rowsOf<T>(executor: Executor, query: ReturnType<typeof sql<T>>): Promise<readonly T[]> {
  return (await query.execute(executor)).rows;
}

export async function verifyExpenses(
  executor: Executor,
  scope: { readonly expenseIds?: readonly string[] } = {},
): Promise<OperationsVerification> {
  const where = idFilter('e.id', scope.expenseIds);
  const breaches: OperationsBreach[] = [];
  const counted = await rowsOf<{ n: string }>(
    executor,
    sql<{ n: string }>`SELECT COUNT(*) AS n FROM finance_expenses e WHERE ${where}`,
  );
  for (const row of await rowsOf<{ ref: string; detail: string }>(
    executor,
    sql<{ ref: string; detail: string }>`
      SELECT e.doc_number AS ref, CONCAT('mouvement ', COALESCE(m.movement_type, 'absent'), ' ', COALESCE(m.direction, ''), ' ',
             COALESCE(m.amount_xaf, 0), ' pour ', e.amount_xaf) AS detail
        FROM finance_expenses e
        LEFT JOIN finance_cash_movements m ON m.id = e.cash_movement_id
       WHERE ${where} AND e.paid_at IS NOT NULL
         AND (m.id IS NULL OR m.movement_type <> 'EXPENSE' OR m.direction <> 'OUT' OR m.amount_xaf <> e.amount_xaf
              OR m.source_doc_id <> e.id)
       LIMIT 50`,
  )) {
    breaches.push({ ref: row.ref, invariant: 'EXPENSE_MOVEMENT', detail: row.detail });
  }
  for (const row of await rowsOf<{ ref: string; net: string; expected: string }>(
    executor,
    sql<{ ref: string; net: string; expected: string }>`
      SELECT e.doc_number AS ref,
             COALESCE(SUM(CASE WHEN o.direction = 'DEBIT' THEN o.amount_xaf ELSE -o.amount_xaf END), 0)
               - COALESCE(SUM(CASE WHEN r.direction = 'DEBIT' THEN -r.amount_xaf ELSE r.amount_xaf END), 0) AS net,
             CASE WHEN e.cost_object_type IS NOT NULL AND e.status IN ('RECORDED', 'APPROVED', 'PAID')
                  THEN e.amount_xaf ELSE 0 END AS expected
        FROM finance_expenses e
        LEFT JOIN inventory_cost_entries o
               ON o.source_type = 'EXPENSE' AND o.source_id = e.id AND o.reverses_entry_id IS NULL
        LEFT JOIN inventory_cost_entries r ON r.reverses_entry_id = o.id
       WHERE ${where}
       GROUP BY e.id, e.doc_number, e.cost_object_type, e.status, e.amount_xaf
      HAVING net <> expected
       LIMIT 50`,
  )) {
    breaches.push({
      ref: row.ref,
      invariant: 'EXPENSE_COST',
      detail: `coût net ${row.net} pour ${row.expected} attendu`,
    });
  }
  for (const row of await rowsOf<{ ref: string }>(
    executor,
    sql<{ ref: string }>`
      SELECT e.doc_number AS ref
        FROM finance_expenses e
        LEFT JOIN finance_expense_categories c ON c.id = e.reclassified_category_id
       WHERE ${where} AND e.status = 'PAID_REJECTED' AND (c.id IS NULL OR c.is_system = FALSE)
       LIMIT 50`,
  )) {
    breaches.push({ ref: row.ref, invariant: 'EXPENSE_RECLASSIFICATION', detail: 'catégorie système absente' });
  }
  return { ok: breaches.length === 0, checked: Number(counted[0]?.n ?? 0), breaches };
}

export async function verifySupplierLedger(
  executor: Executor,
  scope: { readonly invoiceIds?: readonly string[]; readonly paymentIds?: readonly string[] } = {},
): Promise<OperationsVerification> {
  const invoices = idFilter('i.id', scope.invoiceIds);
  const payments = idFilter('p.id', scope.paymentIds);
  const breaches: OperationsBreach[] = [];
  const counted = await rowsOf<{ n: string }>(
    executor,
    sql<{ n: string }>`SELECT (SELECT COUNT(*) FROM finance_supplier_invoices i WHERE ${invoices})
                            + (SELECT COUNT(*) FROM finance_supplier_payments p WHERE ${payments}) AS n`,
  );
  for (const row of await rowsOf<{ ref: string; paid: string; allocated: string }>(
    executor,
    sql<{ ref: string; paid: string; allocated: string }>`
      SELECT i.doc_number AS ref, i.paid_xaf AS paid, COALESCE(SUM(a.amount_xaf), 0) AS allocated
        FROM finance_supplier_invoices i
        LEFT JOIN finance_supplier_payment_allocations a ON a.invoice_id = i.id AND a.status = 'ACTIVE'
       WHERE ${invoices}
       GROUP BY i.id, i.doc_number, i.paid_xaf
      HAVING paid <> allocated
       LIMIT 50`,
  )) {
    breaches.push({
      ref: row.ref,
      invariant: 'INVOICE_PAID',
      detail: `payé ${row.paid} ≠ affectations actives ${row.allocated}`,
    });
  }
  for (const row of await rowsOf<{ ref: string; status: string; amount: string; active: string; planned: string; unallocated: string }>(
    executor,
    sql<{ ref: string; status: string; amount: string; active: string; planned: string; unallocated: string }>`
      SELECT p.doc_number AS ref, p.status AS status, p.amount_xaf AS amount, p.unallocated_xaf AS unallocated,
             COALESCE(SUM(CASE WHEN a.status = 'ACTIVE' THEN a.amount_xaf ELSE 0 END), 0) AS active,
             COALESCE(SUM(CASE WHEN a.status = 'PLANNED' THEN a.amount_xaf ELSE 0 END), 0) AS planned
        FROM finance_supplier_payments p
        LEFT JOIN finance_supplier_payment_allocations a ON a.payment_id = p.id
       WHERE ${payments}
       GROUP BY p.id, p.doc_number, p.status, p.amount_xaf, p.unallocated_xaf
      HAVING (status = 'RECORDED' AND (amount <> active + unallocated OR planned <> 0))
          OR (status = 'PENDING_APPROVAL' AND (amount <> planned + unallocated OR active <> 0))
          OR (status IN ('REJECTED', 'CANCELLED') AND (active <> 0 OR planned <> 0))
       LIMIT 50`,
  )) {
    breaches.push({
      ref: row.ref,
      invariant: 'PAYMENT_ALLOCATION',
      detail: `${row.status} : montant ${row.amount}, actives ${row.active}, prévues ${row.planned}, avance ${row.unallocated}`,
    });
  }
  for (const row of await rowsOf<{ ref: string; detail: string }>(
    executor,
    sql<{ ref: string; detail: string }>`
      SELECT p.doc_number AS ref, CONCAT(p.status, ' : mouvement ', COALESCE(m.amount_xaf, 'absent'),
             ', inverse ', COALESCE(c.amount_xaf, 'absent')) AS detail
        FROM finance_supplier_payments p
        LEFT JOIN finance_cash_movements m ON m.id = p.cash_movement_id
        LEFT JOIN finance_cash_movements c ON c.id = p.cancel_movement_id
       WHERE ${payments}
         AND ((p.status = 'RECORDED' AND (m.id IS NULL OR m.movement_type <> 'SUPPLIER_PAYMENT' OR m.direction <> 'OUT'
                                          OR m.amount_xaf <> p.amount_xaf OR m.source_doc_id <> p.id))
           OR (p.status = 'CANCELLED' AND p.cash_movement_id IS NOT NULL
               AND (c.id IS NULL OR c.direction <> 'IN' OR c.amount_xaf <> p.amount_xaf OR c.reverses_movement_id <> p.cash_movement_id)))
       LIMIT 50`,
  )) {
    breaches.push({ ref: row.ref, invariant: 'PAYMENT_MOVEMENT', detail: row.detail });
  }
  return { ok: breaches.length === 0, checked: Number(counted[0]?.n ?? 0), breaches };
}

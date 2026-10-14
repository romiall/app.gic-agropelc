// Finance opérationnelle après la migration 20261101090000 (P8-03 ; ADR-042, ADR-043 ; SM-EXPENSE,
// SM-SUPPLIER-INVOICE, SM-SUPPLIER-PAYMENT ; INV-FIN-07) : cohérence d'état des dépenses, factures,
// paiements et affectations, immuabilité des données d'origine, aucune suppression, unicité de la
// référence fournisseur parmi les factures non annulées, vue des dettes. Chaque test crée ses
// données dans une transaction annulée.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { freshPhone, randomId, withRollback } from './helpers.js';

const T = (day: string, hhmm = '10:00') => `${day} ${hhmm}:00.000000`;
const code = (prefix: string) => `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;

interface Refs {
  readonly admin: Buffer;
  readonly siteId: Buffer;
  readonly supplierId: Buffer;
  readonly accountId: Buffer;
  readonly categoryId: Buffer;
}

async function refs(conn: PoolConnection): Promise<Refs> {
  const admin = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Finance', ?, 'x', 'ACTIVE', ?)`,
    [admin, await freshPhone(conn), admin],
  );
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, code('Z'), admin],
  );
  const siteId = randomId();
  await conn.query(
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by)
     VALUES (?, ?, 'PDV', 'POINT_DE_VENTE', ?, ?)`,
    [siteId, code('S'), zoneId, admin],
  );
  const supplierId = randomId();
  await conn.query(
    `INSERT INTO procurement_suppliers (id, code, name, supplied_categories, created_by)
     VALUES (?, ?, 'Provenderie', JSON_ARRAY(), ?)`,
    [supplierId, code('F'), admin],
  );
  const accountId = randomId();
  await conn.query(
    `INSERT INTO finance_cash_accounts (id, code, name, account_type, responsible_user_id, created_by)
     VALUES (?, ?, 'Banque', 'BANQUE', ?, ?)`,
    [accountId, code('CPT'), admin, admin],
  );
  const categoryId = randomId();
  await conn.query(
    `INSERT INTO finance_expense_categories (id, code, label, allowed_on_pos, created_by) VALUES (?, ?, 'Transport', TRUE, ?)`,
    [categoryId, code('CAT_'), admin],
  );
  return { admin, siteId, supplierId, accountId, categoryId };
}

async function movement(
  conn: PoolConnection,
  r: Refs,
  input: { readonly type: 'EXPENSE' | 'SUPPLIER_PAYMENT'; readonly docId: Buffer },
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO finance_cash_movements (id, cash_account_id, direction, amount_xaf, movement_type, source_doc_type,
       source_doc_id, occurred_at, created_by)
     VALUES (?, ?, 'OUT', 1000, ?, ?, ?, ?, ?)`,
    [id, r.accountId, input.type, input.type, input.docId, T('2026-11-02'), r.admin],
  );
  return id;
}

/** Dépense à payer `RECORDED` de 1 000 XAF. */
async function recordedExpense(conn: PoolConnection, r: Refs): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO finance_expenses (id, doc_number, site_id, category_id, amount_xaf, description, paid_now, status,
       occurred_at, created_by)
     VALUES (?, ?, ?, ?, 1000, 'Taxi', FALSE, 'RECORDED', ?, ?)`,
    [id, code('DEP-'), r.siteId, r.categoryId, T('2026-11-02'), r.admin],
  );
  return id;
}

async function invoice(
  conn: PoolConnection,
  r: Refs,
  input: {
    readonly ref: string;
    readonly status?: string;
    readonly total?: number;
    readonly due?: string;
  },
): Promise<Buffer> {
  const id = randomId();
  const approved = ['APPROVED', 'PARTIALLY_PAID', 'PAID'].includes(input.status ?? 'APPROVED');
  await conn.query(
    `INSERT INTO finance_supplier_invoices (id, doc_number, supplier_id, supplier_invoice_ref, invoice_date, due_date,
       total_xaf, status, approved_by, approved_at, disputed_at, occurred_at, created_by)
     VALUES (?, ?, ?, ?, '2026-11-01', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      code('FF-'),
      r.supplierId,
      input.ref,
      input.due ?? '2026-11-01',
      input.total ?? 1_425_000,
      input.status ?? 'APPROVED',
      approved ? r.admin : null,
      approved ? T('2026-11-01') : null,
      input.status === 'DISPUTED' ? T('2026-11-01') : null,
      T('2026-11-01'),
      r.admin,
    ],
  );
  return id;
}

async function payment(conn: PoolConnection, r: Refs): Promise<Buffer> {
  const id = randomId();
  const out = await movement(conn, r, { type: 'SUPPLIER_PAYMENT', docId: id });
  await conn.query(
    `INSERT INTO finance_supplier_payments (id, doc_number, supplier_id, amount_xaf, payment_method_code, from_account_id,
       status, unallocated_xaf, cash_movement_id, disbursed_at, occurred_at, created_by)
     VALUES (?, ?, ?, 1425000, 'VIREMENT', ?, 'RECORDED', 0, ?, ?, ?, ?)`,
    [id, code('PF-'), r.supplierId, r.accountId, out, T('2026-11-02'), T('2026-11-02'), r.admin],
  );
  return id;
}

describe('finance_expenses (SM-EXPENSE, migration 20261101090000)', () => {
  it('payée : compte, date, auteur et mouvement ensemble ; PAID sans paiement refusé', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const id = await recordedExpense(conn, r);
      await expect(
        conn.query(`UPDATE finance_expenses SET status = 'PAID' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_finance_expenses_state/);
      const out = await movement(conn, r, { type: 'EXPENSE', docId: id });
      await expect(
        conn.query(
          `UPDATE finance_expenses SET paid_at = ?, paid_from_account_id = ? WHERE id = ?`,
          [T('2026-11-03'), r.accountId, id],
        ),
      ).rejects.toThrow(/ck_finance_expenses_paid/);
      await conn.query(
        `UPDATE finance_expenses SET status = 'PAID', paid_at = ?, paid_from_account_id = ?, paid_by = ?,
           cash_movement_id = ? WHERE id = ?`,
        [T('2026-11-03'), r.accountId, r.admin, out, id],
      );
      // PAID est terminal ; le paiement ne change plus.
      await expect(
        conn.query(
          `UPDATE finance_expenses SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
           cancel_reason = 'x' WHERE id = ?`,
          [T('2026-11-04'), r.admin, id],
        ),
      ).rejects.toThrow();
    }));

  it('objet de coût : type et identifiant ensemble ; espèce réservée au site', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const insert = (type: string | null, objectId: Buffer | null, species: string | null) =>
        conn.query(
          `INSERT INTO finance_expenses (id, doc_number, site_id, category_id, amount_xaf, description, cost_object_type,
             cost_object_id, species_group, paid_now, status, occurred_at, created_by)
           VALUES (?, ?, ?, ?, 1000, 'x', ?, ?, ?, FALSE, 'RECORDED', ?, ?)`,
          [
            randomId(),
            code('DEP-'),
            r.siteId,
            r.categoryId,
            type,
            objectId,
            species,
            T('2026-11-02'),
            r.admin,
          ],
        );
      await insert('PRODUCTION_LOT', randomId(), null);
      await insert('SITE', r.siteId, 'PORC');
      await expect(insert('PRODUCTION_LOT', null, null)).rejects.toThrow(
        /ck_finance_expenses_cost_object/,
      );
      await expect(insert('PRODUCTION_LOT', randomId(), 'PORC')).rejects.toThrow(
        /ck_finance_expenses_species/,
      );
      await expect(insert('PDV', randomId(), null)).rejects.toThrow(
        /ck_finance_expenses_cost_object/,
      );
    }));

  it('en attente de validation : demande exigée ; rejet après paiement : catégorie et responsable exigés', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      await expect(
        conn.query(
          `INSERT INTO finance_expenses (id, doc_number, site_id, category_id, amount_xaf, description, paid_now, status,
             occurred_at, created_by)
           VALUES (?, ?, ?, ?, 60000, 'x', FALSE, 'PENDING_APPROVAL', ?, ?)`,
          [randomId(), code('DEP-'), r.siteId, r.categoryId, T('2026-11-02'), r.admin],
        ),
      ).rejects.toThrow(/ck_finance_expenses_state/);
      const id = randomId();
      const out = await movement(conn, r, { type: 'EXPENSE', docId: id });
      await expect(
        conn.query(
          `INSERT INTO finance_expenses (id, doc_number, site_id, category_id, amount_xaf, description, paid_now,
             paid_from_account_id, paid_at, paid_by, cash_movement_id, status, occurred_at, created_by)
           VALUES (?, ?, ?, ?, 1000, 'x', TRUE, ?, ?, ?, ?, 'PAID_REJECTED', ?, ?)`,
          [
            id,
            code('DEP-'),
            r.siteId,
            r.categoryId,
            r.accountId,
            T('2026-11-02'),
            r.admin,
            out,
            T('2026-11-02'),
            r.admin,
          ],
        ),
      ).rejects.toThrow(/ck_finance_expenses_state/);
    }));

  it('saisie immuable, annulation motivée, aucune suppression', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const id = await recordedExpense(conn, r);
      await expect(
        conn.query(`UPDATE finance_expenses SET amount_xaf = 2000 WHERE id = ?`, [id]),
      ).rejects.toThrow(/saisie immuable/);
      await expect(
        conn.query(`UPDATE finance_expenses SET status = 'CANCELLED' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_finance_expenses_state/);
      await conn.query(
        `UPDATE finance_expenses SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = 'Doublon'
         WHERE id = ?`,
        [T('2026-11-03'), r.admin, id],
      );
      await expect(
        conn.query(`UPDATE finance_expenses SET status = 'RECORDED' WHERE id = ?`, [id]),
      ).rejects.toThrow(/état terminal/);
      await expect(conn.query(`DELETE FROM finance_expenses WHERE id = ?`, [id])).rejects.toThrow(
        /suppression interdite/,
      );
    }));
});

describe('finance_supplier_invoices (SM-SUPPLIER-INVOICE, INV-FIN-07)', () => {
  it('payé borné par le total et cohérent avec le statut', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const id = await invoice(conn, r, { ref: code('R') });
      await expect(
        conn.query(
          `UPDATE finance_supplier_invoices SET status = 'PAID', paid_xaf = 1425001 WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/ck_finance_supplier_invoices_(amounts|state)/);
      await expect(
        conn.query(`UPDATE finance_supplier_invoices SET paid_xaf = 1000 WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_finance_supplier_invoices_state/);
      await conn.query(
        `UPDATE finance_supplier_invoices SET status = 'PARTIALLY_PAID', paid_xaf = 1000 WHERE id = ?`,
        [id],
      );
      await conn.query(
        `UPDATE finance_supplier_invoices SET status = 'PAID', paid_xaf = 1425000 WHERE id = ?`,
        [id],
      );
    }));

  it('écart non payé ; approuvée sans approbateur refusée', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const id = await invoice(conn, r, { ref: code('R'), status: 'MISMATCH' });
      await expect(
        conn.query(`UPDATE finance_supplier_invoices SET status = 'APPROVED' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_finance_supplier_invoices_state/);
      await expect(
        conn.query(`UPDATE finance_supplier_invoices SET paid_xaf = 10 WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_finance_supplier_invoices_state/);
    }));

  it('référence unique parmi les factures non annulées : la rectificative reprend la référence (AV-272)', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const ref = code('R');
      const first = await invoice(conn, r, { ref, status: 'DISPUTED' });
      await expect(invoice(conn, r, { ref })).rejects.toThrow(
        /uq_finance_supplier_invoices_active_ref|disputed/,
      );
      await conn.query(
        `UPDATE finance_supplier_invoices SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
           cancel_reason = 'Avoir de 3 sacs' WHERE id = ?`,
        [T('2026-11-02'), r.admin, first],
      );
      await invoice(conn, r, { ref });
      await expect(
        conn.query(`UPDATE finance_supplier_invoices SET comment = 'x' WHERE id = ?`, [first]),
      ).rejects.toThrow(/finance_supplier_invoices : facture/);
      await expect(
        conn.query(`DELETE FROM finance_supplier_invoices WHERE id = ?`, [first]),
      ).rejects.toThrow(/suppression interdite/);
    }));

  it('échéance postérieure à la date de facture ; lignes de BC chiffrées et immuables', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      await expect(invoice(conn, r, { ref: code('R'), due: '2026-10-31' })).rejects.toThrow(
        /ck_finance_supplier_invoices_dates/,
      );
      const id = await invoice(conn, r, { ref: code('R') });
      const lineId = randomId();
      await conn.query(
        `INSERT INTO finance_supplier_invoice_lines (id, invoice_id, line_no, description, line_total_xaf)
         VALUES (?, ?, 1, 'Transport', 20000)`,
        [lineId, id],
      );
      await expect(
        conn.query(`UPDATE finance_supplier_invoice_lines SET line_total_xaf = 1 WHERE id = ?`, [
          lineId,
        ]),
      ).rejects.toThrow(/lignes immuables/);
      await expect(
        conn.query(`DELETE FROM finance_supplier_invoice_lines WHERE id = ?`, [lineId]),
      ).rejects.toThrow(/suppression interdite/);
    }));
});

describe('finance_supplier_payments et affectations (SM-SUPPLIER-PAYMENT, INV-FIN-07)', () => {
  it('en attente : ni décaissement ni demande manquante ; enregistré : décaissé', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      await expect(
        conn.query(
          `INSERT INTO finance_supplier_payments (id, doc_number, supplier_id, amount_xaf, payment_method_code,
             from_account_id, status, unallocated_xaf, occurred_at, created_by)
           VALUES (?, ?, ?, 1425000, 'VIREMENT', ?, 'PENDING_APPROVAL', 0, ?, ?)`,
          [randomId(), code('PF-'), r.supplierId, r.accountId, T('2026-11-02'), r.admin],
        ),
      ).rejects.toThrow(/ck_finance_supplier_payments_state/);
      await expect(
        conn.query(
          `INSERT INTO finance_supplier_payments (id, doc_number, supplier_id, amount_xaf, payment_method_code,
             from_account_id, status, unallocated_xaf, occurred_at, created_by)
           VALUES (?, ?, ?, 1000, 'VIREMENT', ?, 'RECORDED', 2000, ?, ?)`,
          [randomId(), code('PF-'), r.supplierId, r.accountId, T('2026-11-02'), r.admin],
        ),
      ).rejects.toThrow(/ck_finance_supplier_payments_(amounts|state)/);
      const id = await payment(conn, r);
      await expect(
        conn.query(`UPDATE finance_supplier_payments SET amount_xaf = 1 WHERE id = ?`, [id]),
      ).rejects.toThrow(/paiement immuable/);
      // Annulation : mouvement inverse exigé.
      await expect(
        conn.query(
          `UPDATE finance_supplier_payments SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
             cancel_reason = 'Virement rejeté' WHERE id = ?`,
          [T('2026-11-03'), r.admin, id],
        ),
      ).rejects.toThrow(/ck_finance_supplier_payments_state/);
      await expect(
        conn.query(`DELETE FROM finance_supplier_payments WHERE id = ?`, [id]),
      ).rejects.toThrow(/suppression interdite/);
    }));

  it('affectation : une seule active par facture et par paiement ; PLANNED → ACTIVE → REVERSED, jamais en arrière', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const inv = await invoice(conn, r, { ref: code('R') });
      const pay = await payment(conn, r);
      const allocation = randomId();
      await conn.query(
        `INSERT INTO finance_supplier_payment_allocations (id, payment_id, invoice_id, amount_xaf, status, created_by)
         VALUES (?, ?, ?, 1425000, 'PLANNED', ?)`,
        [allocation, pay, inv, r.admin],
      );
      await expect(
        conn.query(
          `INSERT INTO finance_supplier_payment_allocations (id, payment_id, invoice_id, amount_xaf, status, created_by)
           VALUES (?, ?, ?, 1, 'PLANNED', ?)`,
          [randomId(), pay, inv, r.admin],
        ),
      ).rejects.toThrow(/uq_finance_supplier_payment_allocations_active/);
      await expect(
        conn.query(
          `UPDATE finance_supplier_payment_allocations SET status = 'ACTIVE' WHERE id = ?`,
          [allocation],
        ),
      ).rejects.toThrow(/ck_finance_supplier_payment_allocations_state/);
      await conn.query(
        `UPDATE finance_supplier_payment_allocations SET status = 'ACTIVE', activated_at = ? WHERE id = ?`,
        [T('2026-11-02'), allocation],
      );
      await expect(
        conn.query(
          `UPDATE finance_supplier_payment_allocations SET status = 'PLANNED' WHERE id = ?`,
          [allocation],
        ),
      ).rejects.toThrow(/seul le passage/);
      await expect(
        conn.query(`UPDATE finance_supplier_payment_allocations SET amount_xaf = 1 WHERE id = ?`, [
          allocation,
        ]),
      ).rejects.toThrow(/affectation immuable/);
      await conn.query(
        `UPDATE finance_supplier_payment_allocations SET status = 'REVERSED', reversed_at = ?, reversed_by = ?,
           reversal_reason = 'Paiement annulé' WHERE id = ?`,
        [T('2026-11-03'), r.admin, allocation],
      );
      // Contrepassée : la facture peut recevoir une nouvelle affectation du même paiement.
      await conn.query(
        `INSERT INTO finance_supplier_payment_allocations (id, payment_id, invoice_id, amount_xaf, status, created_by)
         VALUES (?, ?, ?, 1, 'PLANNED', ?)`,
        [randomId(), pay, inv, r.admin],
      );
      await expect(
        conn.query(`DELETE FROM finance_supplier_payment_allocations WHERE id = ?`, [allocation]),
      ).rejects.toThrow(/suppression interdite/);
    }));
});

describe('finance_v_payables (BR-FIN-032, KPI-FIN-05)', () => {
  it('factures approuvées non soldées seulement, solde et jours de retard au jour de Douala', () =>
    withRollback(async (conn) => {
      const r = await refs(conn);
      const due = await invoice(conn, r, { ref: code('R'), due: '2026-11-01' });
      const notDue = await invoice(conn, r, { ref: code('R'), due: '2999-12-31' });
      const partial = await invoice(conn, r, { ref: code('R'), total: 100_000 });
      await conn.query(
        `UPDATE finance_supplier_invoices SET status = 'PARTIALLY_PAID', paid_xaf = 40000 WHERE id = ?`,
        [partial],
      );
      const paid = await invoice(conn, r, { ref: code('R'), total: 100_000 });
      await conn.query(
        `UPDATE finance_supplier_invoices SET status = 'PAID', paid_xaf = 100000 WHERE id = ?`,
        [paid],
      );
      await invoice(conn, r, { ref: code('R'), status: 'MISMATCH' });
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT invoice_id, balance_xaf, days_overdue,
           DATEDIFF(CAST(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+01:00') AS DATE), due_date) AS expected_days
         FROM finance_v_payables WHERE supplier_id = ? ORDER BY balance_xaf`,
        [r.supplierId],
      );
      expect(
        rows.map((row) => [Buffer.from(row.invoice_id).equals(partial), Number(row.balance_xaf)]),
      ).toEqual([
        [true, 60_000],
        [false, 1_425_000],
        [false, 1_425_000],
      ]);
      const byId = (id: Buffer) => rows.find((row) => Buffer.from(row.invoice_id).equals(id))!;
      expect(Number(byId(notDue).days_overdue)).toBe(0);
      expect(Number(byId(due).days_overdue)).toBe(Math.max(0, Number(byId(due).expected_days)));
    }));
});

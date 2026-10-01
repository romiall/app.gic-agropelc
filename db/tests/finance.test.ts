// Contraintes de base du socle de trésorerie (P4-02) : une caisse de PDV active par site, une
// caisse utilisateur active par détenteur (BR-FIN-010), registre des mouvements en ajout seul
// avec inverse unique (BR-FIN-011, INV-FIN-01), moyens de paiement désactivables mais jamais
// supprimés. Chaque test crée ses propres référentiels dans une transaction annulée.
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
  return { admin, siteId };
}

function insertAccount(
  conn: PoolConnection,
  refs: Refs,
  input: {
    readonly type: string;
    readonly siteId?: Buffer | null;
    readonly holder?: Buffer | null;
    readonly status?: string;
  },
) {
  const id = randomId();
  return conn
    .query(
      `INSERT INTO finance_cash_accounts (id, code, name, account_type, site_id, holder_user_id, responsible_user_id,
         status, created_by)
       VALUES (?, ?, 'Caisse', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        randomCode('CPT'),
        input.type,
        input.siteId ?? null,
        input.holder ?? null,
        refs.admin,
        input.status ?? 'ACTIVE',
        refs.admin,
      ],
    )
    .then(() => id);
}

function insertMovement(
  conn: PoolConnection,
  refs: Refs,
  accountId: Buffer,
  input: { readonly amount?: number; readonly reverses?: Buffer | null } = {},
) {
  const id = randomId();
  return conn
    .query(
      `INSERT INTO finance_cash_movements (id, cash_account_id, direction, amount_xaf, movement_type, source_doc_type,
         source_doc_id, occurred_at, is_reversal, reverses_movement_id, created_by)
       VALUES (?, ?, ?, ?, 'CUSTOMER_PAYMENT', 'CUSTOMER_PAYMENT', ?, ?, ?, ?, ?)`,
      [
        id,
        accountId,
        input.reverses ? 'OUT' : 'IN',
        input.amount ?? 5000,
        randomId(),
        T0,
        input.reverses ? 1 : 0,
        input.reverses ?? null,
        refs.admin,
      ],
    )
    .then(() => id);
}

describe('socle de trésorerie (P4-02)', () => {
  it('BR-FIN-010 : une caisse de PDV active par site, une caisse utilisateur active par détenteur', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await insertAccount(conn, refs, { type: 'CAISSE_PDV', siteId: refs.siteId });
      await expect(
        insertAccount(conn, refs, { type: 'CAISSE_PDV', siteId: refs.siteId }),
      ).rejects.toThrow(/uq_finance_cash_accounts_active_pos_site/);
      // Une caisse inactive ne compte pas.
      await insertAccount(conn, refs, {
        type: 'CAISSE_PDV',
        siteId: refs.siteId,
        status: 'INACTIVE',
      });
      await insertAccount(conn, refs, { type: 'CAISSE_UTILISATEUR', holder: refs.admin });
      await expect(
        insertAccount(conn, refs, { type: 'CAISSE_UTILISATEUR', holder: refs.admin }),
      ).rejects.toThrow(/uq_finance_cash_accounts_active_user_holder/);
      await expect(insertAccount(conn, refs, { type: 'CAISSE_PDV' })).rejects.toThrow(
        /ck_finance_cash_accounts_pos_site/,
      );
      await expect(insertAccount(conn, refs, { type: 'CAISSE_UTILISATEUR' })).rejects.toThrow(
        /ck_finance_cash_accounts_user_holder/,
      );
      await expect(insertAccount(conn, refs, { type: 'COFFRE' })).rejects.toThrow(
        /ck_finance_cash_accounts_type/,
      );
    });
  });

  it('BR-FIN-011 : mouvements positifs, en ajout seul, inverse unique', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const accountId = await insertAccount(conn, refs, {
        type: 'CAISSE_UTILISATEUR',
        holder: refs.admin,
      });
      const movementId = await insertMovement(conn, refs, accountId);
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT DATE_FORMAT(business_date, '%Y-%m-%d') AS d FROM finance_cash_movements WHERE id = ?",
        [movementId],
      );
      expect(rows[0]!.d).toBe('2026-10-01');
      await expect(insertMovement(conn, refs, accountId, { amount: 0 })).rejects.toThrow(
        /ck_finance_cash_movements_amount/,
      );
      await expect(
        conn.query('UPDATE finance_cash_movements SET amount_xaf = 6000 WHERE id = ?', [
          movementId,
        ]),
      ).rejects.toThrow(/registre immuable/);
      await expect(
        conn.query('DELETE FROM finance_cash_movements WHERE id = ?', [movementId]),
      ).rejects.toThrow(/suppression interdite/);
      await insertMovement(conn, refs, accountId, { reverses: movementId });
      await expect(insertMovement(conn, refs, accountId, { reverses: movementId })).rejects.toThrow(
        /uq_finance_cash_movements_reverses/,
      );
      await expect(
        conn.query(
          `INSERT INTO finance_cash_movements (id, cash_account_id, direction, amount_xaf, movement_type, source_doc_type,
             source_doc_id, occurred_at, is_reversal, created_by)
           VALUES (?, ?, 'OUT', 10, 'REFUND', 'SALE_REFUND', ?, ?, TRUE, ?)`,
          [randomId(), accountId, randomId(), T0, refs.admin],
        ),
      ).rejects.toThrow(/ck_finance_cash_movements_reversal/);
    });
  });

  it('moyens de paiement et comptes : désactivation, jamais de suppression', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const code = randomCode('MP_');
      await conn.query(
        `INSERT INTO finance_payment_methods (code, label, requires_reference, default_account_type)
         VALUES (?, 'Test', TRUE, 'MOBILE_MONEY')`,
        [code],
      );
      await conn.query('UPDATE finance_payment_methods SET is_active = FALSE WHERE code = ?', [
        code,
      ]);
      await expect(
        conn.query('DELETE FROM finance_payment_methods WHERE code = ?', [code]),
      ).rejects.toThrow(/suppression interdite/);
      await expect(
        conn.query(
          `INSERT INTO finance_payment_methods (code, label, default_account_type) VALUES (?, 'Test', 'TIROIR')`,
          [randomCode('MP_')],
        ),
      ).rejects.toThrow(/ck_finance_payment_methods_account_type/);
      const accountId = await insertAccount(conn, refs, { type: 'BANQUE' });
      await expect(
        conn.query('DELETE FROM finance_cash_accounts WHERE id = ?', [accountId]),
      ).rejects.toThrow(/suppression interdite/);
    });
  });
});

// Cohérence d'état d'une remise de fonds après la migration 20261010092000 (P5-15 ; ADR-032 §7 ;
// SM-CASH-TRANSFER ; AV-174, AV-175) : réception de 0 XAF sans entrée de trésorerie, entrée exigée
// pour un montant reçu positif, motif exigé à la clôture d'un écart, aucune entrée pour une remise
// annulée. Chaque test crée ses données dans une transaction annulée.
import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { randomId, withRollback, freshPhone } from './helpers.js';

const T = (hhmm: string) => `2026-10-08 ${hhmm}:00.000000`;
const code = (prefix: string) => `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;

interface Fixture {
  readonly sender: Buffer;
  readonly receiver: Buffer;
  readonly pos: Buffer;
  readonly central: Buffer;
  readonly transferId: Buffer;
}

async function user(conn: PoolConnection): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
    [id, await freshPhone(conn), id],
  );
  return id;
}

async function account(conn: PoolConnection, type: string, owner: Buffer): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO finance_cash_accounts (id, code, name, account_type, holder_user_id, responsible_user_id, created_by)
     VALUES (?, ?, 'Compte', ?, ?, ?, ?)`,
    [id, code('CPT'), type, type === 'CAISSE_UTILISATEUR' ? owner : null, owner, owner],
  );
  return id;
}

async function movement(
  conn: PoolConnection,
  accountId: Buffer,
  transferId: Buffer,
  input: { readonly type: 'TRANSFER_OUT' | 'TRANSFER_IN'; readonly direction: 'IN' | 'OUT' },
  author: Buffer,
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO finance_cash_movements (id, cash_account_id, direction, amount_xaf, movement_type, source_doc_type,
       source_doc_id, occurred_at, created_by)
     VALUES (?, ?, ?, 1000, ?, 'CASH_TRANSFER', ?, ?, ?)`,
    [id, accountId, input.direction, input.type, transferId, T('18:00'), author],
  );
  return id;
}

/** Une remise `CAISSE_UTILISATEUR` → `CAISSE_CENTRALE` de 1 000 XAF, envoyée. */
async function sentTransfer(conn: PoolConnection): Promise<Fixture> {
  const sender = await user(conn);
  const receiver = await user(conn);
  const pos = await account(conn, 'CAISSE_UTILISATEUR', sender);
  const central = await account(conn, 'CAISSE_CENTRALE', receiver);
  const transferId = randomId();
  const out = await movement(
    conn,
    pos,
    transferId,
    { type: 'TRANSFER_OUT', direction: 'OUT' },
    sender,
  );
  await conn.query(
    `INSERT INTO finance_cash_transfers (id, doc_number, from_account_id, to_account_id, amount_sent_xaf, sent_by, sent_at,
       out_movement_id, occurred_at, created_by)
     VALUES (?, ?, ?, ?, 1000, ?, ?, ?, ?, ?)`,
    [transferId, code('RMF-'), pos, central, sender, T('18:00'), out, T('18:00'), sender],
  );
  return { sender, receiver, pos, central, transferId };
}

const receiveSql = `UPDATE finance_cash_transfers SET status = 'DISCREPANCY_PENDING', amount_received_xaf = ?,
  discrepancy_xaf = ?, received_by = ?, received_at = ?, in_movement_id = ? WHERE id = ?`;

describe('finance_cash_transfers : réception de 0 et clôture (migration 20261010092000)', () => {
  it('remise perdue : DISCREPANCY_PENDING reçue à 0 sans entrée de trésorerie (AV-175)', () =>
    withRollback(async (conn) => {
      const f = await sentTransfer(conn);
      await conn.query(receiveSql, [0, -1000, f.receiver, T('19:00'), null, f.transferId]);
      // Clôture avec imputation et motif, toujours sans entrée.
      await conn.query(
        `UPDATE finance_cash_transfers SET status = 'CLOSED', imputation = 'CARRIER', closing_reason = 'Perdue en route',
           closed_by = ?, closed_at = ? WHERE id = ?`,
        [f.sender, T('20:00'), f.transferId],
      );
    }));

  it('reçu 0 avec une entrée de trésorerie : refusé', () =>
    withRollback(async (conn) => {
      const f = await sentTransfer(conn);
      const entry = await movement(
        conn,
        f.central,
        f.transferId,
        { type: 'TRANSFER_IN', direction: 'IN' },
        f.receiver,
      );
      await expect(
        conn.query(receiveSql, [0, -1000, f.receiver, T('19:00'), entry, f.transferId]),
      ).rejects.toThrow(/ck_finance_cash_transfers_(state|in_movement)/);
    }));

  it('reçu positif sans entrée de trésorerie : refusé', () =>
    withRollback(async (conn) => {
      const f = await sentTransfer(conn);
      await expect(
        conn.query(receiveSql, [900, -100, f.receiver, T('19:00'), null, f.transferId]),
      ).rejects.toThrow(/ck_finance_cash_transfers_state/);
    }));

  it('clôture sans motif : refusée ; avec imputation et motif : admise, puis terminale', () =>
    withRollback(async (conn) => {
      const f = await sentTransfer(conn);
      const entry = await movement(
        conn,
        f.central,
        f.transferId,
        { type: 'TRANSFER_IN', direction: 'IN' },
        f.receiver,
      );
      await conn.query(receiveSql, [900, -100, f.receiver, T('19:00'), entry, f.transferId]);
      await expect(
        conn.query(
          `UPDATE finance_cash_transfers SET status = 'CLOSED', imputation = 'COMPANY', closed_by = ?, closed_at = ?
           WHERE id = ?`,
          [f.sender, T('20:00'), f.transferId],
        ),
      ).rejects.toThrow(/ck_finance_cash_transfers_state/);
      await conn.query(
        `UPDATE finance_cash_transfers SET status = 'CLOSED', imputation = 'COMPANY', closing_reason = 'Erreur de rendu',
           closed_by = ?, closed_at = ? WHERE id = ?`,
        [f.sender, T('20:00'), f.transferId],
      );
      await expect(
        conn.query(
          `UPDATE finance_cash_transfers SET status = 'DISCREPANCY_PENDING' WHERE id = ?`,
          [f.transferId],
        ),
      ).rejects.toThrow(/terminée|terminal/);
    }));

  it('remise annulée portant une entrée de trésorerie : refusée', () =>
    withRollback(async (conn) => {
      const f = await sentTransfer(conn);
      const reversal = await movement(
        conn,
        f.pos,
        f.transferId,
        { type: 'TRANSFER_OUT', direction: 'IN' },
        f.sender,
      );
      const entry = await movement(
        conn,
        f.central,
        f.transferId,
        { type: 'TRANSFER_IN', direction: 'IN' },
        f.receiver,
      );
      await expect(
        conn.query(
          `UPDATE finance_cash_transfers SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_reason = 'Erreur',
             cancel_movement_id = ?, in_movement_id = ? WHERE id = ?`,
          [f.sender, T('19:00'), reversal, entry, f.transferId],
        ),
      ).rejects.toThrow(/ck_finance_cash_transfers_state/);
      await conn.query(
        `UPDATE finance_cash_transfers SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_reason = 'Erreur',
           cancel_movement_id = ? WHERE id = ?`,
        [f.sender, T('19:00'), reversal, f.transferId],
      );
    }));
});

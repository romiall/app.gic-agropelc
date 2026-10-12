// Garde en base des transferts de stock après P5-16 (migration 20261010093000 ; BR-STK-024,
// BR-STK-025, SM-TRANSFER, INV-STK-08, INV-GLO-03) : nature `BLIND_RECEIPT` enfin inscriptible,
// cohérence nature / statut, rapprochement (un transfert n'est rapproché que d'une seule réception),
// colonnes de retour, conflit de délai propre aux réceptions sans document, ligne-verrou de paire.
// Insertions directes qui contournent l'application : chaque refus est prouvé par la base elle-même.
import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { randomId, withRollback, freshPhone } from './helpers.js';

const T0 = '2026-10-09 08:00:00.000000';

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

interface Refs {
  readonly admin: Buffer;
  readonly siteId: Buffer;
  readonly from: Buffer;
  readonly to: Buffer;
}

async function setup(conn: PoolConnection): Promise<Refs> {
  const admin = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
    [admin, await freshPhone(conn), admin],
  );
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, randomCode('Z'), admin],
  );
  const siteId = randomId();
  await conn.query(
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by)
     VALUES (?, ?, 'Magasin', 'MAGASIN', ?, ?)`,
    [siteId, randomCode('S'), zoneId, admin],
  );
  const location = async (type: string, custody: string): Promise<Buffer> => {
    const id = randomId();
    await conn.query(
      `INSERT INTO organization_locations (id, site_id, code, name, location_type, custody_mode, created_by)
       VALUES (?, ?, ?, 'Emplacement', ?, ?, ?)`,
      [id, siteId, randomCode('L'), type, custody, admin],
    );
    return id;
  };
  return {
    admin,
    siteId,
    from: await location('STORE', 'SHARED'),
    to: await location('POS', 'SHARED'),
  };
}

async function insertTransfer(
  conn: PoolConnection,
  refs: Refs,
  values: {
    readonly kind?: string;
    readonly status: string;
    readonly matchedTransferId?: Buffer | null;
    readonly matchedAt?: string | null;
    readonly returnedBy?: Buffer | null;
    readonly returnedAt?: string | null;
    readonly returnReason?: string | null;
    readonly signalledAt?: string | null;
  },
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO inventory_stock_transfers
       (id, doc_number, site_id, transfer_kind, from_location_id, to_location_id, status,
        matched_transfer_id, matched_at, returned_by, returned_at, return_reason, unmatched_signalled_at,
        occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      randomCode('TRF-'),
      refs.siteId,
      values.kind ?? 'STANDARD',
      refs.from,
      refs.to,
      values.status,
      values.matchedTransferId ?? null,
      values.matchedAt ?? null,
      values.returnedBy ?? null,
      values.returnedAt ?? null,
      values.returnReason ?? null,
      values.signalledAt ?? null,
      T0,
      refs.admin,
    ],
  );
  return id;
}

describe('inventory_stock_transfers après P5-16 (BR-STK-024, BR-STK-025)', () => {
  it('transfer_kind accepte BLIND_RECEIPT (13 caractères) au statut UNMATCHED', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertTransfer(conn, refs, { kind: 'BLIND_RECEIPT', status: 'UNMATCHED' });
      const [rows] = await conn.query(
        'SELECT transfer_kind FROM inventory_stock_transfers WHERE id = ?',
        [id],
      );
      expect((rows as Array<{ transfer_kind: string }>)[0]?.transfer_kind).toBe('BLIND_RECEIPT');
    });
  });

  it('cohérence nature / statut (ck_inventory_stock_transfers_kind_status)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      for (const [kind, status] of [
        ['BLIND_RECEIPT', 'DISPATCHED'],
        ['STANDARD', 'UNMATCHED'],
        ['INTERNAL', 'RECEIVED'],
      ] as const) {
        await expect(insertTransfer(conn, refs, { kind, status })).rejects.toThrow(
          /ck_inventory_stock_transfers_kind_status/,
        );
      }
    });
  });

  it('MATCHED exige matched_transfer_id et matched_at ; aucun autre statut ne les porte', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const dispatched = await insertTransfer(conn, refs, { status: 'RECEIVED' });
      await expect(
        insertTransfer(conn, refs, { kind: 'BLIND_RECEIPT', status: 'MATCHED' }),
      ).rejects.toThrow(/ck_inventory_stock_transfers_matched/);
      await expect(
        insertTransfer(conn, refs, {
          kind: 'BLIND_RECEIPT',
          status: 'UNMATCHED',
          matchedTransferId: dispatched,
          matchedAt: T0,
        }),
      ).rejects.toThrow(/ck_inventory_stock_transfers_matched/);
      await insertTransfer(conn, refs, {
        kind: 'BLIND_RECEIPT',
        status: 'MATCHED',
        matchedTransferId: dispatched,
        matchedAt: T0,
      });
    });
  });

  it('un transfert n’est rapproché que d’une seule réception (UNIQUE, INV-STK-08)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const dispatched = await insertTransfer(conn, refs, { status: 'RECEIVED' });
      const matched = {
        kind: 'BLIND_RECEIPT',
        status: 'MATCHED',
        matchedTransferId: dispatched,
        matchedAt: T0,
      };
      await insertTransfer(conn, refs, matched);
      await expect(insertTransfer(conn, refs, matched)).rejects.toThrow(
        /uq_inventory_stock_transfers_matched/,
      );
    });
  });

  it('RETURNED exige auteur, date et motif ; aucun autre statut ne les porte', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      for (const missing of ['returnedBy', 'returnedAt', 'returnReason'] as const) {
        const full = { returnedBy: refs.admin, returnedAt: T0, returnReason: 'Panne' };
        await expect(
          insertTransfer(conn, refs, { status: 'RETURNED', ...full, [missing]: null }),
        ).rejects.toThrow(/ck_inventory_stock_transfers_returned/);
      }
      await expect(
        insertTransfer(conn, refs, { status: 'DISPATCHED', returnReason: 'Panne' }),
      ).rejects.toThrow(/ck_inventory_stock_transfers_returned/);
      await insertTransfer(conn, refs, {
        status: 'RETURNED',
        returnedBy: refs.admin,
        returnedAt: T0,
        returnReason: 'Panne',
      });
    });
  });

  it('conflit de délai : unmatched_signalled_at réservé aux réceptions sans document', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(
        insertTransfer(conn, refs, { status: 'DISPATCHED', signalledAt: T0 }),
      ).rejects.toThrow(/ck_inventory_stock_transfers_signalled/);
      await insertTransfer(conn, refs, {
        kind: 'BLIND_RECEIPT',
        status: 'UNMATCHED',
        signalledAt: T0,
      });
    });
  });

  it('suppression physique toujours refusée (trg_inventory_stock_transfers_no_delete, INV-GLO-03)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertTransfer(conn, refs, { kind: 'BLIND_RECEIPT', status: 'UNMATCHED' });
      await expect(
        conn.query('DELETE FROM inventory_stock_transfers WHERE id = ?', [id]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });

  it('ligne-verrou de paire : une seule par (source, destination)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      await conn.query(
        'INSERT INTO inventory_transfer_pair_locks (from_location_id, to_location_id) VALUES (?, ?)',
        [refs.from, refs.to],
      );
      await expect(
        conn.query(
          'INSERT INTO inventory_transfer_pair_locks (from_location_id, to_location_id) VALUES (?, ?)',
          [refs.from, refs.to],
        ),
      ).rejects.toThrow(/Duplicate entry/);
      // Upsert sans effet (motif du verrou applicatif) : accepté.
      await conn.query(
        `INSERT INTO inventory_transfer_pair_locks (from_location_id, to_location_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE from_location_id = from_location_id`,
        [refs.from, refs.to],
      );
    });
  });
});

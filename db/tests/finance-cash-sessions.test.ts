// Contraintes de base des sessions de caisse, de leurs ajustements et des remises de fonds (P5-03 ;
// ADR-032) : INV-FIN-05 (session VALIDATED figée), INV-FIN-06 (une session OPEN par compte),
// fenêtres sans chevauchement (filet), écart de clôture exact, ajustement = delta, cohérence d'état
// d'une remise, clés étrangères de `cash_session_id`. Chaque test crée ses données dans une
// transaction annulée.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomId, withRollback, freshPhone } from './helpers.js';

const T = (hhmm: string, day = '2026-10-08') => `${day} ${hhmm}:00.000000`;

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

interface Refs {
  readonly admin: Buffer;
  readonly other: Buffer;
  readonly siteId: Buffer;
  readonly accountId: Buffer;
  readonly centralId: Buffer;
}

async function setup(conn: PoolConnection): Promise<Refs> {
  const user = async (): Promise<Buffer> => {
    const id = randomId();
    await conn.query(
      `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
       VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
      [id, await freshPhone(conn), id],
    );
    return id;
  };
  const admin = await user();
  const other = await user();
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, randomCode('Z'), admin],
  );
  const siteId = randomId();
  await conn.query(
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by)
     VALUES (?, ?, 'PDV', 'POINT_DE_VENTE', ?, ?)`,
    [siteId, randomCode('S'), zoneId, admin],
  );
  const account = async (type: string, site: Buffer | null): Promise<Buffer> => {
    const id = randomId();
    await conn.query(
      `INSERT INTO finance_cash_accounts (id, code, name, account_type, site_id, responsible_user_id, created_by)
       VALUES (?, ?, 'Caisse', ?, ?, ?, ?)`,
      [id, randomCode('CPT'), type, site, admin, admin],
    );
    return id;
  };
  return {
    admin,
    other,
    siteId,
    accountId: await account('CAISSE_PDV', siteId),
    centralId: await account('CAISSE_CENTRALE', null),
  };
}

async function openSession(
  conn: PoolConnection,
  refs: Refs,
  input: {
    readonly openedAt?: string;
    readonly accountId?: Buffer;
    readonly counted?: number;
    readonly expected?: number;
  } = {},
): Promise<Buffer> {
  const id = randomId();
  const counted = input.counted ?? 20_000;
  const expected = input.expected ?? 20_000;
  await conn.query(
    `INSERT INTO finance_cash_sessions (id, cash_account_id, site_id, opened_by, opened_at, opening_counted_xaf,
       opening_expected_xaf, opening_variance_xaf, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.accountId ?? refs.accountId,
      refs.siteId,
      refs.admin,
      input.openedAt ?? T('07:00'),
      counted,
      expected,
      counted - expected,
      refs.admin,
    ],
  );
  return id;
}

/** Clôture cohérente : écart exact ; `PENDING_VALIDATION` ou `VALIDATED` d'office. */
function closeSession(
  conn: PoolConnection,
  refs: Refs,
  id: Buffer,
  input: {
    readonly closedAt?: string;
    readonly counted?: number;
    readonly expected?: number;
    readonly status?: string;
  } = {},
) {
  const counted = input.counted ?? 193_000;
  const expected = input.expected ?? 193_500;
  const status = input.status ?? 'PENDING_VALIDATION';
  return conn.query(
    `UPDATE finance_cash_sessions
       SET status = ?, closed_by = ?, closed_at = ?, closing_counted_xaf = ?, closing_expected_xaf = ?, variance_xaf = ?,
           auto_validated = ?, validated_at = ?
     WHERE id = ?`,
    [
      status,
      refs.other,
      input.closedAt ?? T('18:00'),
      counted,
      expected,
      counted - expected,
      status === 'VALIDATED' ? 1 : 0,
      status === 'VALIDATED' ? (input.closedAt ?? T('18:00')) : null,
      id,
    ],
  );
}

async function insertMovement(
  conn: PoolConnection,
  refs: Refs,
  accountId: Buffer,
  input: { readonly sessionId?: Buffer | null; readonly type?: string } = {},
) {
  const id = randomId();
  const type = input.type ?? 'SESSION_VARIANCE';
  await conn.query(
    `INSERT INTO finance_cash_movements (id, cash_account_id, direction, amount_xaf, movement_type, source_doc_type,
       source_doc_id, cash_session_id, occurred_at, created_by)
     VALUES (?, ?, 'OUT', 500, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      accountId,
      type,
      type === 'TRANSFER_OUT' ? 'CASH_TRANSFER' : 'CASH_SESSION',
      randomId(),
      input.sessionId ?? null,
      T('18:00'),
      refs.admin,
    ],
  );
  return id;
}

describe('finance_cash_sessions (INV-FIN-05, INV-FIN-06)', () => {
  it('ouvre une session ; le jour métier est celui de Douala (UTC+1)', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await openSession(conn, refs, { openedAt: '2026-10-08 23:30:00.000000' });
      const [[row]] = await conn.query<RowDataPacket[]>(
        "SELECT DATE_FORMAT(business_date, '%Y-%m-%d') AS d, status FROM finance_cash_sessions WHERE id = ?",
        [id],
      );
      expect(row!.d).toBe('2026-10-09');
      expect(row!.status).toBe('OPEN');
    }));

  it('INV-FIN-06 : un index unique garantit au plus une session OPEN par compte', () =>
    withRollback(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT NON_UNIQUE AS nu, COLUMN_NAME AS c FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'finance_cash_sessions'
            AND INDEX_NAME = 'uq_finance_cash_sessions_open_account'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.nu).toBe(0);
      expect(rows[0]!.c).toBe('open_account');
    }));

  it('refuse une seconde session ouverte sur le même compte (filet de chevauchement et index unique)', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await openSession(conn, refs);
      await expect(openSession(conn, refs, { openedAt: T('09:00') })).rejects.toThrow(
        /chevauchent|Duplicate/,
      );
    }));

  it('deux comptes distincts peuvent avoir chacun une session ouverte', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await openSession(conn, refs);
      await openSession(conn, refs, { accountId: refs.centralId });
    }));

  it('clôture : l’écart est exactement compté − attendu ; un écart inexact est refusé', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await openSession(conn, refs);
      await expect(
        conn.query(
          `UPDATE finance_cash_sessions SET status = 'PENDING_VALIDATION', closed_by = ?, closed_at = ?, closing_counted_xaf = 193000,
             closing_expected_xaf = 193500, variance_xaf = -400 WHERE id = ?`,
          [refs.other, T('18:00'), id],
        ),
      ).rejects.toThrow(/ck_finance_cash_sessions_closing/);
      await closeSession(conn, refs, id);
      const [[row]] = await conn.query<RowDataPacket[]>(
        'SELECT variance_xaf AS v, status FROM finance_cash_sessions WHERE id = ?',
        [id],
      );
      expect(Number(row!.v)).toBe(-500);
      expect(row!.status).toBe('PENDING_VALIDATION');
    }));

  it('une session ouverte ne porte aucune donnée de clôture ; une session close les porte toutes', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await openSession(conn, refs);
      await expect(
        conn.query(`UPDATE finance_cash_sessions SET closing_counted_xaf = 5 WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_finance_cash_sessions_closing/);
      await expect(
        conn.query(`UPDATE finance_cash_sessions SET status = 'PENDING_VALIDATION' WHERE id = ?`, [
          id,
        ]),
      ).rejects.toThrow(/ck_finance_cash_sessions_closing/);
    }));

  it('validation d’office : écart nul sans valideur ; sinon un valideur est exigé', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const auto = await openSession(conn, refs);
      await closeSession(conn, refs, auto, {
        counted: 193_500,
        expected: 193_500,
        status: 'VALIDATED',
      });
      const manual = await openSession(conn, refs, { accountId: refs.centralId });
      await expect(
        conn.query(
          `UPDATE finance_cash_sessions SET status = 'VALIDATED', closed_by = ?, closed_at = ?, closing_counted_xaf = 1,
             closing_expected_xaf = 1, variance_xaf = 0, validated_at = ? WHERE id = ?`,
          [refs.other, T('18:00'), T('18:00'), manual],
        ),
      ).rejects.toThrow(/ck_finance_cash_sessions_validation/);
    }));

  it('INV-FIN-05 : une session VALIDATED est figée (clôture, statut, validation)', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await openSession(conn, refs);
      await closeSession(conn, refs, id);
      await conn.query(
        `UPDATE finance_cash_sessions SET status = 'VALIDATED', validated_by = ?, validated_at = ? WHERE id = ?`,
        [refs.admin, T('19:00'), id],
      );
      await expect(
        conn.query(
          `UPDATE finance_cash_sessions SET closing_counted_xaf = 194000, variance_xaf = 500 WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/figée|clôture est figée/);
      await expect(
        conn.query(`UPDATE finance_cash_sessions SET status = 'PENDING_VALIDATION' WHERE id = ?`, [
          id,
        ]),
      ).rejects.toThrow(/figée/);
      await expect(
        conn.query(`UPDATE finance_cash_sessions SET validated_by = ? WHERE id = ?`, [
          refs.other,
          id,
        ]),
      ).rejects.toThrow(/figée/);
      // Seules les colonnes d'audit évoluent.
      await conn.query(`UPDATE finance_cash_sessions SET updated_by = ? WHERE id = ?`, [
        refs.admin,
        id,
      ]);
    }));

  it('une session close ne se rouvre pas, son ouverture est immuable, et elle ne se supprime pas', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await openSession(conn, refs);
      await expect(
        conn.query(
          `UPDATE finance_cash_sessions SET opening_counted_xaf = 1, opening_variance_xaf = 1 - 20000 WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/immuables/);
      await closeSession(conn, refs, id);
      await expect(
        conn.query(`UPDATE finance_cash_sessions SET status = 'OPEN' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_finance_cash_sessions_closing|rouvre/);
      await expect(
        conn.query(`DELETE FROM finance_cash_sessions WHERE id = ?`, [id]),
      ).rejects.toThrow(/suppression interdite/);
    }));

  it('fenêtres d’un même compte : bout à bout accepté, chevauchement refusé (filet)', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const first = await openSession(conn, refs, { openedAt: T('08:00') });
      await closeSession(conn, refs, first, { closedAt: T('18:00') });
      await expect(openSession(conn, refs, { openedAt: T('17:00') })).rejects.toThrow(
        /chevauchent/,
      );
      await openSession(conn, refs, { openedAt: T('18:00') });
    }));

  it('une clôture ne précède pas l’ouverture, et les comptes sont indépendants', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const first = await openSession(conn, refs, { openedAt: T('08:00') });
      await expect(closeSession(conn, refs, first, { closedAt: T('07:00') })).rejects.toThrow(
        /ck_finance_cash_sessions_closing/,
      );
      // Un autre compte, aux mêmes heures : aucune interférence.
      const other = await openSession(conn, refs, {
        openedAt: T('08:00'),
        accountId: refs.centralId,
      });
      await closeSession(conn, refs, other, { closedAt: T('20:00') });
    }));
});

describe('clés étrangères de cash_session_id', () => {
  it('un mouvement du registre ne cite qu’une session existante', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(
        insertMovement(conn, refs, refs.accountId, { sessionId: randomId() }),
      ).rejects.toThrow(/fk_finance_cash_movements_session/);
      const session = await openSession(conn, refs);
      await insertMovement(conn, refs, refs.accountId, { sessionId: session });
    }));

  it('les ventes et les encaissements ont leur clé étrangère vers la session', () =>
    withRollback(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS r FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'cash_session_id' AND REFERENCED_TABLE_NAME IS NOT NULL`,
      );
      const tables = rows.map((row) => row.t as string).sort();
      expect(tables).toEqual(['finance_cash_movements', 'sales_customer_payments', 'sales_sales']);
      expect(new Set(rows.map((row) => row.r as string))).toEqual(
        new Set(['finance_cash_sessions']),
      );
    }));
});

describe('finance_cash_session_adjustments (ADR-032 §6, INV-FIN-11)', () => {
  async function adjustmentSetup(conn: PoolConnection) {
    const refs = await setup(conn);
    const session = await openSession(conn, refs);
    await closeSession(conn, refs, session);
    const movement = await insertMovement(conn, refs, refs.accountId, { sessionId: session });
    return { refs, session, movement };
  }

  function insertAdjustment(
    conn: PoolConnection,
    ctx: { refs: Refs; session: Buffer; movement: Buffer },
    input: {
      readonly before?: number;
      readonly after?: number;
      readonly delta?: number;
      readonly movement?: Buffer;
    } = {},
  ) {
    const before = input.before ?? -500;
    const after = input.after ?? -1200;
    return conn.query(
      `INSERT INTO finance_cash_session_adjustments (id, session_id, movement_id, cause, variance_before_xaf,
         variance_after_xaf, delta_xaf, expected_after_xaf, treatment, applied_at, created_by)
       VALUES (?, ?, ?, 'LATE_OPERATION', ?, ?, ?, 194200, 'OWN_APPROVAL', ?, ?)`,
      [
        randomId(),
        ctx.session,
        input.movement ?? ctx.movement,
        before,
        after,
        input.delta ?? after - before,
        T('19:00'),
        ctx.refs.admin,
      ],
    );
  }

  it('enregistre le delta : après − avant, jamais nul', () =>
    withRollback(async (conn) => {
      const ctx = await adjustmentSetup(conn);
      await insertAdjustment(conn, ctx);
      await expect(insertAdjustment(conn, ctx, { delta: -100 })).rejects.toThrow(
        /ck_finance_cash_session_adjustments_delta/,
      );
      const other = await insertMovement(conn, ctx.refs, ctx.refs.accountId, {
        sessionId: ctx.session,
      });
      await expect(
        insertAdjustment(conn, ctx, { before: -500, after: -500, movement: other }),
      ).rejects.toThrow(/ck_finance_cash_session_adjustments_delta/);
    }));

  it('un mouvement compensatoire ne sert qu’à un seul ajustement', () =>
    withRollback(async (conn) => {
      const ctx = await adjustmentSetup(conn);
      await insertAdjustment(conn, ctx);
      await expect(insertAdjustment(conn, ctx)).rejects.toThrow(
        /Duplicate|uq_finance_cash_session_adjustments_movement/,
      );
    }));

  it('immuable hors validation ; figé une fois validé ; jamais supprimé', () =>
    withRollback(async (conn) => {
      const ctx = await adjustmentSetup(conn);
      await insertAdjustment(conn, ctx);
      const [[row]] = await conn.query<RowDataPacket[]>(
        'SELECT id FROM finance_cash_session_adjustments WHERE session_id = ?',
        [ctx.session],
      );
      const id = row!.id as Buffer;
      await expect(
        conn.query(
          'UPDATE finance_cash_session_adjustments SET delta_xaf = -1, variance_after_xaf = -501 WHERE id = ?',
          [id],
        ),
      ).rejects.toThrow(/immuable/);
      await expect(
        conn.query(
          `UPDATE finance_cash_session_adjustments SET status = 'VALIDATED' WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/ck_finance_cash_session_adjustments_validation/);
      await conn.query(
        `UPDATE finance_cash_session_adjustments SET status = 'VALIDATED', validated_by = ?, validated_at = ? WHERE id = ?`,
        [ctx.refs.other, T('20:00'), id],
      );
      await expect(
        conn.query('UPDATE finance_cash_session_adjustments SET validated_by = ? WHERE id = ?', [
          ctx.refs.admin,
          id,
        ]),
      ).rejects.toThrow(/figé/);
      await expect(
        conn.query('DELETE FROM finance_cash_session_adjustments WHERE id = ?', [id]),
      ).rejects.toThrow(/suppression interdite/);
    }));
});

describe('finance_cash_transfers (SM-CASH-TRANSFER, ADR-032 §7)', () => {
  async function transferSetup(conn: PoolConnection) {
    const refs = await setup(conn);
    const out = await insertMovement(conn, refs, refs.accountId, { type: 'TRANSFER_OUT' });
    return { refs, out };
  }

  function insertTransfer(
    conn: PoolConnection,
    ctx: { refs: Refs; out: Buffer },
    input: { readonly from?: Buffer; readonly to?: Buffer; readonly amount?: number } = {},
  ) {
    const id = randomId();
    return conn
      .query(
        `INSERT INTO finance_cash_transfers (id, doc_number, from_account_id, to_account_id, amount_sent_xaf, sent_by, sent_at,
           out_movement_id, occurred_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          randomCode('RMF-'),
          input.from ?? ctx.refs.accountId,
          input.to ?? ctx.refs.centralId,
          input.amount ?? 173_000,
          ctx.refs.admin,
          T('18:30'),
          ctx.out,
          T('18:30'),
          ctx.refs.admin,
        ],
      )
      .then(() => id);
  }

  it('envoie : montant strictement positif, comptes distincts', () =>
    withRollback(async (conn) => {
      const ctx = await transferSetup(conn);
      await insertTransfer(conn, ctx);
      const other = await insertMovement(conn, ctx.refs, ctx.refs.accountId, {
        type: 'TRANSFER_OUT',
      });
      const bad = { refs: ctx.refs, out: other };
      await expect(insertTransfer(conn, bad, { amount: 0 })).rejects.toThrow(
        /ck_finance_cash_transfers_amounts/,
      );
      await expect(insertTransfer(conn, bad, { to: ctx.refs.accountId })).rejects.toThrow(
        /ck_finance_cash_transfers_accounts/,
      );
    }));

  it('réception égale : RECEIVED sans écart ; réception différente : DISCREPANCY_PENDING avec écart signé', () =>
    withRollback(async (conn) => {
      const ctx = await transferSetup(conn);
      const id = await insertTransfer(conn, ctx);
      const inMovement = await insertMovement(conn, ctx.refs, ctx.refs.centralId, {
        type: 'TRANSFER_OUT',
      });
      // Un écart annoncé incohérent avec les montants est refusé (comparaison null-safe).
      await expect(
        conn.query(
          `UPDATE finance_cash_transfers SET status = 'DISCREPANCY_PENDING', amount_received_xaf = 170000, discrepancy_xaf = -1,
             received_by = ?, received_at = ?, in_movement_id = ? WHERE id = ?`,
          [ctx.refs.other, T('19:00'), inMovement, id],
        ),
      ).rejects.toThrow(/ck_finance_cash_transfers_discrepancy/);
      // Un statut RECEIVED sans écart nul est refusé.
      await expect(
        conn.query(
          `UPDATE finance_cash_transfers SET status = 'RECEIVED', amount_received_xaf = 170000, discrepancy_xaf = -3000,
             received_by = ?, received_at = ?, in_movement_id = ? WHERE id = ?`,
          [ctx.refs.other, T('19:00'), inMovement, id],
        ),
      ).rejects.toThrow(/ck_finance_cash_transfers_state/);
      await conn.query(
        `UPDATE finance_cash_transfers SET status = 'DISCREPANCY_PENDING', amount_received_xaf = 170000, discrepancy_xaf = -3000,
           received_by = ?, received_at = ?, in_movement_id = ? WHERE id = ?`,
        [ctx.refs.other, T('19:00'), inMovement, id],
      );
    }));

  it('clôture d’un écart : imputation et motif, sans second mouvement ; état terminal ensuite', () =>
    withRollback(async (conn) => {
      const ctx = await transferSetup(conn);
      const id = await insertTransfer(conn, ctx);
      const inMovement = await insertMovement(conn, ctx.refs, ctx.refs.centralId, {
        type: 'TRANSFER_OUT',
      });
      await conn.query(
        `UPDATE finance_cash_transfers SET status = 'DISCREPANCY_PENDING', amount_received_xaf = 170000, discrepancy_xaf = -3000,
           received_by = ?, received_at = ?, in_movement_id = ? WHERE id = ?`,
        [ctx.refs.other, T('19:00'), inMovement, id],
      );
      await expect(
        conn.query(
          `UPDATE finance_cash_transfers SET status = 'CLOSED', closed_by = ?, closed_at = ? WHERE id = ?`,
          [ctx.refs.admin, T('20:00'), id],
        ),
      ).rejects.toThrow(/ck_finance_cash_transfers_state/);
      await conn.query(
        `UPDATE finance_cash_transfers SET status = 'CLOSED', imputation = 'CARRIER', closing_reason = 'Billet perdu',
           closed_by = ?, closed_at = ? WHERE id = ?`,
        [ctx.refs.admin, T('20:00'), id],
      );
      await expect(
        conn.query(`UPDATE finance_cash_transfers SET imputation = 'SENDER' WHERE id = ?`, [id]),
      ).rejects.toThrow(/terminée|terminal/);
      await expect(
        conn.query(`DELETE FROM finance_cash_transfers WHERE id = ?`, [id]),
      ).rejects.toThrow(/suppression interdite/);
    }));

  it('annulation avant réception : mouvement inverse exigé', () =>
    withRollback(async (conn) => {
      const ctx = await transferSetup(conn);
      const id = await insertTransfer(conn, ctx);
      await expect(
        conn.query(
          `UPDATE finance_cash_transfers SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ? WHERE id = ?`,
          [ctx.refs.admin, T('19:00'), id],
        ),
      ).rejects.toThrow(/ck_finance_cash_transfers_state/);
      const cancel = await insertMovement(conn, ctx.refs, ctx.refs.accountId, {
        type: 'TRANSFER_OUT',
      });
      await conn.query(
        `UPDATE finance_cash_transfers SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_reason = 'Erreur', cancel_movement_id = ? WHERE id = ?`,
        [ctx.refs.admin, T('19:00'), cancel, id],
      );
    }));

  it('l’envoi est immuable (montant, comptes, mouvement de sortie)', () =>
    withRollback(async (conn) => {
      const ctx = await transferSetup(conn);
      const id = await insertTransfer(conn, ctx);
      await expect(
        conn.query('UPDATE finance_cash_transfers SET amount_sent_xaf = 1 WHERE id = ?', [id]),
      ).rejects.toThrow(/immuable/);
      await expect(
        conn.query('UPDATE finance_cash_transfers SET to_account_id = ? WHERE id = ?', [
          ctx.refs.admin,
          id,
        ]),
      ).rejects.toThrow();
    }));

  it('un mouvement de sortie ne sert qu’à une seule remise', () =>
    withRollback(async (conn) => {
      const ctx = await transferSetup(conn);
      await insertTransfer(conn, ctx);
      await expect(insertTransfer(conn, ctx)).rejects.toThrow(
        /Duplicate|uq_finance_cash_transfers_out_movement/,
      );
    }));
});

describe('type de validation CASH_TRANSFER_DISCREPANCY', () => {
  it('le catalogue des politiques de contrôle l’accepte', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await conn.query(
        `INSERT INTO approvals_control_policies (id, code, version, operation_type, \`condition\`, requires_approval,
           approver_permission, approver_scope, valid_from, status, created_by)
         VALUES (?, ?, 1, 'CASH_TRANSFER_DISCREPANCY', CAST('{}' AS JSON), TRUE, 'finance.cash_session.validate', 'ALL',
           '2020-01-01 00:00:00', 'ACTIVE', ?)`,
        [randomId(), randomCode('POL'), refs.admin],
      );
    }));
});

// Module `analytics` après la migration 20261201090300 (P9-13 ; BR-ANA-007 à 009 ; ADR-074, ADR-076 à
// ADR-078) : vues sauvegardées (une par nom et par propriétaire, une seule vue par défaut par rôle), exports
// (états cohérents, définition immuable, jamais supprimés), instantanés (une ligne par utilisateur, tableau et
// période), journal des requêtes (ajout seul). Chaque test crée ses données dans une transaction annulée.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { freshPhone, randomId, withRollback } from './helpers.js';

const T = (day: string, hhmm = '10:00') => `${day} ${hhmm}:00.000000`;

async function user(conn: PoolConnection): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Utilisateur', ?, 'x', 'ACTIVE', ?)`,
    [id, await freshPhone(conn), id],
  );
  return id;
}

async function savedView(
  conn: PoolConnection,
  owner: Buffer,
  extra: { name?: string; defaultRole?: string | null; dataset?: string } = {},
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO analytics_saved_views
       (id, owner_user_id, name, dataset, definition, catalog_version, is_default_for_role, created_by)
     VALUES (?, ?, ?, ?, JSON_OBJECT('dimensions', JSON_ARRAY('business_day')), 1, ?, ?)`,
    [
      id,
      owner,
      extra.name ?? 'Ventes par jour',
      extra.dataset ?? 'f_sales_line',
      extra.defaultRole ?? null,
      owner,
    ],
  );
  return id;
}

async function exportJob(
  conn: PoolConnection,
  requester: Buffer,
  extra: { status?: string; fields?: string } = {},
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO analytics_export_jobs
       (id, requested_by, dataset, definition, format, status, catalog_version, expires_at, created_at)
     VALUES (?, ?, 'f_sales_line', JSON_OBJECT('measures', JSON_ARRAY('revenue')), 'CSV', 'QUEUED', 1, ?, ?)`,
    [id, requester, T('2026-12-03'), T('2026-12-02')],
  );
  if (extra.status !== undefined && extra.status !== 'QUEUED') {
    await conn.query(
      `UPDATE analytics_export_jobs SET status = ?, finished_at = ?, ${extra.fields ?? ''} row_count = 12 WHERE id = ?`,
      [extra.status, T('2026-12-02', '10:05'), id],
    );
  }
  return id;
}

describe('analytics_saved_views', () => {
  it('un nom par propriétaire ; deux propriétaires peuvent porter le même nom', () =>
    withRollback(async (conn) => {
      const a = await user(conn);
      const b = await user(conn);
      await savedView(conn, a);
      await expect(savedView(conn, a)).rejects.toThrow(/uq_analytics_saved_views_owner_name/);
      await expect(savedView(conn, b)).resolves.toBeDefined();
      await expect(savedView(conn, a, { name: 'Autre' })).resolves.toBeDefined();
    }));

  it('une seule vue par défaut par rôle ; plusieurs vues sans rôle par défaut', () =>
    withRollback(async (conn) => {
      const owner = await user(conn);
      const role = `ROLE_${randomId().toString('hex').slice(0, 10)}`;
      await savedView(conn, owner, { name: 'Une', defaultRole: role });
      await expect(savedView(conn, owner, { name: 'Deux', defaultRole: role })).rejects.toThrow(
        /uq_analytics_saved_views_default_role/,
      );
      await expect(savedView(conn, owner, { name: 'Trois' })).resolves.toBeDefined();
      await expect(savedView(conn, owner, { name: 'Quatre' })).resolves.toBeDefined();
    }));

  it('jeu de faits nommé f_*, définition objet, rôles tableau, version du catalogue positive', () =>
    withRollback(async (conn) => {
      const owner = await user(conn);
      await expect(savedView(conn, owner, { dataset: 'sales' })).rejects.toThrow(
        /ck_analytics_saved_views_dataset/,
      );
      await expect(
        conn.query(
          `INSERT INTO analytics_saved_views (id, owner_user_id, name, dataset, definition, catalog_version, created_by)
           VALUES (?, ?, 'X', 'f_cash', JSON_ARRAY(1), 1, ?)`,
          [randomId(), owner, owner],
        ),
      ).rejects.toThrow(/ck_analytics_saved_views_definition/);
      await expect(
        conn.query(
          `INSERT INTO analytics_saved_views (id, owner_user_id, name, dataset, definition, catalog_version, shared_with_roles, created_by)
           VALUES (?, ?, 'Y', 'f_cash', JSON_OBJECT(), 1, JSON_OBJECT('a', 1), ?)`,
          [randomId(), owner, owner],
        ),
      ).rejects.toThrow(/ck_analytics_saved_views_roles/);
      await expect(
        conn.query(
          `INSERT INTO analytics_saved_views (id, owner_user_id, name, dataset, definition, catalog_version, created_by)
           VALUES (?, ?, 'Z', 'f_cash', JSON_OBJECT(), 0, ?)`,
          [randomId(), owner, owner],
        ),
      ).rejects.toThrow(/ck_analytics_saved_views_catalog/);
    }));

  it('le propriétaire et l’identité sont immuables ; la vue se modifie et se supprime', () =>
    withRollback(async (conn) => {
      const owner = await user(conn);
      const other = await user(conn);
      const id = await savedView(conn, owner);
      await expect(
        conn.query(`UPDATE analytics_saved_views SET owner_user_id = ? WHERE id = ?`, [other, id]),
      ).rejects.toThrow(/immuables/);
      await conn.query(
        `UPDATE analytics_saved_views SET name = 'Renommée', shared_with_roles = JSON_ARRAY('DIRECTION'), version = version + 1 WHERE id = ?`,
        [id],
      );
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT name, shared_with_roles, version FROM analytics_saved_views WHERE id = ?`,
        [id],
      );
      expect(rows[0]).toMatchObject({
        name: 'Renommée',
        shared_with_roles: ['DIRECTION'],
        version: 2,
      });
      await conn.query(`DELETE FROM analytics_saved_views WHERE id = ?`, [id]);
    }));
});

describe('analytics_export_jobs', () => {
  it('un export neuf est en file ; format et statut du catalogue', () =>
    withRollback(async (conn) => {
      const requester = await user(conn);
      const id = await exportJob(conn, requester);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT status, finished_at, row_count FROM analytics_export_jobs WHERE id = ?`,
        [id],
      );
      expect(rows[0]).toMatchObject({ status: 'QUEUED', finished_at: null, row_count: null });
      await expect(
        conn.query(
          `INSERT INTO analytics_export_jobs (id, requested_by, dataset, definition, format, catalog_version, expires_at)
           VALUES (?, ?, 'f_cash', JSON_OBJECT(), 'PDF', 1, ?)`,
          [randomId(), requester, T('2026-12-03')],
        ),
      ).rejects.toThrow(/ck_analytics_export_jobs_format/);
      await expect(
        conn.query(
          `UPDATE analytics_export_jobs SET status = 'ENCOURS', finished_at = ? WHERE id = ?`,
          [T('2026-12-02'), id],
        ),
      ).rejects.toThrow(/ck_analytics_export_jobs_status/);
    }));

  it('jeu de faits nommé f_*, définition objet, version du catalogue positive, demandeur connu', () =>
    withRollback(async (conn) => {
      const requester = await user(conn);
      const insert = (
        dataset: string,
        definition: string,
        catalog: number,
        by: Buffer = requester,
      ) =>
        conn.query(
          `INSERT INTO analytics_export_jobs (id, requested_by, dataset, definition, format, catalog_version, expires_at)
           VALUES (?, ?, ?, ${definition}, 'CSV', ?, ?)`,
          [randomId(), by, dataset, catalog, T('2026-12-03')],
        );
      await expect(insert('ventes', 'JSON_OBJECT()', 1)).rejects.toThrow(
        /ck_analytics_export_jobs_dataset/,
      );
      await expect(insert('f_cash', 'JSON_ARRAY()', 1)).rejects.toThrow(
        /ck_analytics_export_jobs_definition/,
      );
      await expect(insert('f_cash', 'JSON_OBJECT()', 0)).rejects.toThrow(
        /ck_analytics_export_jobs_catalog/,
      );
      await expect(insert('f_cash', 'JSON_OBJECT()', 1, randomId())).rejects.toThrow(
        /fk_analytics_export_jobs_requested_by/,
      );
      await expect(insert('f_cash', 'JSON_OBJECT()', 1)).resolves.toBeDefined();
    }));

  it('fin et issue cohérentes : DONE a son fichier et ses lignes, FAILED son motif, en file sans fin', () =>
    withRollback(async (conn) => {
      const requester = await user(conn);
      const id = await exportJob(conn, requester);
      // Une fin sans statut final, un statut final sans fin.
      await expect(
        conn.query(`UPDATE analytics_export_jobs SET finished_at = ? WHERE id = ?`, [
          T('2026-12-02'),
          id,
        ]),
      ).rejects.toThrow(/ck_analytics_export_jobs_finished/);
      await expect(
        conn.query(`UPDATE analytics_export_jobs SET status = 'DONE' WHERE id = ?`, [id]),
      ).rejects.toThrow(/ck_analytics_export_jobs_/);
      // Réussi sans fichier, sans nombre de lignes.
      await expect(
        conn.query(
          `UPDATE analytics_export_jobs SET status = 'DONE', finished_at = ?, row_count = 5 WHERE id = ?`,
          [T('2026-12-02'), id],
        ),
      ).rejects.toThrow(/ck_analytics_export_jobs_file/);
      await expect(
        conn.query(
          `UPDATE analytics_export_jobs SET status = 'DONE', finished_at = ?, storage_key = 'exports/x' WHERE id = ?`,
          [T('2026-12-02'), id],
        ),
      ).rejects.toThrow(/ck_analytics_export_jobs_done/);
      // Échec sans motif.
      await expect(
        conn.query(
          `UPDATE analytics_export_jobs SET status = 'FAILED', finished_at = ? WHERE id = ?`,
          [T('2026-12-02'), id],
        ),
      ).rejects.toThrow(/ck_analytics_export_jobs_failed/);
      await conn.query(
        `UPDATE analytics_export_jobs SET status = 'DONE', finished_at = ?, storage_key = 'exports/x', row_count = 5 WHERE id = ?`,
        [T('2026-12-02'), id],
      );
    }));

  it('la définition, le demandeur et l’échéance sont immuables (BR-ANA-008)', () =>
    withRollback(async (conn) => {
      const requester = await user(conn);
      const other = await user(conn);
      const id = await exportJob(conn, requester);
      for (const update of [
        [`UPDATE analytics_export_jobs SET requested_by = ? WHERE id = ?`, [other, id]],
        [`UPDATE analytics_export_jobs SET definition = JSON_OBJECT() WHERE id = ?`, [id]],
        [`UPDATE analytics_export_jobs SET dataset = 'f_cash' WHERE id = ?`, [id]],
        [`UPDATE analytics_export_jobs SET format = 'XLSX' WHERE id = ?`, [id]],
        [`UPDATE analytics_export_jobs SET catalog_version = 2 WHERE id = ?`, [id]],
        [`UPDATE analytics_export_jobs SET expires_at = ? WHERE id = ?`, [T('2027-01-01'), id]],
      ] as const) {
        await expect(conn.query(update[0], [...update[1]])).rejects.toThrow(/immuables/);
      }
    }));

  it('un export terminé est figé ; un export réussi ne peut qu’expirer ; aucune suppression', () =>
    withRollback(async (conn) => {
      const requester = await user(conn);
      const failed = await exportJob(conn, requester, {
        status: 'FAILED',
        fields: `error_code = 'QUERY_LIMIT_EXCEEDED',`,
      });
      await expect(
        conn.query(`UPDATE analytics_export_jobs SET error_code = 'AUTRE' WHERE id = ?`, [failed]),
      ).rejects.toThrow(/export terminé, immuable/);

      const done = await exportJob(conn, requester, {
        status: 'DONE',
        fields: `storage_key = 'exports/y',`,
      });
      await expect(
        conn.query(
          `UPDATE analytics_export_jobs SET status = 'FAILED', error_code = 'X' WHERE id = ?`,
          [done],
        ),
      ).rejects.toThrow(/ne peut qu'expirer/);
      await expect(
        conn.query(`UPDATE analytics_export_jobs SET row_count = 99 WHERE id = ?`, [done]),
      ).rejects.toThrow(/ne peut qu'expirer/);
      await conn.query(`UPDATE analytics_export_jobs SET status = 'EXPIRED' WHERE id = ?`, [done]);
      await expect(
        conn.query(`UPDATE analytics_export_jobs SET status = 'DONE' WHERE id = ?`, [done]),
      ).rejects.toThrow(/export terminé, immuable/);

      await expect(
        conn.query(`DELETE FROM analytics_export_jobs WHERE id = ?`, [done]),
      ).rejects.toThrow(/suppression interdite/);
    }));

  it('une demande rejouée (même commande) ne crée pas un second export', () =>
    withRollback(async (conn) => {
      const requester = await user(conn);
      const command = randomId();
      const insert = () =>
        conn.query(
          `INSERT INTO analytics_export_jobs (id, requested_by, dataset, definition, format, catalog_version, expires_at, command_id)
           VALUES (?, ?, 'f_cash', JSON_OBJECT(), 'XLSX', 1, ?, ?)`,
          [randomId(), requester, T('2026-12-03'), command],
        );
      await insert();
      await expect(insert()).rejects.toThrow(/uq_analytics_export_jobs_command/);
    }));
});

describe('analytics_kpi_snapshots', () => {
  it('une ligne par utilisateur, tableau et période ; écrasée à chaque calcul', () =>
    withRollback(async (conn) => {
      const owner = await user(conn);
      const write = (period: string, value: number) =>
        conn.query(
          `INSERT INTO analytics_kpi_snapshots (user_id, scope_key, period_key, payload, computed_at)
           VALUES (?, 'direction', ?, JSON_OBJECT('revenue', ?), ?)
           ON DUPLICATE KEY UPDATE payload = VALUES(payload), computed_at = VALUES(computed_at)`,
          [owner, period, value, T('2026-12-02')],
        );
      await write('TODAY', 1);
      await write('TODAY', 2);
      await write('WEEK', 3);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT period_key, payload FROM analytics_kpi_snapshots WHERE user_id = ? ORDER BY period_key`,
        [owner],
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.period_key === 'TODAY')?.payload).toEqual({ revenue: 2 });
      await expect(write('YEAR', 4)).rejects.toThrow(/ck_analytics_kpi_snapshots_period/);
      await expect(
        conn.query(
          `INSERT INTO analytics_kpi_snapshots (user_id, scope_key, period_key, payload, computed_at)
           VALUES (?, 'stock', 'TODAY', JSON_ARRAY(), ?)`,
          [owner, T('2026-12-02')],
        ),
      ).rejects.toThrow(/ck_analytics_kpi_snapshots_payload/);
      await conn.query(`DELETE FROM analytics_kpi_snapshots WHERE user_id = ?`, [owner]);
    }));
});

describe('analytics_query_log', () => {
  it('ajout seul : issue du catalogue, aucune modification', () =>
    withRollback(async (conn) => {
      const owner = await user(conn);
      const id = randomId();
      const insert = (outcome: string, key = id) =>
        conn.query(
          `INSERT INTO analytics_query_log (id, user_id, dataset, definition, outcome, error_code, row_count, duration_ms)
           VALUES (?, ?, 'f_sales_line', JSON_OBJECT('measures', JSON_ARRAY('revenue')), ?, NULL, 10, 25)`,
          [key, owner, outcome],
        );
      await insert('OK');
      await expect(insert('ECHEC', randomId())).rejects.toThrow(/ck_analytics_query_log_outcome/);
      await expect(
        conn.query(`UPDATE analytics_query_log SET row_count = 11 WHERE id = ?`, [id]),
      ).rejects.toThrow(/ajout seul/);
      // La purge technique (DELETE) reste permise par la base : c'est le privilège de l'application qui la borne.
      await conn.query(`DELETE FROM analytics_query_log WHERE id = ?`, [id]);
    }));
});

describe('privilèges de l’application sur analytics_*', () => {
  it('DELETE seulement sur les vues, les instantanés et le journal ; jamais sur les exports', async () => {
    await withRollback(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE) AS privileges
           FROM information_schema.TABLE_PRIVILEGES
          WHERE GRANTEE = "'gic_app'@'%'" AND TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'analytics\\_%'
          GROUP BY TABLE_NAME`,
      );
      const privileges = new Map(rows.map((row) => [row.name as string, row.privileges as string]));
      expect(privileges.get('analytics_saved_views')).toBe('DELETE,INSERT,SELECT,UPDATE');
      expect(privileges.get('analytics_kpi_snapshots')).toBe('DELETE,INSERT,SELECT,UPDATE');
      expect(privileges.get('analytics_query_log')).toBe('DELETE,INSERT,SELECT');
      expect(privileges.get('analytics_export_jobs')).toBe('INSERT,SELECT,UPDATE');
    });
  });
});

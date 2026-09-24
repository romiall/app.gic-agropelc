import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

async function insertAdmin(conn: PoolConnection): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Admin', ?, 'x', 'ACTIVE', ?)`,
    [id, `+2376${Math.floor(1_000_0000 + Math.random() * 8_999_9999)}`, id],
  );
  return id;
}

describe('audit_audit_log', () => {
  it('accepte une insertion puis refuse toute modification et toute suppression (INV-AUD-01)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const logId = randomId();
      await conn.query(
        `INSERT INTO audit_audit_log (id, occurred_at, actor_user_id, actor_roles, action, entity_type, result, prev_hash, row_hash)
         VALUES (?, NOW(6), ?, JSON_ARRAY('ADMIN'), 'identity.user.create', 'identity.user', 'SUCCESS', REPEAT('0', 64), REPEAT('1', 64))`,
        [logId, admin],
      );
      await expect(
        conn.query("UPDATE audit_audit_log SET result = 'FAILED' WHERE id = ?", [logId]),
      ).rejects.toThrow(/aucune modification/);
      await expect(conn.query('DELETE FROM audit_audit_log WHERE id = ?', [logId])).rejects.toThrow(
        /suppression physique interdite/,
      );
    });
  });
});

describe('sync_command_inbox', () => {
  it('autorise la transition de statut puis refuse une modification du contenu de la commande', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const commandId = randomId();
      await conn.query(
        `INSERT INTO sync_command_inbox (command_id, user_id, transport, command_type, depends_on, payload, payload_hash, occurred_at)
         VALUES (?, ?, 'SYNC_PUSH', 'sales.sale.record', JSON_ARRAY(), JSON_OBJECT(), REPEAT('a', 64), NOW(6))`,
        [commandId, admin],
      );
      await conn.query(
        "UPDATE sync_command_inbox SET status = 'APPLIED', applied_at = NOW(6) WHERE command_id = ?",
        [commandId],
      );
      await expect(
        conn.query('UPDATE sync_command_inbox SET command_type = ? WHERE command_id = ?', [
          'sales.sale.cancel',
          commandId,
        ]),
      ).rejects.toThrow(/seuls status\/result/);
      await expect(
        conn.query('DELETE FROM sync_command_inbox WHERE command_id = ?', [commandId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });

  it('refuse une seconde commande avec le même (device_id, device_seq) (INV-SYN-03)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const deviceId = randomId();
      await conn.query(
        `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, created_by) VALUES (?, 'DV01', ?, ?)`,
        [deviceId, admin, admin],
      );
      await conn.query(
        `INSERT INTO sync_command_inbox (command_id, device_id, user_id, device_seq, transport, command_type, depends_on, payload, payload_hash, occurred_at)
         VALUES (?, ?, ?, 1, 'SYNC_PUSH', 'sales.sale.record', JSON_ARRAY(), JSON_OBJECT(), REPEAT('a', 64), NOW(6))`,
        [randomId(), deviceId, admin],
      );
      await expect(
        conn.query(
          `INSERT INTO sync_command_inbox (command_id, device_id, user_id, device_seq, transport, command_type, depends_on, payload, payload_hash, occurred_at)
           VALUES (?, ?, ?, 1, 'SYNC_PUSH', 'sales.sale.record', JSON_ARRAY(), JSON_OBJECT(), REPEAT('b', 64), NOW(6))`,
          [randomId(), deviceId, admin],
        ),
      ).rejects.toThrow(/uq_sync_command_inbox_device_seq/);
    });
  });
});

describe('sync_sync_conflicts', () => {
  it('devient immuable après résolution', async () => {
    await withRollback(async (conn) => {
      const conflictId = randomId();
      await conn.query(
        `INSERT INTO sync_sync_conflicts (id, conflict_type, entity_type, entity_id, owner_role, applied, details)
         VALUES (?, 'VERSION_CONFLICT', 'sales.sale', ?, 'RESP_COMMERCIAL', FALSE, JSON_OBJECT())`,
        [conflictId, randomId()],
      );
      await conn.query(
        "UPDATE sync_sync_conflicts SET status = 'RESOLVED', resolution = 'KEEP_SERVER' WHERE id = ?",
        [conflictId],
      );
      await expect(
        conn.query("UPDATE sync_sync_conflicts SET resolution_comment = 'trop tard' WHERE id = ?", [
          conflictId,
        ]),
      ).rejects.toThrow(/immuable après résolution/);
    });
  });
});

describe('sync_change_feed', () => {
  it('accepte une insertion puis refuse toute modification (fait ponctuel)', async () => {
    await withRollback(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO sync_change_feed (dataset, entity_type, entity_id, change_type, scope_type, row_version)
         VALUES ('catalog', 'catalog.product', ?, 'UPSERT', 'GLOBAL', 1)`,
        [randomId()],
      );
      const seq = (result as { insertId: number }).insertId;
      await expect(
        conn.query('UPDATE sync_change_feed SET row_version = 2 WHERE seq = ?', [seq]),
      ).rejects.toThrow(/aucune modification/);
      // PURGE_TECHNIQUE : la suppression, elle, est autorisée.
      await conn.query('DELETE FROM sync_change_feed WHERE seq = ?', [seq]);
    });
  });
});

describe('sync_device_sync_state', () => {
  it('est librement modifiable (état opérationnel par appareil)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertAdmin(conn);
      const deviceId = randomId();
      await conn.query(
        `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, created_by) VALUES (?, 'DV02', ?, ?)`,
        [deviceId, admin, admin],
      );
      await conn.query(
        `INSERT INTO sync_device_sync_state (device_id, dataset, cursor_seq) VALUES (?, 'catalog', 0)`,
        [deviceId],
      );
      await conn.query(
        "UPDATE sync_device_sync_state SET cursor_seq = 42, last_pull_at = NOW(6) WHERE device_id = ? AND dataset = 'catalog'",
        [deviceId],
      );
      const [rows] = await conn.query(
        "SELECT cursor_seq FROM sync_device_sync_state WHERE device_id = ? AND dataset = 'catalog'",
        [deviceId],
      );
      expect((rows as Array<{ cursor_seq: number }>)[0]?.cursor_seq).toBe(42);
    });
  });
});

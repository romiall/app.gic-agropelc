import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

/** Utilisateur système auto-créateur (bootstrap), pour les FK created_by/updated_by. */
async function insertBootstrapUser(conn: PoolConnection): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, is_system, created_by)
     VALUES (?, 'Système', ?, 'x', 'ACTIVE', TRUE, ?)`,
    [id, `+2376${Math.floor(1_000_0000 + Math.random() * 8_999_9999)}`, id],
  );
  return id;
}

describe('identity_users', () => {
  it('accepte le bootstrap auto-référencé (created_by = son propre id)', async () => {
    await withRollback(async (conn) => {
      const id = await insertBootstrapUser(conn);
      const [rows] = await conn.query(
        'SELECT HEX(created_by) AS created_by FROM identity_users WHERE id = ?',
        [id],
      );
      expect((rows as Array<{ created_by: string }>)[0]?.created_by).toBe(
        id.toString('hex').toUpperCase(),
      );
    });
  });

  it('refuse un second utilisateur ACTIVE avec le même téléphone (index unique partiel)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      await conn.query(
        `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
         VALUES (?, 'Premier', '+237600000001', 'x', 'ACTIVE', ?)`,
        [randomId(), admin],
      );
      await expect(
        conn.query(
          `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
           VALUES (?, 'Doublon', '+237600000001', 'x', 'ACTIVE', ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/uq_identity_users_active_phone/);
    });
  });

  it('accepte un téléphone dupliqué si le premier est DEACTIVATED (hors de la contrainte)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      await conn.query(
        `INSERT INTO identity_users (id, full_name, phone, password_hash, status, status_reason, created_by)
         VALUES (?, 'Ancien', '+237600000002', 'x', 'DEACTIVATED', 'parti', ?)`,
        [randomId(), admin],
      );
      await conn.query(
        `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
         VALUES (?, 'Nouveau', '+237600000002', 'x', 'ACTIVE', ?)`,
        [randomId(), admin],
      );
    });
  });

  it('rejette un format de téléphone non E.164', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      await expect(
        conn.query(
          `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
           VALUES (?, 'Mauvais', '0600000000', 'x', 'ACTIVE', ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/ck_identity_users_phone/);
    });
  });

  it("exige status_reason dès que le statut n'est pas ACTIVE", async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      await expect(
        conn.query(
          `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
           VALUES (?, 'Suspendu', '+237600000003', 'x', 'SUSPENDED', ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/ck_identity_users_status_reason/);
    });
  });

  it('refuse toute suppression physique (INV-GLO-03)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      await expect(conn.query('DELETE FROM identity_users WHERE id = ?', [admin])).rejects.toThrow(
        /suppression physique interdite/,
      );
    });
  });
});

describe('identity_roles', () => {
  it('rejette un code hors UPPER_SNAKE_CASE', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      await expect(
        conn.query(
          `INSERT INTO identity_roles (id, code, name, created_by) VALUES (?, 'admin', 'Admin', ?)`,
          [randomId(), admin],
        ),
      ).rejects.toThrow(/ck_identity_roles_code/);
    });
  });
});

describe('identity_devices', () => {
  it('exige approved_by dès que le statut est ACTIVE', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      await expect(
        conn.query(
          `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, status, created_by)
           VALUES (?, 'AB01', ?, 'ACTIVE', ?)`,
          [randomId(), admin, admin],
        ),
      ).rejects.toThrow(/ck_identity_devices_approved_by/);
    });
  });
});

describe('identity_role_permissions', () => {
  it('autorise la suppression (retrait de droit, liaison de configuration)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      const roleId = randomId();
      await conn.query(
        `INSERT INTO identity_roles (id, code, name, created_by) VALUES (?, 'TEST_ROLE', 'Test', ?)`,
        [roleId, admin],
      );
      await conn.query(
        `INSERT INTO identity_permissions (code, module, description, supported_scopes) VALUES ('test.perm', 'test', 'desc', JSON_ARRAY('ALL'))`,
      );
      await conn.query(
        `INSERT INTO identity_role_permissions (role_id, permission_code, max_scope, granted_by) VALUES (?, 'test.perm', 'ALL', ?)`,
        [roleId, admin],
      );
      await conn.query(
        'DELETE FROM identity_role_permissions WHERE role_id = ? AND permission_code = ?',
        [roleId, 'test.perm'],
      );
    });
  });
});

describe('identity_auth_sessions', () => {
  it('autorise la suppression (PURGE_TECHNIQUE)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      const deviceId = randomId();
      await conn.query(
        `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, created_by) VALUES (?, 'AB02', ?, ?)`,
        [deviceId, admin, admin],
      );
      const sessionId = randomId();
      await conn.query(
        `INSERT INTO identity_auth_sessions (id, user_id, device_id, refresh_token_hash, token_family_id, expires_at, offline_grant_until)
         VALUES (?, ?, ?, REPEAT('a', 64), ?, DATE_ADD(NOW(6), INTERVAL 30 DAY), DATE_ADD(NOW(6), INTERVAL 7 DAY))`,
        [sessionId, admin, deviceId, randomId()],
      );
      await conn.query('DELETE FROM identity_auth_sessions WHERE id = ?', [sessionId]);
    });
  });
});

describe('identity_user_role_assignments', () => {
  it('rejette un scope_type absent de roles.allowed_scope_types', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      const roleId = randomId();
      await conn.query(
        `INSERT INTO identity_roles (id, code, name, allowed_scope_types, created_by) VALUES (?, 'RESP_COMMERCIAL', 'Resp.', JSON_ARRAY('SITE', 'ZONE'), ?)`,
        [roleId, admin],
      );
      await expect(
        conn.query(
          `INSERT INTO identity_user_role_assignments (id, user_id, role_id, scope_type, created_by) VALUES (?, ?, ?, 'GLOBAL', ?)`,
          [randomId(), admin, roleId, admin],
        ),
      ).rejects.toThrow(/scope_type non autorisé/);
    });
  });

  it('accepte un scope_type autorisé puis refuse une modification hors liste blanche', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      const roleId = randomId();
      await conn.query(
        `INSERT INTO identity_roles (id, code, name, allowed_scope_types, created_by) VALUES (?, 'RESP_COMMERCIAL', 'Resp.', JSON_ARRAY('GLOBAL'), ?)`,
        [roleId, admin],
      );
      const assignmentId = randomId();
      await conn.query(
        `INSERT INTO identity_user_role_assignments (id, user_id, role_id, scope_type, created_by) VALUES (?, ?, ?, 'GLOBAL', ?)`,
        [assignmentId, admin, roleId, admin],
      );

      // Fermeture (valid_to) : autorisée.
      await conn.query('UPDATE identity_user_role_assignments SET valid_to = NOW(6) WHERE id = ?', [
        assignmentId,
      ]);

      // Changer le rôle affecté : refusé (hors liste blanche).
      const otherRole = randomId();
      await conn.query(
        `INSERT INTO identity_roles (id, code, name, allowed_scope_types, created_by) VALUES (?, 'AUTRE', 'Autre', JSON_ARRAY('GLOBAL'), ?)`,
        [otherRole, admin],
      );
      await expect(
        conn.query('UPDATE identity_user_role_assignments SET role_id = ? WHERE id = ?', [
          otherRole,
          assignmentId,
        ]),
      ).rejects.toThrow(/seule la révocation\/fermeture est modifiable/);
    });
  });

  it('refuse toute suppression physique (INV-ADM-04)', async () => {
    await withRollback(async (conn) => {
      const admin = await insertBootstrapUser(conn);
      const roleId = randomId();
      await conn.query(
        `INSERT INTO identity_roles (id, code, name, allowed_scope_types, created_by) VALUES (?, 'RESP_COMMERCIAL', 'Resp.', JSON_ARRAY('GLOBAL'), ?)`,
        [roleId, admin],
      );
      const assignmentId = randomId();
      await conn.query(
        `INSERT INTO identity_user_role_assignments (id, user_id, role_id, scope_type, created_by) VALUES (?, ?, ?, 'GLOBAL', ?)`,
        [assignmentId, admin, roleId, admin],
      );
      await expect(
        conn.query('DELETE FROM identity_user_role_assignments WHERE id = ?', [assignmentId]),
      ).rejects.toThrow(/suppression physique interdite/);
    });
  });
});

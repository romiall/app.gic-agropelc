/**
 * Seed idempotent (P0-05) : rôles, permissions et portées, emplacements virtuels,
 * paramètres système par défaut. Rejouable sans effet destructif — chaque étape vérifie
 * l'existant avant d'écrire (upsert par clé naturelle, jamais par id généré ici).
 *
 * `identity.role_permissions` (source de vérité pour les tests RBAC générés, P0-10,
 * 09-non-functional/03-plan-de-tests.md §5) est entièrement reconstruite à partir de
 * ROLE_PERMISSIONS à chaque exécution (retrait autorisé pour cette table, cf.
 * 20260924100100_create_identity_core.sql) : ce seed est la source de vérité courante de
 * la matrice, pas seulement son état initial.
 */
import mysql from 'mysql2/promise';
import { PERMISSIONS, ROLE_DISCOUNT_SETTINGS, ROLE_PERMISSIONS, ROLES } from './rbac-data.js';
import { SYSTEM_SETTINGS } from './system-settings.js';
import { VIRTUAL_LOCATIONS } from './virtual-locations.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL non définie (voir db/README.md).');
}

function randomId(): Buffer {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

async function ensureSystemUser(conn: mysql.Connection): Promise<Buffer> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    'SELECT id FROM identity_users WHERE is_system = TRUE LIMIT 1',
  );
  if (rows.length > 0) return rows[0]!.id as Buffer;

  const id = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, is_system, locale, created_by)
     VALUES (?, 'Système', '+237600000000', '', 'ACTIVE', TRUE, 'fr-CM', ?)`,
    [id, id],
  );
  console.log('  + identity_users système (bootstrap, is_system=true)');
  return id;
}

async function seedRoles(
  conn: mysql.Connection,
  systemUserId: Buffer,
): Promise<Map<string, Buffer>> {
  const roleIds = new Map<string, Buffer>();
  for (const role of ROLES) {
    await conn.query(
      `INSERT INTO identity_roles (id, code, name, description, allowed_scope_types, is_system, created_by)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), TRUE, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
         allowed_scope_types = VALUES(allowed_scope_types), updated_by = VALUES(created_by)`,
      [
        randomId(),
        role.code,
        role.name,
        role.description,
        JSON.stringify(role.allowedScopeTypes),
        systemUserId,
      ],
    );
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT id FROM identity_roles WHERE code = ?',
      [role.code],
    );
    roleIds.set(role.code, rows[0]!.id as Buffer);
  }
  console.log(`  + identity_roles (${ROLES.length})`);
  return roleIds;
}

async function seedPermissions(conn: mysql.Connection): Promise<void> {
  for (const permission of PERMISSIONS) {
    await conn.query(
      `INSERT INTO identity_permissions (code, module, description, supported_scopes, is_approval, is_sensitive)
       VALUES (?, ?, ?, CAST(? AS JSON), ?, ?)
       ON DUPLICATE KEY UPDATE module = VALUES(module), description = VALUES(description),
         supported_scopes = VALUES(supported_scopes), is_approval = VALUES(is_approval), is_sensitive = VALUES(is_sensitive)`,
      [
        permission.code,
        permission.module,
        permission.description,
        JSON.stringify(permission.supportedScopes),
        permission.isApproval,
        permission.isSensitive,
      ],
    );
  }
  console.log(`  + identity_permissions (${PERMISSIONS.length})`);
}

async function seedRolePermissions(
  conn: mysql.Connection,
  roleIds: Map<string, Buffer>,
  systemUserId: Buffer,
): Promise<void> {
  let count = 0;
  for (const grant of ROLE_PERMISSIONS) {
    const roleId = roleIds.get(grant.roleCode);
    if (!roleId)
      throw new Error(`ROLE_PERMISSIONS : rôle inconnu « ${grant.roleCode} » (voir ROLES).`);
    await conn.query(
      `INSERT INTO identity_role_permissions (role_id, permission_code, max_scope, limits, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE max_scope = VALUES(max_scope), limits = VALUES(limits)`,
      [
        roleId,
        grant.permissionCode,
        grant.maxScope,
        grant.limits ? JSON.stringify(grant.limits) : null,
        systemUserId,
      ],
    );
    count++;
  }
  console.log(`  + identity_role_permissions (${count} octrois)`);
}

async function seedVirtualLocations(conn: mysql.Connection, systemUserId: Buffer): Promise<void> {
  for (const location of VIRTUAL_LOCATIONS) {
    const [existing] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT id FROM organization_locations WHERE location_type = ? AND is_virtual = TRUE',
      [location.locationType],
    );
    if (existing.length > 0) continue;
    await conn.query(
      `INSERT INTO organization_locations (id, code, name, location_type, status, created_by)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
      [randomId(), location.code, location.name, location.locationType, systemUserId],
    );
  }
  console.log(
    `  + organization_locations virtuels (${VIRTUAL_LOCATIONS.length} types, BR-ADM-010)`,
  );
}

async function seedSystemSettings(conn: mysql.Connection, systemUserId: Buffer): Promise<void> {
  const allSettings = [
    ...SYSTEM_SETTINGS,
    ...ROLE_DISCOUNT_SETTINGS.map((s) => ({
      key: s.key,
      value: s.value,
      isClientVisible: true,
      ref: s.ref,
    })),
  ];
  let inserted = 0;
  for (const setting of allSettings) {
    // VERSIONNEMENT (BR-ADM-015) : une seule version initiale par clé ; une ré-exécution du
    // seed ne doit pas empiler des versions identiques. Une vraie évolution de valeur par
    // défaut passe par une nouvelle valeur ici *et* reste un nouvel appel INSERT (nouvelle
    // valid_from), pas une modification du seed existant.
    const [existing] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT id FROM organization_system_settings WHERE `key` = ? AND scope_type = 'GLOBAL' AND scope_id IS NULL",
      [setting.key],
    );
    if (existing.length > 0) continue;
    await conn.query(
      `INSERT INTO organization_system_settings (id, \`key\`, value, scope_type, is_client_visible, created_by, reason)
       VALUES (?, ?, CAST(? AS JSON), 'GLOBAL', ?, ?, ?)`,
      [
        randomId(),
        setting.key,
        JSON.stringify(setting.value),
        setting.isClientVisible,
        systemUserId,
        `Seed P0-05 (${setting.ref})`,
      ],
    );
    inserted++;
  }
  console.log(
    `  + organization_system_settings (${inserted} nouvelles clés sur ${allSettings.length})`,
  );
}

async function main(): Promise<void> {
  const conn = await mysql.createConnection(DATABASE_URL!);
  try {
    console.log('Seed P0-05 :');
    const systemUserId = await ensureSystemUser(conn);
    const roleIds = await seedRoles(conn, systemUserId);
    await seedPermissions(conn);
    await seedRolePermissions(conn, roleIds, systemUserId);
    await seedVirtualLocations(conn, systemUserId);
    await seedSystemSettings(conn, systemUserId);
    console.log('Terminé.');
  } finally {
    await conn.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

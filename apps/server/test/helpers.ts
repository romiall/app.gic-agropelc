/**
 * Utilitaires des tests d'intégration serveur : connexion à `SERVER_DATABASE_URL` (base déjà
 * migrée, identifiants `gic_app` — voir apps/server/.env.example), équivalent Kysely de
 * `db/tests/helpers.ts::withRollback` (mysql2 brut). Kysely n'expose pas de `rollback()`
 * manuel sur une transaction : `db.transaction().execute(cb)` valide si `cb` réussit, annule
 * s'il lève — `withTestUow` force donc systématiquement un rejet interne (sentinelle) après
 * avoir capturé le résultat ou l'erreur réels de `fn`, pour un rollback garanti quel que soit
 * l'issue testée (comme `withRollback`, dont c'est l'équivalent).
 */
import { SystemClock, Uuidv7Generator } from '@gic/domain';
import { createDatabase } from '../src/platform/kysely/database.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';

const SERVER_DATABASE_URL = process.env.SERVER_DATABASE_URL;
if (!SERVER_DATABASE_URL) {
  throw new Error(
    'SERVER_DATABASE_URL non définie : ces tests exigent une base MySQL déjà migrée, identifiants gic_app (voir apps/server/.env.example).',
  );
}

const { db, pool } = createDatabase(SERVER_DATABASE_URL);
export { db };

export async function closeTestDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pool.end((error) => (error ? reject(error) : resolve()));
  });
}

const idGenerator = new Uuidv7Generator(new SystemClock());
/** UUIDv7 texte frais, pour des identifiants de test jamais en collision entre exécutions. */
export function freshUuid(): string {
  return idGenerator.newId();
}

const ROLLBACK_SENTINEL = Symbol('ROLLBACK_SENTINEL');

/** Exécute `fn(trx)` dans une transaction toujours annulée (ROLLBACK) à la fin. */
export async function withTestUow<T>(fn: (trx: UnitOfWork) => Promise<T>): Promise<T> {
  const box: { result?: T; error?: unknown; hasError: boolean } = { hasError: false };
  try {
    await db.transaction().execute(async (trx) => {
      try {
        box.result = await fn(trx);
      } catch (error) {
        box.error = error;
        box.hasError = true;
      }
      throw ROLLBACK_SENTINEL;
    });
  } catch (error) {
    if (error !== ROLLBACK_SENTINEL) throw error;
  }
  if (box.hasError) throw box.error;
  return box.result as T;
}

export interface TestUserOptions {
  readonly status?: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  readonly statusChangedAt?: Date | null;
}

/**
 * Insère un utilisateur minimal (auto-référencé comme created_by, comme le bootstrap seed).
 * `status_reason` obligatoire dès que le statut n'est pas ACTIVE (ck_identity_users_status_reason).
 */
export async function insertTestUser(
  trx: UnitOfWork,
  options: TestUserOptions = {},
): Promise<string> {
  const id = freshUuid();
  const phone = `+2376${Math.floor(1_000_0000 + Math.random() * 8_999_9999)}`;
  const status = options.status ?? 'ACTIVE';
  await trx
    .insertInto('identity_users')
    .values({
      id: toBin(id),
      full_name: 'Test',
      phone,
      password_hash: 'x',
      status,
      status_reason: status === 'ACTIVE' ? null : 'Fixture de test',
      status_changed_at: options.statusChangedAt ?? null,
      created_by: toBin(id),
    })
    .execute();
  return id;
}

export interface TestDeviceOptions {
  readonly status?: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'LOST' | 'RETIRED';
  readonly statusChangedAt?: Date;
}

const SHORT_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_SHORT_CODE_ATTEMPTS = 5;

function randomShortCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += SHORT_CODE_CHARS[Math.floor(Math.random() * SHORT_CODE_CHARS.length)];
  }
  return code;
}

/**
 * `short_code` (varchar(4), unique) : `randomShortCode` + retry, comme la vraie
 * implémentation (`device-enrollment.ts`) — un short_code dérivé de l'UUID (4 hex, 16^4
 * combinaisons) collisionnait trop souvent sur une suite qui crée des centaines
 * d'appareils par exécution (collision réelle observée à plusieurs reprises).
 */
export async function insertTestDevice(
  trx: UnitOfWork,
  enrolledByUserId: string,
  options: TestDeviceOptions = {},
): Promise<string> {
  const id = freshUuid();
  const status = options.status ?? 'ACTIVE';

  for (let attempt = 1; attempt <= MAX_SHORT_CODE_ATTEMPTS; attempt++) {
    try {
      await trx
        .insertInto('identity_devices')
        .values({
          id: toBin(id),
          short_code: randomShortCode(),
          enrolled_by_user_id: toBin(enrolledByUserId),
          status,
          status_changed_at: options.statusChangedAt ?? new Date(),
          approved_by: status === 'ACTIVE' ? toBin(enrolledByUserId) : null,
          created_by: toBin(enrolledByUserId),
        })
        .execute();
      return id;
    } catch (error) {
      const isDuplicateShortCode =
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ER_DUP_ENTRY' &&
        (error as { message?: string }).message?.includes('short_code');
      if (!isDuplicateShortCode || attempt === MAX_SHORT_CODE_ATTEMPTS) throw error;
    }
  }
  /* istanbul ignore next -- la boucle retourne ou lève systématiquement */
  throw new Error('Impossible d’attribuer un code court unique (test).');
}

/**
 * Permission de test (préfixe `test.*`, jamais en collision avec le catalogue réel —
 * convention db/tests). Upsert (comme db/seeds/run.ts) : `identity_permissions` est une
 * vraie table (aucun DELETE accordé à gic_app, aucun rollback ici entre exécutions
 * successives des tests e2e/pipeline, qui réutilisent le même code littéral).
 */
export async function insertTestPermission(trx: UnitOfWork, code: string): Promise<void> {
  await trx
    .insertInto('identity_permissions')
    .values({
      code,
      module: 'test',
      description: 'Permission de test',
      supported_scopes: '["ALL"]',
    })
    .onDuplicateKeyUpdate({ description: 'Permission de test' })
    .execute();
}

export interface TestRoleOptions {
  readonly allowedScopeTypes?: readonly ('GLOBAL' | 'SITE' | 'ZONE' | 'TEAM')[];
}

export async function insertTestRole(
  trx: UnitOfWork,
  createdBy: string,
  options: TestRoleOptions = {},
): Promise<string> {
  const id = freshUuid();
  // Les 12 premiers hex de l'UUIDv7 encodent l'horodatage (uuid.ts) : peu de variation
  // entre deux appels rapprochés. Les 20 derniers (rand_b) sont la partie aléatoire —
  // c'est elle qui garantit l'absence de collision de `code` (unique) entre exécutions.
  const code = `TEST_ROLE_${id.replace(/-/g, '').slice(-20).toUpperCase()}`;
  await trx
    .insertInto('identity_roles')
    .values({
      id: toBin(id),
      code,
      name: 'Rôle de test',
      allowed_scope_types: JSON.stringify(options.allowedScopeTypes ?? ['GLOBAL']),
      created_by: toBin(createdBy),
    })
    .execute();
  return id;
}

export interface TestRolePermissionOptions {
  readonly maxScope?: 'OWN' | 'TEAM' | 'SITE' | 'ZONE' | 'ALL';
  readonly limits?: Record<string, unknown>;
}

export async function grantTestPermission(
  trx: UnitOfWork,
  roleId: string,
  permissionCode: string,
  grantedBy: string,
  options: TestRolePermissionOptions = {},
): Promise<void> {
  await trx
    .insertInto('identity_role_permissions')
    .values({
      role_id: toBin(roleId),
      permission_code: permissionCode,
      max_scope: options.maxScope ?? 'ALL',
      limits: options.limits !== undefined ? JSON.stringify(options.limits) : null,
      granted_by: toBin(grantedBy),
    })
    .execute();
}

export interface TestAssignmentOptions {
  readonly validFrom?: Date;
  readonly validTo?: Date | null;
  readonly revokedAt?: Date | null;
  readonly scopeType?: 'GLOBAL' | 'SITE' | 'ZONE' | 'TEAM';
  readonly scopeSiteId?: string;
  readonly scopeZoneId?: string;
  readonly scopeTeamId?: string;
}

export async function assignTestRole(
  trx: UnitOfWork,
  userId: string,
  roleId: string,
  createdBy: string,
  options: TestAssignmentOptions = {},
): Promise<string> {
  const id = freshUuid();
  await trx
    .insertInto('identity_user_role_assignments')
    .values({
      id: toBin(id),
      user_id: toBin(userId),
      role_id: toBin(roleId),
      scope_type: options.scopeType ?? 'GLOBAL',
      scope_site_id: options.scopeSiteId !== undefined ? toBin(options.scopeSiteId) : null,
      scope_zone_id: options.scopeZoneId !== undefined ? toBin(options.scopeZoneId) : null,
      scope_team_id: options.scopeTeamId !== undefined ? toBin(options.scopeTeamId) : null,
      valid_from: options.validFrom ?? new Date('2020-01-01T00:00:00.000Z'),
      valid_to: options.validTo ?? null,
      revoked_at: options.revokedAt ?? null,
      created_by: toBin(createdBy),
    })
    .execute();
  return id;
}

/** Zone de test (organization.zones) — maintient `zone_ancestors` comme le ferait un
 * gestionnaire de commande réel (dictionnaire §zone_ancestors : « maintenue par le
 * gestionnaire de commande à la création ou au déplacement d'une zone »). */
export async function insertTestZone(
  trx: UnitOfWork,
  createdBy: string,
  options: { readonly parentId?: string } = {},
): Promise<string> {
  const id = freshUuid();
  const code = `TEST_ZONE_${id.replace(/-/g, '').slice(-20).toUpperCase()}`;
  let depth = 1;
  if (options.parentId !== undefined) {
    const parent = await trx
      .selectFrom('organization_zones')
      .select('depth')
      .where('id', '=', toBin(options.parentId))
      .executeTakeFirstOrThrow();
    depth = parent.depth + 1;
  }
  await trx
    .insertInto('organization_zones')
    .values({
      id: toBin(id),
      parent_id: options.parentId !== undefined ? toBin(options.parentId) : null,
      level: 'SECTEUR',
      code,
      name: 'Zone de test',
      depth,
      created_by: toBin(createdBy),
    })
    .execute();

  await trx
    .insertInto('organization_zone_ancestors')
    .values({ zone_id: toBin(id), ancestor_id: toBin(id), depth: 0 })
    .execute();
  if (options.parentId !== undefined) {
    const parentAncestors = await trx
      .selectFrom('organization_zone_ancestors')
      .select(['ancestor_id', 'depth'])
      .where('zone_id', '=', toBin(options.parentId))
      .execute();
    for (const ancestor of parentAncestors) {
      await trx
        .insertInto('organization_zone_ancestors')
        .values({
          zone_id: toBin(id),
          ancestor_id: ancestor.ancestor_id,
          depth: ancestor.depth + 1,
        })
        .execute();
    }
  }
  return id;
}

export async function insertTestSite(
  trx: UnitOfWork,
  createdBy: string,
  zoneId: string,
): Promise<string> {
  const id = freshUuid();
  const code = id.replace(/-/g, '').slice(-8).toUpperCase();
  await trx
    .insertInto('organization_sites')
    .values({
      id: toBin(id),
      code,
      name: 'Site de test',
      site_type: 'MAGASIN',
      zone_id: toBin(zoneId),
      created_by: toBin(createdBy),
    })
    .execute();
  return id;
}

export async function insertTestTeam(
  trx: UnitOfWork,
  managerUserId: string,
  createdBy: string,
): Promise<string> {
  const id = freshUuid();
  const code = `TEST_TEAM_${id.replace(/-/g, '').slice(-20).toUpperCase()}`;
  await trx
    .insertInto('organization_teams')
    .values({
      id: toBin(id),
      code,
      name: 'Équipe de test',
      manager_user_id: toBin(managerUserId),
      created_by: toBin(createdBy),
    })
    .execute();
  return id;
}

export async function insertTestTeamMembership(
  trx: UnitOfWork,
  teamId: string,
  userId: string,
  createdBy: string,
  options: { readonly validFrom?: Date; readonly validTo?: Date | null } = {},
): Promise<void> {
  await trx
    .insertInto('organization_team_memberships')
    .values({
      id: toBin(freshUuid()),
      team_id: toBin(teamId),
      user_id: toBin(userId),
      valid_from: options.validFrom ?? new Date('2020-01-01T00:00:00.000Z'),
      valid_to: options.validTo ?? null,
      created_by: toBin(createdBy),
    })
    .execute();
}

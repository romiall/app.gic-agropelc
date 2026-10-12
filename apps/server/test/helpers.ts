/**
 * Utilitaires des tests d'intégration serveur : connexion à `SERVER_DATABASE_URL` (base déjà
 * migrée, identifiants `gic_app` — voir apps/server/.env.example), équivalent Kysely de
 * `db/tests/helpers.ts::withRollback` (mysql2 brut). Kysely n'expose pas de `rollback()`
 * manuel sur une transaction : `db.transaction().execute(cb)` valide si `cb` réussit, annule
 * s'il lève — `withTestUow` force donc systématiquement un rejet interne (sentinelle) après
 * avoir capturé le résultat ou l'erreur réels de `fn`, pour un rollback garanti quel que soit
 * l'issue testée (comme `withRollback`, dont c'est l'équivalent).
 */
import { randomInt } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { SystemClock, Uuidv7Generator, businessDayOf } from '@gic/domain';
import { createDatabase, type DB } from '../src/platform/kysely/database.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { OperationType } from '../src/modules/approvals/application/commands/operation-types.js';

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

/** Erreur MySQL de doublon sur l'index (ou la colonne) `key`. */
export function isDuplicateKey(error: unknown, key: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY' &&
    ((error as { message?: string }).message?.includes(key) ?? false)
  );
}

/** Numéro national de test : `6` puis 8 chiffres (aléa cryptographique, 10^8 numéros). */
export function drawLocalPhone(): string {
  return `6${String(randomInt(100_000_000)).padStart(8, '0')}`;
}

const MAX_PHONE_DRAWS = 20;
/** Numéros déjà délivrés par ce processus (forme nationale), insérés ou non. */
const issuedPhones = new Set<string>();

export interface FreshPhoneOptions {
  /** Lecture de contrôle ; défaut : la connexion partagée. Une transaction y voit ses propres lignes. */
  readonly executor?: Kysely<DB>;
  /** Tirage (tests du générateur) ; défaut : `drawLocalPhone`. */
  readonly draw?: () => string;
}

async function phoneTaken(executor: Kysely<DB>, e164: string): Promise<boolean> {
  const user = await executor
    .selectFrom('identity_users')
    .select('id')
    .where('active_phone', '=', e164)
    .limit(1)
    .executeTakeFirst();
  if (user !== undefined) return true;
  const customer = await executor
    .selectFrom('crm_customers')
    .select('id')
    .where((eb) => eb.or([eb('phone_primary', '=', e164), eb('phone_secondary', '=', e164)]))
    .limit(1)
    .executeTakeFirst();
  return customer !== undefined;
}

/**
 * Numéro national de test (`6XXXXXXXX`, la forme saisie sur le terrain) libre au moment du tirage :
 * jamais délivré par ce processus, ni porté (forme E.164) par un utilisateur actif ou suspendu
 * (`uq_identity_users_active_phone`) ni par un client (principal ou secondaire ;
 * `uq_crm_customers_phone`). Un tirage brut ne suffisait pas : la base partagée garde les fixtures
 * validées des exécutions précédentes (des milliers de numéros), d'où des collisions réelles à
 * l'échelle d'une suite. Reste la ligne validée par un fichier parallèle entre ce contrôle et
 * l'insertion : `insertTestUser` la couvre par un nouvel essai.
 */
export async function freshLocalPhone(options: FreshPhoneOptions = {}): Promise<string> {
  const executor = options.executor ?? db;
  const draw = options.draw ?? drawLocalPhone;
  for (let attempt = 1; attempt <= MAX_PHONE_DRAWS; attempt++) {
    const local = draw();
    if (issuedPhones.has(local)) continue;
    issuedPhones.add(local);
    if (!(await phoneTaken(executor, `+237${local}`))) return local;
  }
  throw new Error(`Aucun numéro de test libre après ${MAX_PHONE_DRAWS} tirages.`);
}

/** `freshLocalPhone` sous sa forme E.164 (`+2376XXXXXXXX`), celle des colonnes `phone`. */
export async function freshPhone(options: FreshPhoneOptions = {}): Promise<string> {
  return `+237${await freshLocalPhone(options)}`;
}

export interface TestUserOptions {
  readonly status?: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  readonly statusChangedAt?: Date | null;
  /** Tirage du numéro (tests du générateur) ; défaut : `drawLocalPhone`. */
  readonly drawPhone?: () => string;
}

/**
 * Insère un utilisateur minimal (auto-référencé comme created_by, comme le bootstrap seed).
 * `status_reason` obligatoire dès que le statut n'est pas ACTIVE (ck_identity_users_status_reason).
 * Téléphone : `freshPhone`, puis nouvel essai si un fichier parallèle a validé le même numéro entre
 * le contrôle et l'insertion (un doublon n'annule que l'instruction, pas la transaction).
 */
export async function insertTestUser(
  trx: UnitOfWork,
  options: TestUserOptions = {},
): Promise<string> {
  const id = freshUuid();
  const status = options.status ?? 'ACTIVE';
  for (let attempt = 1; attempt <= MAX_PHONE_DRAWS; attempt++) {
    const phone = await freshPhone({
      executor: trx,
      ...(options.drawPhone !== undefined ? { draw: options.drawPhone } : {}),
    });
    try {
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
    } catch (error) {
      if (!isDuplicateKey(error, 'uq_identity_users_active_phone') || attempt === MAX_PHONE_DRAWS) {
        throw error;
      }
    }
  }
  /* istanbul ignore next -- la boucle retourne ou lève systématiquement */
  throw new Error('Impossible d’attribuer un téléphone unique (test).');
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
      if (!isDuplicateKey(error, 'short_code') || attempt === MAX_SHORT_CODE_ATTEMPTS) throw error;
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
  options: { readonly siteType?: string } = {},
): Promise<string> {
  const id = freshUuid();
  const code = id.replace(/-/g, '').slice(-8).toUpperCase();
  await trx
    .insertInto('organization_sites')
    .values({
      id: toBin(id),
      code,
      name: 'Site de test',
      site_type: options.siteType ?? 'MAGASIN',
      zone_id: toBin(zoneId),
      created_by: toBin(createdBy),
    })
    .execute();
  return id;
}

export async function insertTestLocation(
  trx: UnitOfWork,
  createdBy: string,
  siteId: string,
  options: { readonly locationType?: string; readonly parentLocationId?: string } = {},
): Promise<string> {
  const id = freshUuid();
  const code = id.replace(/-/g, '').slice(-8).toUpperCase();
  await trx
    .insertInto('organization_locations')
    .values({
      id: toBin(id),
      site_id: toBin(siteId),
      code,
      name: 'Emplacement de test',
      location_type: options.locationType ?? 'STORE',
      ...(options.parentLocationId !== undefined
        ? { parent_location_id: toBin(options.parentLocationId) }
        : {}),
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

/**
 * Politiques de contrôle et base partagée persistante : `currentPolicies` renvoie TOUTE politique
 * ACTIVE applicable à l'instant de l'opération, la plus récemment entrée en vigueur d'abord, quel
 * que soit son `code` ou le test qui l'a créée. Deux utilitaires pour qu'un test ne dépende pas des
 * politiques laissées par les autres (ces tests commitent réellement, jamais de rollback).
 *
 * Retire les politiques ACTIVES de `operationType` et renvoie la fonction qui les restaure **telles
 * qu'elles étaient** : `status` ET `valid_to`. Remettre `valid_to` à `null` ferait d'une politique
 * bornée à sa journée de test une politique sans fin, qui finirait par s'imposer aux tests
 * dépendant de l'heure réelle (échec de production-sync-projections le 08/10/2026).
 */
export async function retireActivePolicies(
  operationType: OperationType,
  retiredAt: Date,
): Promise<() => Promise<void>> {
  const active = await db
    .selectFrom('approvals_control_policies')
    .select(['id', 'valid_to'])
    .where('operation_type', '=', operationType)
    .where('status', '=', 'ACTIVE')
    .execute();
  await db
    .updateTable('approvals_control_policies')
    .set({ status: 'RETIRED', valid_to: retiredAt })
    .where('operation_type', '=', operationType)
    .where('status', '=', 'ACTIVE')
    .execute();
  // Une requête par `valid_to` distinct plutôt que par ligne : la base partagée accumule des
  // centaines de politiques d'un même type, et chaque exécution en ajoute.
  const byValidTo = new Map<number | null, { validTo: Date | null; ids: Buffer[] }>();
  for (const row of active) {
    const key = row.valid_to === null ? null : row.valid_to.getTime();
    const group = byValidTo.get(key) ?? { validTo: row.valid_to, ids: [] };
    group.ids.push(row.id);
    byValidTo.set(key, group);
  }
  return async () => {
    for (const { validTo, ids } of byValidTo.values()) {
      await db
        .updateTable('approvals_control_policies')
        .set({ status: 'ACTIVE', valid_to: validTo })
        .where('id', 'in', ids)
        .execute();
    }
  };
}

/** Exécute `fn` sans aucune politique ACTIVE de `operationType`, puis restaure exactement l'existant. */
export async function withoutActivePolicies<T>(
  operationType: OperationType,
  retiredAt: Date,
  fn: () => Promise<T>,
): Promise<T> {
  const restore = await retireActivePolicies(operationType, retiredAt);
  try {
    return await fn();
  } finally {
    await restore();
  }
}

/**
 * Rend une politique créée par un test inoffensive pour les suivants : retirée, avec une fenêtre de
 * validité vide (`valid_to` = `valid_from`). À appeler en `afterAll` par les tests dont la
 * politique couvre l'heure réelle, qui sinon resterait applicable aux tests datés du même jour.
 */
export async function neutralizePolicy(policyId: string): Promise<void> {
  await db
    .updateTable('approvals_control_policies')
    .set((eb) => ({ status: 'RETIRED', valid_to: eb.ref('valid_from') }))
    .where('id', '=', toBin(policyId))
    .execute();
}

/**
 * P5-14 : ouvre une session de caisse sur une caisse de PDV, directement en base, pour les tests qui
 * encaissent des espèces au point de vente sans tester les sessions elles-mêmes (BR-DIS-005 : un
 * encaissement en ligne exige une session ouverte). Fonds d'ouverture = solde du registre avant
 * `openedAt` : aucun écart d'ouverture, donc aucun mouvement `SESSION_VARIANCE` qui fausserait un solde
 * attendu par le test. La session reste ouverte et couvre toutes les dates postérieures à `openedAt`.
 */
export async function openTestCashSession(
  executor: Kysely<DB> | UnitOfWork,
  input: {
    readonly cashAccountId: string;
    readonly siteId: string;
    readonly openedBy: string;
    readonly openedAt: Date;
  },
): Promise<string> {
  const row = await executor
    .selectFrom('finance_cash_movements')
    .select(
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount_xaf ELSE -amount_xaf END), 0)`.as(
        'balance',
      ),
    )
    .where('cash_account_id', '=', toBin(input.cashAccountId))
    .where('occurred_at', '<', input.openedAt)
    .executeTakeFirstOrThrow();
  const balance = Number(row.balance);
  const sessionId = freshUuid();
  await executor
    .insertInto('finance_cash_sessions')
    .values({
      id: toBin(sessionId),
      cash_account_id: toBin(input.cashAccountId),
      site_id: toBin(input.siteId),
      opened_by: toBin(input.openedBy),
      opened_at: input.openedAt,
      opening_counted_xaf: balance,
      opening_expected_xaf: balance,
      opening_variance_xaf: 0,
      status: 'OPEN',
      created_by: toBin(input.openedBy),
    })
    .execute();
  return sessionId;
}

/** Jour métier `AAAA-MM-JJ` décalé de `days` jours (arithmétique sur la date seule). */
export function shiftBusinessDay(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** Dernier jour du mois du jour métier `day`. */
export function monthEndOf(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Jour métier (Douala) d'il y a `daysAgo` jours à l'heure **réelle**. Pour les données lues par
 * une fenêtre que la base évalue à `UTC_TIMESTAMP` (jeu `crm_activity` : 90 jours ; réceptions :
 * 30 jours) : des dates fixes finiraient par sortir de la fenêtre.
 */
export function recentBusinessDay(daysAgo: number): string {
  return businessDayOf(new Date(Date.now() - daysAgo * 86_400_000));
}

/**
 * Produit de marchandise comptée à la tête (`TETE`), sans suivi de lot, avec sa catégorie : la base
 * minimale des tests de stock (mouvements, quotas, transferts). `lotTracking` : `NONE` (défaut).
 */
export async function insertTestProduct(
  trx: UnitOfWork,
  createdBy: string,
  options: { readonly lotTracking?: string } = {},
): Promise<string> {
  const categoryId = freshUuid();
  await trx
    .insertInto('catalog_product_categories')
    .values({
      id: toBin(categoryId),
      code: `CAT-${categoryId.slice(-8)}`,
      name: 'Test',
      created_by: toBin(createdBy),
    })
    .execute();
  const unit = await trx
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', 'TETE')
    .executeTakeFirst();
  if (!unit) {
    await trx
      .insertInto('catalog_units')
      .values({ code: 'TETE', name: 'Tête', is_count: 1 })
      .execute();
  }
  const productId = freshUuid();
  await trx
    .insertInto('catalog_products')
    .values({
      id: toBin(productId),
      code: `PRD-${productId.slice(-8)}`,
      name: 'Produit de test',
      category_id: toBin(categoryId),
      stock_family: 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: options.lotTracking ?? 'NONE',
      created_by: toBin(createdBy),
    })
    .execute();
  return productId;
}

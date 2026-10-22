/**
 * Vues sauvegardées (P9-19 ; ADR-077 §1 et §2, BR-ANA-007, dictionnaire `analytics.saved_views`) : le module
 * `analytics` est le seul à écrire `analytics_saved_views`. Une vue appartient à son créateur ; le partage se fait
 * par rôles (liste dans `shared_with_roles`) et **ne donne aucun droit** : l'exécutant la lit avec ses propres droits.
 * Une seule vue est la vue par défaut d'un rôle (clé unique de la base).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface StoredView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly dataset: string;
  readonly definition: unknown;
  readonly catalogVersion: number;
  readonly sharedWithRoles: readonly string[];
  readonly isDefaultForRole: string | null;
  readonly updatedAt: Date;
  readonly version: number;
}

const COLUMNS = [
  'id',
  'owner_user_id',
  'name',
  'dataset',
  'definition',
  'catalog_version',
  'shared_with_roles',
  'is_default_for_role',
  'updated_at',
  'version',
] as const;

interface ViewRow {
  readonly id: Buffer;
  readonly owner_user_id: Buffer;
  readonly name: string;
  readonly dataset: string;
  readonly definition: unknown;
  readonly catalog_version: number;
  readonly shared_with_roles: unknown;
  readonly is_default_for_role: string | null;
  readonly updated_at: Date;
  readonly version: number;
}

const rolesOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((role): role is string => typeof role === 'string') : [];

const viewOf = (row: ViewRow): StoredView => ({
  id: fromBin(row.id),
  ownerUserId: fromBin(row.owner_user_id),
  name: row.name,
  dataset: row.dataset,
  definition: row.definition,
  catalogVersion: row.catalog_version,
  sharedWithRoles: rolesOf(row.shared_with_roles),
  isDefaultForRole: row.is_default_for_role,
  updatedAt: row.updated_at,
  version: row.version,
});

/** Une vue par son identifiant, sans verrou. */
export async function readView(executor: Executor, id: string): Promise<StoredView | undefined> {
  const row = await executor
    .selectFrom('analytics_saved_views')
    .select(COLUMNS)
    .where('id', '=', toBin(id))
    .executeTakeFirst();
  return row === undefined ? undefined : viewOf(row as ViewRow);
}

/** Une vue verrouillée en écriture (début de toute commande qui la modifie). */
export async function lockView(uow: Transaction<DB>, id: string): Promise<StoredView | undefined> {
  const row = await uow
    .selectFrom('analytics_saved_views')
    .select(COLUMNS)
    .where('id', '=', toBin(id))
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : viewOf(row as ViewRow);
}

/** Le nom est-il déjà pris par une autre vue du même propriétaire ? */
export async function ownerHasViewNamed(
  executor: Executor,
  input: { readonly ownerUserId: string; readonly name: string; readonly exceptViewId: string },
): Promise<boolean> {
  const row = await executor
    .selectFrom('analytics_saved_views')
    .select('id')
    .where('owner_user_id', '=', toBin(input.ownerUserId))
    .where('name', '=', input.name)
    .where('id', '<>', toBin(input.exceptViewId))
    .executeTakeFirst();
  return row !== undefined;
}

export interface ViewContent {
  readonly name: string;
  readonly dataset: string;
  readonly definition: unknown;
  readonly catalogVersion: number;
}

export async function insertView(
  uow: Transaction<DB>,
  input: ViewContent & { readonly id: string; readonly ownerUserId: string },
): Promise<void> {
  await uow
    .insertInto('analytics_saved_views')
    .values({
      id: toBin(input.id),
      owner_user_id: toBin(input.ownerUserId),
      name: input.name,
      dataset: input.dataset,
      definition: jsonValue(input.definition),
      catalog_version: input.catalogVersion,
      created_by: toBin(input.ownerUserId),
    })
    .execute();
}

export async function updateViewContent(
  uow: Transaction<DB>,
  input: ViewContent & { readonly id: string; readonly updatedBy: string },
): Promise<void> {
  await uow
    .updateTable('analytics_saved_views')
    .set({
      name: input.name,
      dataset: input.dataset,
      definition: jsonValue(input.definition),
      catalog_version: input.catalogVersion,
      updated_by: toBin(input.updatedBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.id))
    .execute();
}

/** Remplace la liste des rôles destinataires ; `keepDefault` est la vue par défaut conservée (ou `null`). */
export async function updateViewShare(
  uow: Transaction<DB>,
  input: {
    readonly id: string;
    readonly roles: readonly string[];
    readonly updatedBy: string;
    readonly keepDefault: string | null;
  },
): Promise<void> {
  await uow
    .updateTable('analytics_saved_views')
    .set({
      shared_with_roles: jsonValue(input.roles),
      is_default_for_role: input.keepDefault,
      updated_by: toBin(input.updatedBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.id))
    .execute();
}

/** La vue qui est la vue par défaut du rôle, s'il y en a une (autre que `exceptViewId`), verrouillée. */
export async function defaultViewOfRole(
  uow: Transaction<DB>,
  roleCode: string,
  exceptViewId: string,
): Promise<StoredView | undefined> {
  const row = await uow
    .selectFrom('analytics_saved_views')
    .select(COLUMNS)
    .where('is_default_for_role', '=', roleCode)
    .where('id', '<>', toBin(exceptViewId))
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : viewOf(row as ViewRow);
}

/** Pose (ou retire, `null`) la vue par défaut d'un rôle sur la vue ; l'ancienne vue du rôle doit déjà être libérée. */
export async function setViewDefault(
  uow: Transaction<DB>,
  input: { readonly id: string; readonly roleCode: string | null; readonly updatedBy: string | null },
): Promise<void> {
  await uow
    .updateTable('analytics_saved_views')
    .set({
      is_default_for_role: input.roleCode,
      updated_by: toBinOrNull(input.updatedBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.id))
    .execute();
}

/** Suppression physique, auditée par le pipeline (objet de confort, dictionnaire). */
export async function deleteView(uow: Transaction<DB>, id: string): Promise<void> {
  await uow.deleteFrom('analytics_saved_views').where('id', '=', toBin(id)).execute();
}

/**
 * Les vues que le lecteur voit : les siennes, et celles partagées avec l'un de ses rôles. Les plus récemment
 * modifiées d'abord ; borné.
 */
export async function visibleViews(
  executor: Executor,
  input: { readonly userId: string; readonly roleCodes: readonly string[]; readonly limit: number },
): Promise<readonly StoredView[]> {
  const sharedWithReader =
    input.roleCodes.length === 0
      ? sql<boolean>`FALSE`
      : sql<boolean>`JSON_OVERLAPS(shared_with_roles, CAST(${JSON.stringify(input.roleCodes)} AS JSON))`;
  const rows = await executor
    .selectFrom('analytics_saved_views')
    .select(COLUMNS)
    .where((eb) =>
      eb.or([eb('owner_user_id', '=', toBin(input.userId)), eb(sharedWithReader, '=', sql<boolean>`TRUE`)]),
    )
    .orderBy('updated_at', 'desc')
    .orderBy('id')
    .limit(input.limit)
    .execute();
  return rows.map((row) => viewOf(row as ViewRow));
}

/** Une vue est-elle visible du lecteur (la sienne, ou partagée avec l'un de ses rôles) ? */
export const viewVisibleTo = (
  view: StoredView,
  reader: { readonly userId: string; readonly roleCodes: readonly string[] },
): boolean =>
  view.ownerUserId === reader.userId ||
  view.sharedWithRoles.some((role) => reader.roleCodes.includes(role));

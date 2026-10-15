/**
 * Lectures des comptes utilisateurs (MP-08 ; ECR-ADM-04 partiel ; dictionnaire `identity.users`) pour la
 * couche de transport (`GET /users`). Aucune décision d'autorisation ici : `identity-api/` évalue la
 * portée de chaque compte. Jamais `password_hash` ; l'utilisateur système (`is_system`) n'est jamais
 * listé. Pagination par curseur, du plus récent au plus ancien sur `id`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserSummary {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly status: UserStatus;
  readonly statusChangedAt: Date | null;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

function selectUsers(executor: Executor) {
  return executor
    .selectFrom('identity_users')
    .select([
      'id',
      'full_name',
      'phone',
      'email',
      'status',
      'status_changed_at',
      'must_change_password',
      'last_login_at',
      'created_at',
    ])
    .where('is_system', '=', 0);
}

type UserRow = Awaited<ReturnType<ReturnType<typeof selectUsers>['executeTakeFirstOrThrow']>>;

function toSummary(row: UserRow): UserSummary {
  return {
    id: fromBin(row.id),
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    status: row.status as UserStatus,
    statusChangedAt: row.status_changed_at,
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

/**
 * Page de comptes, filtres facultatifs : état, recherche (nom ou téléphone contenant le texte) ; du plus
 * récent au plus ancien.
 */
export async function listUsersPage(
  executor: Executor,
  filter: {
    readonly status?: UserStatus;
    readonly query?: string;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<{ readonly items: readonly UserSummary[]; readonly nextCursor: string | null }> {
  const query = filter.query?.trim();
  const like = query ? `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : undefined;
  const rows = await selectUsers(executor)
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(like !== undefined, (qb) =>
      qb.where((eb) => eb.or([eb('full_name', 'like', like!), eb('phone', 'like', like!)])),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    items: page.map(toSummary),
    nextCursor: hasMore ? fromBin(page[page.length - 1]!.id) : null,
  };
}

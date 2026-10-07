/**
 * Lectures d'identité pour l'accueil par rôle (ADR-030) : nom affichable, effectifs d'appareils et
 * d'utilisateurs. Aucune donnée d'authentification n'est exposée.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Nom complet d'un utilisateur ; `undefined` si inconnu. */
export async function userFullName(
  executor: Executor,
  userId: string,
): Promise<string | undefined> {
  const row = await executor
    .selectFrom('identity_users')
    .select('full_name')
    .where('id', '=', toBin(userId))
    .executeTakeFirst();
  return row?.full_name;
}

/** Noms de plusieurs utilisateurs (affichage d'activités) ; les inconnus sont absents du résultat. */
export async function userFullNames(
  executor: Executor,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await executor
    .selectFrom('identity_users')
    .select(['id', 'full_name'])
    .where(
      'id',
      'in',
      [...new Set(userIds)].map((id) => toBin(id)),
    )
    .execute();
  return new Map(rows.map((row) => [fromBin(row.id), row.full_name]));
}

export interface DeviceUserCounts {
  readonly activeDevices: number;
  /** Appareils enrôlés en attente d'approbation (ECR-ADM-05). */
  readonly pendingDevices: number;
  readonly blockedDevices: number;
  readonly activeUsers: number;
}

export async function deviceUserCounts(executor: Executor): Promise<DeviceUserCounts> {
  const devices = await executor
    .selectFrom('identity_devices')
    .select([
      sql<string>`COALESCE(SUM(status = 'ACTIVE'), 0)`.as('active'),
      sql<string>`COALESCE(SUM(status = 'PENDING'), 0)`.as('pending'),
      sql<string>`COALESCE(SUM(status IN ('BLOCKED', 'LOST')), 0)`.as('blocked'),
    ])
    .executeTakeFirstOrThrow();
  const users = await executor
    .selectFrom('identity_users')
    .select(sql<string>`COUNT(*)`.as('count'))
    .where('status', '=', 'ACTIVE')
    .where('is_system', '=', 0)
    .executeTakeFirstOrThrow();
  return {
    activeDevices: Number(devices.active),
    pendingDevices: Number(devices.pending),
    blockedDevices: Number(devices.blocked),
    activeUsers: Number(users.count),
  };
}

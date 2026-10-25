/**
 * Affectations de rôle actives de plusieurs utilisateurs, avec leur identifiant (ECR-ADM-04, MP-13) :
 * l'écran des comptes révoque une affectation par son identifiant, ce que `activeRoleAssignmentsAt`
 * (qui rend seulement le rôle et le périmètre) ne permet pas. Mêmes règles d'activité que
 * `assignment-query.ts` (RC-01) : commencée, ni terminée ni révoquée à `at`, rôle actif.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface ListedAssignment {
  readonly id: string;
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly scopeType: string;
  readonly scopeSiteId: string | null;
  readonly scopeZoneId: string | null;
  readonly scopeTeamId: string | null;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

export async function listActiveAssignmentsOfUsers(
  executor: Executor,
  userIds: readonly string[],
  at: Date,
): Promise<ReadonlyMap<string, readonly ListedAssignment[]>> {
  const byUser = new Map<string, ListedAssignment[]>();
  if (userIds.length === 0) return byUser;
  const rows = await executor
    .selectFrom('identity_user_role_assignments as a')
    .innerJoin('identity_roles as r', 'r.id', 'a.role_id')
    .select([
      'a.id',
      'a.user_id',
      'a.role_id',
      'r.code',
      'r.name',
      'r.is_active',
      'a.scope_type',
      'a.scope_site_id',
      'a.scope_zone_id',
      'a.scope_team_id',
      'a.valid_from',
      'a.valid_to',
      'a.revoked_at',
    ])
    .where(
      'a.user_id',
      'in',
      userIds.map((id) => toBin(id)),
    )
    .where('a.valid_from', '<=', at)
    .orderBy('a.valid_from', 'asc')
    .orderBy('a.id', 'asc')
    .execute();
  for (const row of rows) {
    if (!row.is_active) continue;
    if (row.valid_to !== null && row.valid_to <= at) continue;
    if (row.revoked_at !== null && row.revoked_at <= at) continue;
    const userId = fromBin(row.user_id);
    const list = byUser.get(userId) ?? [];
    list.push({
      id: fromBin(row.id),
      roleId: fromBin(row.role_id),
      roleCode: row.code,
      roleName: row.name,
      scopeType: row.scope_type,
      scopeSiteId: row.scope_site_id ? fromBin(row.scope_site_id) : null,
      scopeZoneId: row.scope_zone_id ? fromBin(row.scope_zone_id) : null,
      scopeTeamId: row.scope_team_id ? fromBin(row.scope_team_id) : null,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    });
    byUser.set(userId, list);
  }
  return byUser;
}

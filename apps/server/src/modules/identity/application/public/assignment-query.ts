/**
 * Périmètres concrets des affectations d'un utilisateur à un instant (RC-01 : affectation
 * active à `at`). API publique d'`identity` pour les modules qui raisonnent sur l'affectation
 * d'un utilisateur sans décision d'autorisation — ex. `fieldwork`, BR-TER-006 : « la zone
 * déclarée est choisie parmi les zones affectées à l'utilisateur (affectations de rôle de
 * portée ZONE) » ; `crm`, BR-CRM-003 : titulaire « s'il a un rôle commercial », rattachement
 * au site d'un vendeur de PDV.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface ActiveAssignment {
  readonly roleCode: string;
  readonly scopeType: string;
  readonly scopeSiteId: string | null;
  readonly scopeZoneId: string | null;
}

async function activeAssignmentsAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<readonly ActiveAssignment[]> {
  const rows = await executor
    .selectFrom('identity_user_role_assignments as a')
    .innerJoin('identity_roles as r', 'r.id', 'a.role_id')
    .select(['r.code', 'r.is_active', 'a.scope_type', 'a.scope_site_id', 'a.scope_zone_id'])
    .select(['a.valid_to', 'a.revoked_at'])
    .where('a.user_id', '=', toBin(userId))
    .where('a.valid_from', '<=', at)
    .execute();
  return rows
    .filter(
      (row) =>
        Boolean(row.is_active) &&
        (row.valid_to === null || row.valid_to > at) &&
        (row.revoked_at === null || row.revoked_at > at),
    )
    .map((row) => ({
      roleCode: row.code,
      scopeType: row.scope_type,
      scopeSiteId: row.scope_site_id ? fromBin(row.scope_site_id) : null,
      scopeZoneId: row.scope_zone_id ? fromBin(row.scope_zone_id) : null,
    }));
}

/** Affectations de rôle actives à `at` avec leur périmètre (accueil par rôle : périmètre de chaque rôle). */
export async function activeRoleAssignmentsAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<readonly ActiveAssignment[]> {
  return activeAssignmentsAt(executor, userId, at);
}

/** Zones des affectations de portée `ZONE` actives à `at` (sans doublon). */
export async function activeZoneAssignmentsAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<readonly string[]> {
  const zones = new Set<string>();
  for (const assignment of await activeAssignmentsAt(executor, userId, at)) {
    if (assignment.scopeType === 'ZONE' && assignment.scopeZoneId)
      zones.add(assignment.scopeZoneId);
  }
  return [...zones];
}

/** Sites des affectations de portée `SITE` actives à `at` (sans doublon). */
export async function activeSiteAssignmentsAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<readonly string[]> {
  const sites = new Set<string>();
  for (const assignment of await activeAssignmentsAt(executor, userId, at)) {
    if (assignment.scopeType === 'SITE' && assignment.scopeSiteId)
      sites.add(assignment.scopeSiteId);
  }
  return [...sites];
}

/** Codes des rôles actifs affectés à l'utilisateur à `at` (sans doublon). */
export async function activeRoleCodesAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<readonly string[]> {
  return [...new Set((await activeAssignmentsAt(executor, userId, at)).map((a) => a.roleCode))];
}

/**
 * Cache mémoire des affectations RBAC d'un utilisateur (identity_user_role_assignments ⋈
 * identity_role_permissions), P0-10 (docs/10-development-plan/06-passage-au-
 * developpement.md §3 : « cache invalidé par événement »).
 *
 * Périmètre volontaire : toutes les lignes d'affectation de l'utilisateur, y compris
 * expirées/révoquées, pas seulement « actives maintenant ». RC-01 (01-rbac.md §4) exige une
 * évaluation **à `occurred_at`**, qui peut être dans le passé (rejeu hors ligne, rétrodatage
 * — ADR-016) : ne garder que les affectations actives « maintenant » rendrait le cache faux
 * pour ce cas, très réel en pratique. Le filtre `occurred_at` reste appliqué en mémoire à
 * chaque appel (`rights-check.ts`), jamais ici.
 *
 * Portée du cache : **mémoire du seul processus API**, jamais celle du worker
 * (worker.module.ts n'importe pas `IdentityModule` — rien n'y déclenche jamais
 * l'enregistrement de ce cache ni de son consommateur d'invalidation, `rbac-cache-
 * consumer.ts`). C'est un choix : le worker traite l'outbox pour des effets durables
 * (numérotation, projections) sur un rythme qui tolère la latence ; ce cache-ci n'a de sens
 * que colocalisé avec les évaluations RBAC qu'il accélère, donc dans le processus qui les
 * fait (l'API, seule à recevoir `/commands` et `/auth/*`).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

export type MaxScope = 'OWN' | 'TEAM' | 'SITE' | 'ZONE' | 'ALL';
export type AffectationScopeType = 'GLOBAL' | 'SITE' | 'ZONE' | 'TEAM';

export interface CachedGrant {
  readonly permissionCode: string;
  readonly maxScope: MaxScope;
  readonly limits: Record<string, unknown> | null;
  readonly scopeType: AffectationScopeType;
  readonly scopeSiteId: string | null;
  readonly scopeZoneId: string | null;
  readonly scopeTeamId: string | null;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly revokedAt: Date | null;
}

const grantsByUser = new Map<string, readonly CachedGrant[]>();

/** Chargée à la demande (premier appel pour cet utilisateur dans ce processus), puis mise en cache. */
export async function getUserGrants(
  executor: Kysely<DB> | Transaction<DB>,
  userId: string,
): Promise<readonly CachedGrant[]> {
  const cached = grantsByUser.get(userId);
  if (cached) return cached;

  const rows = await executor
    .selectFrom('identity_user_role_assignments as ura')
    .innerJoin('identity_role_permissions as rp', 'rp.role_id', 'ura.role_id')
    .select([
      'rp.permission_code',
      'rp.max_scope',
      'rp.limits',
      'ura.scope_type',
      'ura.scope_site_id',
      'ura.scope_zone_id',
      'ura.scope_team_id',
      'ura.valid_from',
      'ura.valid_to',
      'ura.revoked_at',
    ])
    .where('ura.user_id', '=', toBin(userId))
    .execute();

  const grants: CachedGrant[] = rows.map((row) => ({
    permissionCode: row.permission_code,
    maxScope: row.max_scope as MaxScope,
    limits: (row.limits as Record<string, unknown> | null) ?? null,
    scopeType: row.scope_type as AffectationScopeType,
    scopeSiteId: fromBinOrNull(row.scope_site_id),
    scopeZoneId: fromBinOrNull(row.scope_zone_id),
    scopeTeamId: fromBinOrNull(row.scope_team_id),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    revokedAt: row.revoked_at,
  }));
  grantsByUser.set(userId, grants);
  return grants;
}

/** Vrai à `occurredAt` (RC-01) : `valid_from ≤ t < coalesce(revoked_at, valid_to, ∞)`. */
export function isGrantActiveAt(grant: CachedGrant, occurredAt: Date): boolean {
  if (grant.validFrom > occurredAt) return false;
  if (grant.validTo !== null && grant.validTo <= occurredAt) return false;
  if (grant.revokedAt !== null && grant.revokedAt <= occurredAt) return false;
  return true;
}

export function invalidateUser(userId: string): void {
  grantsByUser.delete(userId);
}

export function invalidateAll(): void {
  grantsByUser.clear();
}

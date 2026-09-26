/**
 * Périmètres concrets des affectations d'un utilisateur à un instant (RC-01 : affectation
 * active à `at`). API publique d'`identity` pour les modules qui raisonnent sur la zone
 * d'affectation d'un utilisateur sans décision d'autorisation — ex. `fieldwork`, BR-TER-006 :
 * « la zone déclarée est choisie parmi les zones affectées à l'utilisateur (affectations de rôle
 * de portée ZONE) ».
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Zones des affectations de portée `ZONE` actives à `at` (sans doublon). */
export async function activeZoneAssignmentsAt(
  executor: Kysely<DB> | Transaction<DB>,
  userId: string,
  at: Date,
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('identity_user_role_assignments')
    .select(['scope_zone_id', 'valid_to', 'revoked_at'])
    .where('user_id', '=', toBin(userId))
    .where('scope_type', '=', 'ZONE')
    .where('valid_from', '<=', at)
    .execute();
  const zones = new Set<string>();
  for (const row of rows) {
    if (row.valid_to !== null && row.valid_to <= at) continue;
    if (row.revoked_at !== null && row.revoked_at <= at) continue;
    if (row.scope_zone_id) zones.add(fromBin(row.scope_zone_id));
  }
  return [...zones];
}

/**
 * Membres d'une équipe à un instant (`organization.team_memberships`) : lecture publique pour
 * les consultations ancrées sur une équipe (ex. `GET /work-sessions?team_id=`, P3-06). La
 * décision d'autorisation reste à l'appelant.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export async function listTeamMembersAt(
  executor: Kysely<DB> | Transaction<DB>,
  teamId: string,
  at: Date,
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('organization_team_memberships')
    .select('user_id')
    .where('team_id', '=', toBin(teamId))
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .execute();
  return [...new Set(rows.map((row) => fromBin(row.user_id)))];
}

/** Membres, à `at`, des équipes dont l'utilisateur est le responsable (`manager_user_id`). */
export async function listManagedTeamMembersAt(
  executor: Kysely<DB> | Transaction<DB>,
  managerUserId: string,
  at: Date,
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('organization_team_memberships as m')
    .innerJoin('organization_teams as t', 't.id', 'm.team_id')
    .select('m.user_id')
    .where('t.manager_user_id', '=', toBin(managerUserId))
    .where('m.valid_from', '<=', at)
    .where((eb) => eb.or([eb('m.valid_to', 'is', null), eb('m.valid_to', '>', at)]))
    .execute();
  return [...new Set(rows.map((row) => fromBin(row.user_id)))];
}

/** Équipes dont l'utilisateur est membre à `at` (audience `TEAM` du flux de synchronisation). */
export async function listTeamsOfUserAt(
  executor: Kysely<DB> | Transaction<DB>,
  userId: string,
  at: Date,
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('organization_team_memberships')
    .select('team_id')
    .where('user_id', '=', toBin(userId))
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .execute();
  return [...new Set(rows.map((row) => fromBin(row.team_id)))];
}

/**
 * Membres d'une équipe à un instant (`organization.team_memberships`) : lecture publique pour
 * les consultations ancrées sur une équipe (ex. `GET /work-sessions?team_id=`, P3-06). La
 * décision d'autorisation reste à l'appelant.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export interface TeamMemberSummary {
  readonly membershipId: string;
  readonly userId: string;
  readonly since: Date;
}

export interface TeamSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly managerUserId: string;
  readonly isActive: boolean;
  readonly version: number;
  /** Membres à l'instant demandé (un utilisateur n'est membre que d'une équipe à la fois). */
  readonly members: readonly TeamMemberSummary[];
}

/**
 * Équipes avec leurs membres à `at` (S-28, RP-1 ; `GET /teams`), par code. La décision d'autorisation
 * (équipes visibles du lecteur) reste à la couche de transport.
 */
export async function listTeams(
  executor: Kysely<DB> | Transaction<DB>,
  at: Date,
): Promise<readonly TeamSummary[]> {
  const teams = await executor
    .selectFrom('organization_teams')
    .selectAll()
    .orderBy('code', 'asc')
    .execute();
  if (teams.length === 0) return [];
  const memberships = await executor
    .selectFrom('organization_team_memberships')
    .select(['id', 'team_id', 'user_id', 'valid_from'])
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .orderBy('valid_from', 'asc')
    .execute();
  const byTeam = new Map<string, TeamMemberSummary[]>();
  for (const row of memberships) {
    const teamId = fromBin(row.team_id);
    const list = byTeam.get(teamId) ?? [];
    list.push({
      membershipId: fromBin(row.id),
      userId: fromBin(row.user_id),
      since: row.valid_from,
    });
    byTeam.set(teamId, list);
  }
  return teams.map((team) => ({
    id: fromBin(team.id),
    code: team.code,
    name: team.name,
    managerUserId: fromBin(team.manager_user_id),
    isActive: Boolean(team.is_active),
    version: team.version,
    members: byTeam.get(fromBin(team.id)) ?? [],
  }));
}

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

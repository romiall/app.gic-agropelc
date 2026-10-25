/**
 * Écriture d'une affectation de rôle (`identity.user_role_assignments`) avec les contrôles applicatifs
 * qui précèdent les contraintes du serveur (trigger `trg_identity_ura_scope_allowed`, FK vers
 * `organization.sites/zones/teams`) : sans eux, une valeur invalide remonterait comme une erreur SQL
 * brute que le pipeline traiterait à tort comme transitoire (`RETRY_LATER`) au lieu d'un rejet
 * définitif.
 *
 * Partagé par la commande `identity.role_assignment.grant` et par la création d'un compte
 * (`POST /users`, MP-13, AV-325), qui pose l'affectation initiale dans la même transaction. Le module
 * `identity` est le seul propriétaire de la table (règle 5 de `CLAUDE.md`).
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';

export type AssignmentScopeType = 'GLOBAL' | 'SITE' | 'ZONE' | 'TEAM';

export interface RoleAssignmentInput {
  readonly assignmentId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly scopeType: AssignmentScopeType;
  readonly scopeSiteId?: string | undefined;
  readonly scopeZoneId?: string | undefined;
  readonly scopeTeamId?: string | undefined;
  readonly validFrom: Date;
  readonly validTo?: Date | undefined;
  readonly createdBy: string;
}

/** Refus d'une affectation : code stable et message français. */
export interface RoleAssignmentRefusal {
  readonly code: 'NOT_FOUND' | 'ROLE_INACTIVE' | 'SCOPE_TYPE_NOT_ALLOWED';
  readonly message: string;
}

/** Contrôle puis écrit l'affectation ; `null` quand elle est écrite, sinon le motif du refus. */
export async function insertRoleAssignment(
  uow: UnitOfWork,
  input: RoleAssignmentInput,
): Promise<RoleAssignmentRefusal | null> {
  const targetUser = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('id', '=', toBin(input.userId))
    .executeTakeFirst();
  if (!targetUser) return { code: 'NOT_FOUND', message: 'Utilisateur introuvable.' };

  const role = await uow
    .selectFrom('identity_roles')
    .select(['is_active', 'allowed_scope_types'])
    .where('id', '=', toBin(input.roleId))
    .executeTakeFirst();
  if (!role) return { code: 'NOT_FOUND', message: 'Rôle introuvable.' };
  if (!role.is_active) return { code: 'ROLE_INACTIVE', message: 'Ce rôle est désactivé.' };
  const allowedScopeTypes = role.allowed_scope_types as readonly string[];
  if (!allowedScopeTypes.includes(input.scopeType)) {
    return {
      code: 'SCOPE_TYPE_NOT_ALLOWED',
      message: `Le rôle n'autorise pas le type de périmètre ${input.scopeType} (roles.allowed_scope_types).`,
    };
  }

  if (input.scopeSiteId !== undefined) {
    const site = await uow
      .selectFrom('organization_sites')
      .select('id')
      .where('id', '=', toBin(input.scopeSiteId))
      .executeTakeFirst();
    if (!site) return { code: 'NOT_FOUND', message: 'Site introuvable (scopeSiteId).' };
  }
  if (input.scopeZoneId !== undefined) {
    const zone = await uow
      .selectFrom('organization_zones')
      .select('id')
      .where('id', '=', toBin(input.scopeZoneId))
      .executeTakeFirst();
    if (!zone) return { code: 'NOT_FOUND', message: 'Zone introuvable (scopeZoneId).' };
  }
  if (input.scopeTeamId !== undefined) {
    const team = await uow
      .selectFrom('organization_teams')
      .select('id')
      .where('id', '=', toBin(input.scopeTeamId))
      .executeTakeFirst();
    if (!team) return { code: 'NOT_FOUND', message: 'Équipe introuvable (scopeTeamId).' };
  }

  await uow
    .insertInto('identity_user_role_assignments')
    .values({
      id: toBin(input.assignmentId),
      user_id: toBin(input.userId),
      role_id: toBin(input.roleId),
      scope_type: input.scopeType,
      scope_site_id: input.scopeSiteId !== undefined ? toBin(input.scopeSiteId) : null,
      scope_zone_id: input.scopeZoneId !== undefined ? toBin(input.scopeZoneId) : null,
      scope_team_id: input.scopeTeamId !== undefined ? toBin(input.scopeTeamId) : null,
      valid_from: input.validFrom,
      valid_to: input.validTo ?? null,
      created_by: toBin(input.createdBy),
    })
    .execute();
  return null;
}

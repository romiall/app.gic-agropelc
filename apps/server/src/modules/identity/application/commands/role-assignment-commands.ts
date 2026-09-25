/**
 * Octroi et révocation d'une affectation de rôle (01-rbac.md §1 « Affectation » ; permission
 * `identity.role_assignment.manage`, ALL réservé à ADMIN — 01-rbac.md §5.1). Chaque octroi/
 * révocation applique la commande générique (BR-SYN-007), écrit un événement de domaine
 * (`platform_domain_events`, automatique — command-pipeline.service.ts §6) dont
 * `rbac/rbac-cache-consumer.ts` se sert pour invalider le cache RBAC de l'utilisateur visé
 * (P0-10, « cache invalidé par événement »).
 *
 * `identity_user_role_assignments` est `IMMUABLE` sauf fermeture (trigger `trg_identity_ura_
 * update_guard`, INV-ADM-04) : la révocation ne touche que `revoked_at`/`revoked_by`/
 * `revoke_reason`/`version`, jamais les colonnes de définition de l'affectation.
 *
 * Contrôles applicatifs redondants avec les contraintes serveur (trigger `trg_identity_ura_
 * scope_allowed`, FK vers organization.sites/zones/teams) : sans eux, une valeur invalide
 * remonterait comme une erreur SQL brute que le pipeline traiterait à tort comme transitoire
 * (RETRY_LATER) plutôt que comme un rejet définitif — même raisonnement que la vérification
 * d'unicité du téléphone dans `user-commands.ts::create`.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { hasOtherActiveAdminAssignment } from './admin-guard.js';

const scopeTypeSchema = z.enum(['GLOBAL', 'SITE', 'ZONE', 'TEAM']);

const grantPayloadSchema = z
  .object({
    userId: z.string().uuid(),
    roleId: z.string().uuid(),
    scopeType: scopeTypeSchema,
    scopeSiteId: z.string().uuid().optional(),
    scopeZoneId: z.string().uuid().optional(),
    scopeTeamId: z.string().uuid().optional(),
    validTo: z.string().datetime().optional(),
  })
  .superRefine((data, ctx) => {
    const scopeCols = {
      SITE: data.scopeSiteId,
      ZONE: data.scopeZoneId,
      TEAM: data.scopeTeamId,
    } as const;
    const providedCount = Object.values(scopeCols).filter((v) => v !== undefined).length;
    if (data.scopeType === 'GLOBAL' && providedCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scopeType GLOBAL ne doit porter aucun scopeSiteId/scopeZoneId/scopeTeamId.',
      });
      return;
    }
    if (data.scopeType !== 'GLOBAL') {
      const expectedField: Record<'SITE' | 'ZONE' | 'TEAM', string> = {
        SITE: 'scopeSiteId',
        ZONE: 'scopeZoneId',
        TEAM: 'scopeTeamId',
      };
      const expected = scopeCols[data.scopeType];
      if (expected === undefined || providedCount !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scopeType ${data.scopeType} exige exactement ${expectedField[data.scopeType]}, aucun autre.`,
        });
      }
    }
  });

const revokePayloadSchema = z.object({ reason: z.string().min(1).max(500) });

type GrantPayload = z.infer<typeof grantPayloadSchema>;
type RevokePayload = z.infer<typeof revokePayloadSchema>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function invalid(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const grant: CommandHandler<GrantPayload> = async (uow, envelope) => {
  const assignmentId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('identity_user_role_assignments')
    .select('id')
    .where('id', '=', assignmentId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent (même aggregate_id)

  const { userId, roleId, scopeType, scopeSiteId, scopeZoneId, scopeTeamId, validTo } =
    envelope.payload;

  const targetUser = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('id', '=', toBin(userId))
    .executeTakeFirst();
  if (!targetUser) return notFound('Utilisateur introuvable.');

  const role = await uow
    .selectFrom('identity_roles')
    .select(['is_active', 'allowed_scope_types'])
    .where('id', '=', toBin(roleId))
    .executeTakeFirst();
  if (!role) return notFound('Rôle introuvable.');
  if (!role.is_active) return invalid('ROLE_INACTIVE', 'Ce rôle est désactivé.');
  const allowedScopeTypes = role.allowed_scope_types as readonly string[];
  if (!allowedScopeTypes.includes(scopeType)) {
    return invalid(
      'SCOPE_TYPE_NOT_ALLOWED',
      `Le rôle n'autorise pas le type de périmètre ${scopeType} (roles.allowed_scope_types).`,
    );
  }

  if (scopeSiteId !== undefined) {
    const site = await uow
      .selectFrom('organization_sites')
      .select('id')
      .where('id', '=', toBin(scopeSiteId))
      .executeTakeFirst();
    if (!site) return notFound('Site introuvable (scopeSiteId).');
  }
  if (scopeZoneId !== undefined) {
    const zone = await uow
      .selectFrom('organization_zones')
      .select('id')
      .where('id', '=', toBin(scopeZoneId))
      .executeTakeFirst();
    if (!zone) return notFound('Zone introuvable (scopeZoneId).');
  }
  if (scopeTeamId !== undefined) {
    const team = await uow
      .selectFrom('organization_teams')
      .select('id')
      .where('id', '=', toBin(scopeTeamId))
      .executeTakeFirst();
    if (!team) return notFound('Équipe introuvable (scopeTeamId).');
  }

  const occurredAt = new Date(envelope.occurred_at);
  await uow
    .insertInto('identity_user_role_assignments')
    .values({
      id: assignmentId,
      user_id: toBin(userId),
      role_id: toBin(roleId),
      scope_type: scopeType,
      scope_site_id: scopeSiteId !== undefined ? toBin(scopeSiteId) : null,
      scope_zone_id: scopeZoneId !== undefined ? toBin(scopeZoneId) : null,
      scope_team_id: scopeTeamId !== undefined ? toBin(scopeTeamId) : null,
      valid_from: occurredAt,
      valid_to: validTo !== undefined ? new Date(validTo) : null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

const revoke: CommandHandler<RevokePayload> = async (uow, envelope) => {
  const assignmentId = envelope.aggregate_id;
  const assignment = await uow
    .selectFrom('identity_user_role_assignments as ura')
    .innerJoin('identity_roles as r', 'r.id', 'ura.role_id')
    .select(['ura.revoked_at', 'r.code as role_code'])
    .where('ura.id', '=', toBin(assignmentId))
    .executeTakeFirst();
  if (!assignment) return notFound('Affectation introuvable.');
  if (assignment.revoked_at !== null) return { status: 'APPLIED' }; // rejeu idempotent

  const occurredAt = new Date(envelope.occurred_at);
  if (assignment.role_code === 'ADMIN') {
    if (!(await hasOtherActiveAdminAssignment(uow, assignmentId, occurredAt))) {
      return invalid(
        'LAST_ADMIN',
        'Impossible : aucune autre affectation ADMIN active ne resterait (INV-ADM-01).',
      );
    }
  }

  await uow
    .updateTable('identity_user_role_assignments')
    .set({
      revoked_at: occurredAt,
      revoked_by: toBin(envelope.author_user_id),
      revoke_reason: envelope.payload.reason,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(assignmentId))
    .execute();
  return { status: 'APPLIED' };
};

export function registerRoleAssignmentCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'identity.role_assignment.grant',
    version: 1,
    payloadSchema: grantPayloadSchema,
    permissionCode: 'identity.role_assignment.manage',
    handler: grant,
  });
  registry.register({
    commandType: 'identity.role_assignment.revoke',
    version: 1,
    payloadSchema: revokePayloadSchema,
    permissionCode: 'identity.role_assignment.manage',
    handler: revoke,
  });
}

// Ré-exportée pour rbac-cache-consumer.ts (lecture du payload d'un événement déjà écrit,
// pas un nouvel appel de commande) — évite de dupliquer les noms des deux command_type.
export const ROLE_ASSIGNMENT_EVENT_TYPES = [
  'identity.role_assignment.grant',
  'identity.role_assignment.revoke',
] as const;

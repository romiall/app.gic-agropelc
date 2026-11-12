/**
 * `identity.role.permission.set` (questionnaire de clôture, Q28 du 08/11/2026 ; ADR-072, AV-553) : l'Admin et la
 * Direction (permission `identity.role.manage`, portée `ALL`) accordent une permission à un rôle, en changent la
 * portée ou la retirent, avec un motif. Agrégat `ROLE` (l'identifiant de la commande est celui du rôle).
 *
 * Gardes (`judgeRolePermissionChange`, packages/domain, partagée avec l'écran) : on ne donne que ce qu'on a et on ne
 * retire que ce qu'on aurait pu donner (portées de l'auteur par ses seules affectations globales en vigueur à
 * `occurred_at`) ; le rôle `ADMIN` est figé ; `identity.role.manage` ne se modifie jamais dans l'application.
 *
 * Écritures : `identity_role_permissions` (l'état en vigueur ; un retrait supprime la ligne, l'historique est dans le
 * journal) et `identity_role_permission_changes` (journal en ajout seul, une ligne par commande : la graine ne revient
 * plus jamais sur ce couple). L'audit du pipeline reçoit la portée avant et après ; l'événement du pipeline (type de la
 * commande) invalide tout le cache RBAC de l'API (`rbac-cache-consumer.ts`). Un octroi fait dans l'application ne porte
 * aucune limite (`limits` nul) : les limites restent celles de la graine.
 */
import { z } from 'zod';
import {
  PERMISSION_SCOPES,
  isPermissionScope,
  judgeRolePermissionChange,
  type PermissionScope,
  type RolePermissionRefusal,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { heldGlobalScopes } from '../rbac/rbac-cache.js';

export const ROLE_PERMISSION_SET_COMMAND = 'identity.role.permission.set';
export const ROLE_MANAGE_PERMISSION = 'identity.role.manage';

const payloadSchema = z.object({
  permissionCode: z.string().min(1).max(80),
  /** Portée voulue ; `null` : retrait. */
  maxScope: z.enum(PERMISSION_SCOPES).nullable(),
  reason: z.string().trim().min(1).max(500),
});
type Payload = z.infer<typeof payloadSchema>;

const REFUSAL_MESSAGES: Readonly<Record<RolePermissionRefusal, string>> = {
  ROLE_PROTECTED:
    'Les droits du rôle Administrateur ne se modifient pas dans l’application (ADR-072).',
  PERMISSION_PROTECTED:
    'Le droit de modifier les droits des rôles ne se modifie pas dans l’application (ADR-072).',
  NO_CHANGE: 'Le rôle a déjà ce droit à cette portée : rien à changer.',
  SCOPE_NOT_SUPPORTED: 'Cette permission n’admet pas cette portée.',
  NOT_HELD:
    'On ne donne ou ne retire que ce qu’on détient soi-même, à une portée au moins égale (ADR-072).',
};

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const setPermission: CommandHandler<Payload> = async (uow, envelope) => {
  const roleId = envelope.aggregate_id;
  const { permissionCode, maxScope: requested, reason } = envelope.payload;
  const occurredAt = new Date(envelope.occurred_at);

  // Rejeu d'une commande déjà appliquée : le journal la connaît.
  const replay = await uow
    .selectFrom('identity_role_permission_changes')
    .select('id')
    .where('command_id', '=', toBin(envelope.command_id))
    .executeTakeFirst();
  if (replay) return { status: 'APPLIED' };

  const role = await uow
    .selectFrom('identity_roles')
    .select(['code', 'is_active'])
    .where('id', '=', toBin(roleId))
    .executeTakeFirst();
  if (!role) return rejected('NOT_FOUND', 'Rôle introuvable.');
  if (!role.is_active) return rejected('ROLE_INACTIVE', 'Ce rôle est désactivé.');

  const permission = await uow
    .selectFrom('identity_permissions')
    .select(['supported_scopes', 'deprecated_at'])
    .where('code', '=', permissionCode)
    .executeTakeFirst();
  if (!permission) return rejected('NOT_FOUND', 'Permission introuvable.');
  if (permission.deprecated_at !== null) {
    return rejected('PERMISSION_DEPRECATED', 'Cette permission n’est plus en service.');
  }

  // Lecture verrouillante : deux changements simultanés du même droit se succèdent.
  const grant = await uow
    .selectFrom('identity_role_permissions')
    .select('max_scope')
    .where('role_id', '=', toBin(roleId))
    .where('permission_code', '=', permissionCode)
    .forUpdate()
    .executeTakeFirst();
  const current: PermissionScope | null =
    grant && isPermissionScope(grant.max_scope) ? grant.max_scope : null;

  // Portées de l'auteur pour cette permission : ses seules affectations globales en vigueur à `occurred_at`.
  const editorScopes =
    (await heldGlobalScopes(uow, envelope.author_user_id, occurredAt)).get(permissionCode) ?? [];

  const supported = Array.isArray(permission.supported_scopes)
    ? (permission.supported_scopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const judgement = judgeRolePermissionChange({
    roleCode: role.code,
    permissionCode,
    current,
    requested,
    supportedScopes: supported,
    editorScopes,
  });
  if (!judgement.ok) return rejected(judgement.refusal, REFUSAL_MESSAGES[judgement.refusal]);

  if (judgement.changeType === 'GRANT') {
    await uow
      .insertInto('identity_role_permissions')
      .values({
        role_id: toBin(roleId),
        permission_code: permissionCode,
        max_scope: requested!,
        limits: null,
        granted_by: toBin(envelope.author_user_id),
      })
      .execute();
  } else if (judgement.changeType === 'SCOPE') {
    await uow
      .updateTable('identity_role_permissions')
      .set({ max_scope: requested! })
      .where('role_id', '=', toBin(roleId))
      .where('permission_code', '=', permissionCode)
      .execute();
  } else {
    await uow
      .deleteFrom('identity_role_permissions')
      .where('role_id', '=', toBin(roleId))
      .where('permission_code', '=', permissionCode)
      .execute();
  }
  await uow
    .insertInto('identity_role_permission_changes')
    .values({
      id: toBin(envelope.command_id),
      role_id: toBin(roleId),
      permission_code: permissionCode,
      change_type: judgement.changeType,
      scope_before: current,
      scope_after: requested,
      reason,
      changed_by: toBin(envelope.author_user_id),
      changed_at: occurredAt,
      command_id: toBin(envelope.command_id),
    })
    .execute();

  return {
    status: 'APPLIED',
    audit: {
      before: { roleCode: role.code, permissionCode, maxScope: current },
      after: { roleCode: role.code, permissionCode, maxScope: requested, reason },
    },
  };
};

export function registerRolePermissionCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: ROLE_PERMISSION_SET_COMMAND,
    version: 1,
    payloadSchema,
    permissionCode: ROLE_MANAGE_PERMISSION,
    handler: setPermission,
  });
}

/**
 * ECR-ADM-09 « Droits des rôles » (questionnaire de clôture, Q28 du 08/11/2026 ; ADR-072) : modèle et logique pure de
 * l'écran. Les portées proposées et le retrait viennent du serveur (`GET /roles/{id}/permissions`), calculés par la
 * règle partagée `judgeRolePermissionChange` : l'écran ne propose que ce que la commande acceptera.
 */
import { PERMISSION_SCOPES, type PermissionScope } from '@gic/domain';
import type { AdminCommand } from '../admin/admin-online.js';

export const ROLE_PERMISSION_COMMAND = 'identity.role_permission.set';
/** Préfixe des commandes suivies par l'écran (une à la fois). */
export const ROLE_PERMISSION_PREFIX = 'identity.role_permission.';
/** Motif d'un changement : 500 caractères au plus, comme la commande. */
export const REASON_MAX = 500;

export interface EditableRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly editable: boolean;
}

export interface RolePermissionEntry {
  readonly code: string;
  readonly module: string;
  readonly description: string;
  readonly supportedScopes: readonly string[];
  readonly isApproval: boolean;
  readonly isSensitive: boolean;
  /** Portée accordée au rôle ; `null` : non accordée. */
  readonly maxScope: string | null;
  readonly editable: boolean;
  /** Portées que le lecteur peut donner (on ne donne que ce qu'on a). */
  readonly grantableScopes: readonly string[];
  /** Le lecteur peut retirer ce droit (il en détient une portée qui couvre celle du rôle). */
  readonly canRevoke: boolean;
}

export interface RolePermissionChange {
  readonly id: string;
  readonly permissionCode: string;
  readonly changeType: 'GRANT' | 'SCOPE' | 'REVOKE';
  readonly scopeBefore: string | null;
  readonly scopeAfter: string | null;
  readonly reason: string;
  readonly changedByUserId: string;
  readonly changedByName: string;
  readonly changedAt: string;
}

export interface EditableRolesResponse {
  readonly roles: readonly EditableRole[];
}

export interface RolePermissionsResponse {
  readonly role: EditableRole;
  readonly permissions: readonly RolePermissionEntry[];
  readonly changes: readonly RolePermissionChange[];
}

/** Valeur de la liste « Nouvelle portée » qui retire le droit. */
export const REVOKE_CHOICE = 'REVOKE';

/** Choix proposés pour un droit : les portées que le lecteur peut donner (sauf l'actuelle), puis le retrait. */
export function scopeChoices(entry: RolePermissionEntry): readonly string[] {
  const scopes = PERMISSION_SCOPES.filter(
    (scope) => entry.grantableScopes.includes(scope) && scope !== entry.maxScope,
  );
  return entry.canRevoke ? [...scopes, REVOKE_CHOICE] : scopes;
}

/** Le lecteur peut-il changer ce droit (au moins un choix) ? */
export function canChange(entry: RolePermissionEntry): boolean {
  return entry.editable && scopeChoices(entry).length > 0;
}

/** Droits filtrés (texte libre sur le code et la description ; accordés seulement), groupés par module. */
export function groupedPermissions(
  permissions: readonly RolePermissionEntry[],
  filter: { readonly text: string; readonly grantedOnly: boolean },
): readonly { readonly module: string; readonly entries: readonly RolePermissionEntry[] }[] {
  const needle = filter.text.trim().toLocaleLowerCase('fr');
  const kept = permissions.filter(
    (entry) =>
      (!filter.grantedOnly || entry.maxScope !== null) &&
      (needle === '' ||
        entry.code.toLocaleLowerCase('fr').includes(needle) ||
        entry.description.toLocaleLowerCase('fr').includes(needle)),
  );
  const modules = new Map<string, RolePermissionEntry[]>();
  for (const entry of kept) {
    const list = modules.get(entry.module) ?? [];
    list.push(entry);
    modules.set(entry.module, list);
  }
  return [...modules.entries()].map(([module, entries]) => ({ module, entries }));
}

/** Commande d'un changement : une portée, ou `null` pour le retrait ; motif nettoyé. */
export function permissionCommand(
  roleId: string,
  permissionCode: string,
  choice: string,
  reason: string,
): AdminCommand {
  const maxScope: PermissionScope | null =
    choice === REVOKE_CHOICE ? null : (choice as PermissionScope);
  return {
    commandType: ROLE_PERMISSION_COMMAND,
    aggregateType: 'ROLE',
    aggregateId: roleId,
    payload: { permissionCode, maxScope, reason: reason.trim() },
  };
}

/** Motif valable : non vide, 500 caractères au plus. */
export function reasonValid(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= REASON_MAX;
}

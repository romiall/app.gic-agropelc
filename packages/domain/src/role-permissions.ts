/**
 * Droits des rôles modifiables dans l'application (questionnaire de clôture, Q28 du 08/11/2026 : « permissions
 * modifiables par l'Admin et les profils de direction dans l'application » ; ADR-072, AV-553). Règle partagée par le
 * serveur (`identity.role_permission.set`) et l'écran de l'éditeur, qui ne propose que ce que le serveur acceptera.
 *
 * Gardes contre l'élévation de droits :
 * - **on ne donne que ce qu'on a** : accorder une permission ou en élargir la portée exige que l'auteur la détienne
 *   lui-même, par une affectation globale, à une portée qui couvre la portée demandée ;
 * - **on ne retire que ce qu'on aurait pu donner** : retirer une permission ou en réduire la portée exige que l'auteur
 *   en détienne une portée qui couvre la portée actuelle du rôle ;
 * - le rôle `ADMIN` est figé (rôle technique, seule la graine versionnée le change) et la permission
 *   `identity.role.manage` (modifier les droits) ne se modifie jamais dans l'application : personne ne peut s'en
 *   octroyer le pouvoir ni en priver l'Admin.
 */

export const PERMISSION_SCOPES = ['OWN', 'TEAM', 'SITE', 'ZONE', 'ALL'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/** Rôles dont les droits ne se modifient pas dans l'application. */
export const PROTECTED_ROLE_CODES: readonly string[] = ['ADMIN'];
/** Permissions qui ne se modifient pas dans l'application. */
export const PROTECTED_PERMISSION_CODES: readonly string[] = ['identity.role.manage'];

export function isPermissionScope(value: unknown): value is PermissionScope {
  return typeof value === 'string' && (PERMISSION_SCOPES as readonly string[]).includes(value);
}

/**
 * Une portée détenue couvre-t-elle une portée demandée ? `ALL` couvre tout ; une portée se couvre elle-même ; toute
 * portée couvre `OWN` ; `TEAM`, `SITE` et `ZONE` ne se couvrent pas entre elles.
 */
export function scopeCovers(held: PermissionScope, requested: PermissionScope): boolean {
  return held === 'ALL' || held === requested || requested === 'OWN';
}

/** L'une des portées détenues couvre-t-elle la portée demandée ? */
export function heldScopesCover(
  held: readonly PermissionScope[],
  requested: PermissionScope,
): boolean {
  return held.some((scope) => scopeCovers(scope, requested));
}

export type RolePermissionChangeType = 'GRANT' | 'SCOPE' | 'REVOKE';
export type RolePermissionRefusal =
  'ROLE_PROTECTED' | 'PERMISSION_PROTECTED' | 'NO_CHANGE' | 'SCOPE_NOT_SUPPORTED' | 'NOT_HELD';

export interface RolePermissionChangeInput {
  readonly roleCode: string;
  readonly permissionCode: string;
  /** Portée actuelle du rôle pour la permission ; `null` : non accordée. */
  readonly current: PermissionScope | null;
  /** Portée voulue ; `null` : retrait. */
  readonly requested: PermissionScope | null;
  /** Portées que la permission admet (`identity_permissions.supported_scopes`). */
  readonly supportedScopes: readonly string[];
  /** Portées auxquelles l'auteur détient la permission maintenant, par une affectation globale. */
  readonly editorScopes: readonly PermissionScope[];
}

export type RolePermissionJudgement =
  | { readonly ok: true; readonly changeType: RolePermissionChangeType }
  | { readonly ok: false; readonly refusal: RolePermissionRefusal };

/** Juge un changement de droit d'un rôle (ADR-072) ; aucune écriture, aucune entrée-sortie. */
export function judgeRolePermissionChange(
  input: RolePermissionChangeInput,
): RolePermissionJudgement {
  if (PROTECTED_ROLE_CODES.includes(input.roleCode))
    return { ok: false, refusal: 'ROLE_PROTECTED' };
  if (PROTECTED_PERMISSION_CODES.includes(input.permissionCode)) {
    return { ok: false, refusal: 'PERMISSION_PROTECTED' };
  }
  if (input.requested === input.current) return { ok: false, refusal: 'NO_CHANGE' };
  if (input.requested !== null && !input.supportedScopes.includes(input.requested)) {
    return { ok: false, refusal: 'SCOPE_NOT_SUPPORTED' };
  }
  // On ne donne que ce qu'on a ; on ne retire que ce qu'on aurait pu donner.
  if (input.requested !== null && !heldScopesCover(input.editorScopes, input.requested)) {
    return { ok: false, refusal: 'NOT_HELD' };
  }
  if (input.current !== null && !heldScopesCover(input.editorScopes, input.current)) {
    return { ok: false, refusal: 'NOT_HELD' };
  }
  const changeType: RolePermissionChangeType =
    input.current === null ? 'GRANT' : input.requested === null ? 'REVOKE' : 'SCOPE';
  return { ok: true, changeType };
}

/** Portées que l'auteur peut donner à un rôle pour une permission (celles que l'éditeur propose). */
export function grantableScopes(
  supportedScopes: readonly string[],
  editorScopes: readonly PermissionScope[],
): readonly PermissionScope[] {
  return PERMISSION_SCOPES.filter(
    (scope) => supportedScopes.includes(scope) && heldScopesCover(editorScopes, scope),
  );
}

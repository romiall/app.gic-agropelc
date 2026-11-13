/**
 * Plan de la graine des droits des rôles système (ADR-072 ; questionnaire de clôture, Q28 du 08/11/2026). Depuis que
 * l'Admin et la Direction modifient les droits d'un rôle dans l'application (`identity.role_permission.set`), un couple
 * (rôle, permission) qui a au moins une ligne dans `identity_role_permission_changes` garde la décision prise dans
 * l'application : la graine ne le réinsère pas (un droit retiré reste retiré) et ne réécrit ni sa portée ni ses limites.
 * Les autres couples sont posés comme avant (insertion, ou mise à jour de la portée et des limites).
 */

/** Clé d'un couple (rôle, permission) : identifiant du rôle en hexadécimal majuscule, puis le code. */
export function rolePermissionKey(roleIdHex: string, permissionCode: string): string {
  return `${roleIdHex.toUpperCase()}:${permissionCode}`;
}

export interface SeededGrant {
  readonly roleCode: string;
  readonly permissionCode: string;
}

export interface RolePermissionPlan<G extends SeededGrant> {
  /** Octrois du code à poser (insérés, ou portée et limites mises à jour). */
  readonly toWrite: readonly G[];
  /** Octrois du code laissés à la décision de l'application. */
  readonly kept: readonly G[];
}

export function planRolePermissionSeed<G extends SeededGrant>(
  grants: readonly G[],
  roleIdHexOf: (roleCode: string) => string,
  changedKeys: ReadonlySet<string>,
): RolePermissionPlan<G> {
  const toWrite: G[] = [];
  const kept: G[] = [];
  for (const grant of grants) {
    const key = rolePermissionKey(roleIdHexOf(grant.roleCode), grant.permissionCode);
    (changedKeys.has(key) ? kept : toWrite).push(grant);
  }
  return { toWrite, kept };
}

/**
 * ECR-ADM-04 « Utilisateurs et affectations de rôle » (MP-08, complété par MP-13 ; AV-252, AV-281,
 * AV-325, AV-326) : logique pure de l'écran.
 *
 * - Liste lue sur `GET /users` (portée du lecteur ; l'utilisateur système n'y figure jamais) ; chaque
 *   compte porte ses affectations actives (avec leur identifiant, nécessaire à la révocation) et les
 *   actions que le serveur permet au lecteur.
 * - Création d'un compte : `POST /users`, en ligne, **hors du journal des commandes** (AV-325, ADR-045)
 *   comme la réinitialisation : le mot de passe provisoire saisi par l'Admin ne passe ni par la file
 *   d'envoi ni par la base locale. Règles du mot de passe partagées avec le serveur
 *   (`newPasswordProblem` : 8 à 128 caractères, confirmation).
 * - Suspension, réactivation, désactivation, octroi et révocation de rôle : commandes `identity.user.*` et
 *   `identity.role_assignment.*` (droits ALL de l'Admin) émises par la file d'envoi, comme les appareils.
 * - Périmètres proposés : `GLOBAL` et `SITE` (AV-326) ; les zones et les équipes attendent `GET /zones` et
 *   `GET /teams` (S-19, S-28). Les permissions d'un rôle ne se modifient pas ici (AV-257, rôles figés).
 */
import { newPasswordProblem, normalizePhone, type NewPasswordProblem } from '@gic/domain';

export type ScopeType = 'GLOBAL' | 'SITE' | 'ZONE' | 'TEAM';

/** Affectation active d'un compte, renvoyée par `GET /api/v1/users`. */
export interface AssignmentView {
  readonly id: string;
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly scopeType: ScopeType;
  readonly scopeSiteId: string | null;
  readonly scopeZoneId: string | null;
  readonly scopeTeamId: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** Compte renvoyé par `GET /api/v1/users`. */
export interface UserView {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  readonly statusChangedAt: string | null;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly roles: readonly string[];
  readonly assignments: readonly AssignmentView[];
  readonly actions: {
    readonly resetPassword: boolean;
    readonly suspend: boolean;
    readonly reactivate: boolean;
    readonly deactivate: boolean;
    readonly manageRoles: boolean;
  };
}

/** Rôle renvoyé par `GET /api/v1/roles`. */
export interface RoleView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly allowedScopeTypes: readonly string[];
  readonly isSystem: boolean;
}

export type UserFilter = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'ALL';
export const USER_FILTERS: readonly UserFilter[] = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ALL'];

/** Chemin de lecture pour un filtre. */
export function usersPath(filter: UserFilter): string {
  return `/api/v1/users?limit=200${filter === 'ALL' ? '' : `&status=${filter}`}`;
}

export const ROLES_PATH = '/api/v1/roles';
export const CREATE_PATH = '/api/v1/users';

/** Recherche locale : nom ou téléphone contenant le texte (sans tenir compte des espaces du numéro). */
export function matchesSearch(user: UserView, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const digits = needle.replace(/\s+/g, '');
  return user.fullName.toLowerCase().includes(needle) || user.phone.includes(digits);
}

/** Tri pour l'affichage : par nom. */
export function sortByName(users: readonly UserView[]): UserView[] {
  return [...users].sort((a, b) => a.fullName.localeCompare(b.fullName, 'fr'));
}

/** Défaut de la saisie du mot de passe provisoire, ou `null`. */
export function resetProblem(password: string, confirmation: string): NewPasswordProblem | null {
  return newPasswordProblem({ password, confirmation });
}

export function resetPath(userId: string): string {
  return `/api/v1/users/${userId}/reset-password`;
}

export type ResetOutcome =
  | { readonly kind: 'DONE' }
  | { readonly kind: 'OFFLINE' }
  /** Refus du serveur : code et message français à afficher. */
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string | null };

/** Lecture du corps d'erreur `{ error: { code, message } }` d'une réponse refusée. */
export function refusalOf(body: unknown): { code: string; message: string | null } {
  const error =
    body !== null && typeof body === 'object' && 'error' in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    message: typeof error?.message === 'string' ? error.message : null,
  };
}

// --- Périmètres et affectations ------------------------------------------------------------------

/** Types de périmètre que l'écran propose (AV-326) ; zones et équipes attendent leurs lectures (S-19, S-28). */
export const ASSIGNABLE_SCOPES: readonly ScopeType[] = ['GLOBAL', 'SITE'];

/** Types de périmètre proposés pour un rôle : ceux que le rôle permet et que l'écran sait choisir. */
export function scopeTypesFor(role: Pick<RoleView, 'allowedScopeTypes'> | undefined): ScopeType[] {
  if (!role) return [];
  return ASSIGNABLE_SCOPES.filter((scope) => role.allowedScopeTypes.includes(scope));
}

/** Choix d'une affectation : rôle, type de périmètre et, pour `SITE`, le site. */
export interface AssignmentChoice {
  readonly roleId: string;
  readonly scopeType: ScopeType;
  readonly siteId: string;
}

export type AssignmentProblem = 'ROLE' | 'SCOPE' | 'SITE';

/** Défaut du choix d'une affectation, ou `null`. */
export function assignmentProblem(
  choice: AssignmentChoice,
  roles: readonly RoleView[],
): AssignmentProblem | null {
  const role = roles.find((candidate) => candidate.id === choice.roleId);
  if (!role) return 'ROLE';
  if (!scopeTypesFor(role).includes(choice.scopeType)) return 'SCOPE';
  if (choice.scopeType === 'SITE' && !choice.siteId) return 'SITE';
  return null;
}

/** Une affectation du même rôle et du même périmètre existe déjà sur le compte. */
export function alreadyAssigned(user: UserView, choice: AssignmentChoice): boolean {
  return user.assignments.some(
    (assignment) =>
      assignment.roleId === choice.roleId &&
      assignment.scopeType === choice.scopeType &&
      (choice.scopeType !== 'SITE' || assignment.scopeSiteId === choice.siteId),
  );
}

/** Charge de `identity.role_assignment.grant`. */
export function grantPayload(userId: string, choice: AssignmentChoice): Record<string, unknown> {
  return {
    userId,
    roleId: choice.roleId,
    scopeType: choice.scopeType,
    ...(choice.scopeType === 'SITE' ? { scopeSiteId: choice.siteId } : {}),
  };
}

/** Rôle d'un compte à créer, au format de `POST /users`. */
export function createRoleBody(choice: AssignmentChoice): Record<string, unknown> {
  return {
    role_id: choice.roleId,
    scope_type: choice.scopeType,
    ...(choice.scopeType === 'SITE' ? { scope_site_id: choice.siteId } : {}),
  };
}

// --- Changement d'état d'un compte ---------------------------------------------------------------

export type StatusAction = 'SUSPEND' | 'REACTIVATE' | 'DEACTIVATE';
export const REASON_MAX = 500;

/** Actions d'état proposées pour un compte, selon ce que le serveur permet au lecteur. */
export function statusActionsFor(user: UserView): StatusAction[] {
  const actions: StatusAction[] = [];
  if (user.actions.suspend) actions.push('SUSPEND');
  if (user.actions.reactivate) actions.push('REACTIVATE');
  if (user.actions.deactivate) actions.push('DEACTIVATE');
  return actions;
}

/** Un motif est exigé pour suspendre et désactiver (SM-USER), pas pour réactiver. */
export function statusReasonRequired(action: StatusAction): boolean {
  return action !== 'REACTIVATE';
}

/** L'action peut-elle partir avec ce motif ? */
export function canSendStatus(action: StatusAction, reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length > REASON_MAX) return false;
  return statusReasonRequired(action) ? trimmed.length > 0 : true;
}

export function statusCommand(
  action: StatusAction,
  reason: string,
): { commandType: string; payload: Record<string, unknown> } {
  const text = reason.trim();
  switch (action) {
    case 'SUSPEND':
      return { commandType: 'identity.user.suspend', payload: { reason: text } };
    case 'DEACTIVATE':
      return { commandType: 'identity.user.deactivate', payload: { reason: text } };
    case 'REACTIVATE':
      return { commandType: 'identity.user.reactivate', payload: {} };
  }
}

/** Charge de `identity.role_assignment.revoke` : le motif est obligatoire. */
export function revokePayload(reason: string): Record<string, unknown> {
  return { reason: reason.trim() };
}

// --- Création d'un compte ------------------------------------------------------------------------

/** Indicatif national par défaut (DÉDUIT : GIC opère au Cameroun, `crm.phone_default_country_code`). */
export const DEFAULT_COUNTRY_CODE = '237';

export interface NewUserForm {
  readonly fullName: string;
  readonly phone: string;
  readonly email: string;
  readonly password: string;
  readonly confirmation: string;
  readonly roleId: string;
  readonly scopeType: ScopeType;
  readonly siteId: string;
}

export const EMPTY_NEW_USER: NewUserForm = {
  fullName: '',
  phone: '',
  email: '',
  password: '',
  confirmation: '',
  roleId: '',
  scopeType: 'GLOBAL',
  siteId: '',
};

/** Numéro E.164 de la saisie (indicatif national par défaut), ou `null` si elle n'en est pas un. */
export function phoneOf(raw: string, countryCode: string = DEFAULT_COUNTRY_CODE): string | null {
  if (!raw.trim()) return null;
  try {
    return normalizePhone(raw, countryCode);
  } catch {
    return null;
  }
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NewUserProblem = 'NAME' | 'PHONE' | 'EMAIL' | AssignmentProblem | NewPasswordProblem;

/**
 * Premier défaut de la saisie d'un compte, ou `null`. Le rôle est facultatif : un compte sans rôle ne voit
 * rien et reçoit son affectation ensuite ; s'il est choisi, il doit être complet.
 */
export function newUserProblem(
  form: NewUserForm,
  roles: readonly RoleView[],
  countryCode: string = DEFAULT_COUNTRY_CODE,
): NewUserProblem | null {
  if (!form.fullName.trim()) return 'NAME';
  if (phoneOf(form.phone, countryCode) === null) return 'PHONE';
  if (form.email.trim() && !EMAIL_SHAPE.test(form.email.trim())) return 'EMAIL';
  if (form.roleId) {
    const problem = assignmentProblem(form, roles);
    if (problem) return problem;
  }
  return newPasswordProblem({ password: form.password, confirmation: form.confirmation });
}

/** Corps de `POST /users` (mot de passe provisoire inclus : jamais journalisé ni conservé). */
export function createBody(
  form: NewUserForm,
  countryCode: string = DEFAULT_COUNTRY_CODE,
): Record<string, unknown> {
  return {
    full_name: form.fullName.trim(),
    phone: phoneOf(form.phone, countryCode),
    ...(form.email.trim() ? { email: form.email.trim() } : {}),
    password: form.password,
    ...(form.roleId ? { role: createRoleBody(form) } : {}),
  };
}

export type CreateOutcome =
  | { readonly kind: 'CREATED'; readonly id: string }
  | { readonly kind: 'OFFLINE' }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string | null };

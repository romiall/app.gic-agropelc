/**
 * ECR-ADM-04 partiel « Utilisateurs » (MP-08 ; AV-252, AV-281) : logique pure de l'écran.
 *
 * - Liste lue sur `GET /users` (portée du lecteur ; l'utilisateur système n'y figure jamais) ; chaque
 *   compte porte l'action que le serveur permet au lecteur (`actions.resetPassword`).
 * - Réinitialisation : `POST /users/{id}/reset-password`, en ligne, **hors du journal des commandes**
 *   (AV-252) : le mot de passe saisi par l'Admin ne passe ni par la file d'envoi ni par la base locale.
 *   Règles partagées avec le serveur (`newPasswordProblem` : 8 à 128 caractères, confirmation).
 */
import { newPasswordProblem, type NewPasswordProblem } from '@gic/domain';

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
  readonly actions: { readonly resetPassword: boolean };
}

export type UserFilter = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'ALL';
export const USER_FILTERS: readonly UserFilter[] = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ALL'];

/** Chemin de lecture pour un filtre. */
export function usersPath(filter: UserFilter): string {
  return `/api/v1/users?limit=200${filter === 'ALL' ? '' : `&status=${filter}`}`;
}

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

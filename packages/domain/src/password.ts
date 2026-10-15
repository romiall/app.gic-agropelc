/**
 * Règles d'un nouveau mot de passe (MP-08 ; 02-securite.md §2 : 8 caractères au moins, AV-008 ;
 * AV-280), partagées par le serveur (création d'un compte, changement, réinitialisation par l'Admin)
 * et l'appareil (écran de changement imposé, AV-251 ; écran des utilisateurs, AV-252).
 *
 * - Longueur : de `PASSWORD_MIN_LENGTH` à `PASSWORD_MAX_LENGTH` caractères (borne haute : le hachage
 *   argon2id est coûteux ; AV-280).
 * - Un nouveau mot de passe ne peut pas être identique à celui qu'il remplace (AV-280) : sinon le
 *   changement imposé après une réinitialisation garderait le mot de passe provisoire.
 * - Aucune règle de composition, d'historique ni d'expiration (rien d'écrit dans les sources).
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** Mot de passe accepté à la connexion : borne de sûreté contre un hachage démesuré. */
export const LOGIN_PASSWORD_MAX_LENGTH = 256;

export type NewPasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'UNCHANGED' | 'MISMATCH';

/**
 * Premier défaut d'un nouveau mot de passe, ou `null`. `current` : le mot de passe remplacé, s'il est
 * connu ; `confirmation` : la seconde saisie, à l'écran.
 */
export function newPasswordProblem(input: {
  readonly password: string;
  readonly current?: string;
  readonly confirmation?: string;
}): NewPasswordProblem | null {
  const length = [...input.password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (length > PASSWORD_MAX_LENGTH) return 'TOO_LONG';
  if (input.current !== undefined && input.password === input.current) return 'UNCHANGED';
  if (input.confirmation !== undefined && input.password !== input.confirmation) return 'MISMATCH';
  return null;
}

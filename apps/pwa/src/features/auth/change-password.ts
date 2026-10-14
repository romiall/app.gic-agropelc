/**
 * `POST /api/v1/auth/change-password` (MP-08 ; AV-251, AV-280) : changement du mot de passe avec le
 * jeton d'accès de la connexion, avant la création du PIN (la session de l'appareil n'existe pas
 * encore : appel direct, comme `login.ts`). Jamais hors ligne : le serveur juge le mot de passe actuel.
 * Sans réponse dans le délai, l'appel est abandonné et compté hors ligne (MP-11, revue adverse).
 *
 * Aucun mot de passe n'est conservé par l'appareil : ni dans la base locale, ni dans un journal.
 */
import type { NewPasswordProblem } from '@gic/domain';
import { apiUrl } from '../../platform/env.js';

export type ChangePasswordResult =
  | { readonly ok: true }
  /** Mot de passe actuel incorrect. */
  | { readonly ok: false; readonly reason: 'INVALID_CURRENT' }
  /** Nouveau mot de passe refusé par les règles partagées. */
  | { readonly ok: false; readonly reason: 'INVALID_NEW'; readonly problem: NewPasswordProblem }
  /** Trop d'essais : verrouillage progressif. */
  | { readonly ok: false; readonly reason: 'LOCKED' }
  /** Jeton de la connexion expiré : se reconnecter. */
  | { readonly ok: false; readonly reason: 'SESSION_EXPIRED' }
  | { readonly ok: false; readonly reason: 'OFFLINE' }
  | { readonly ok: false; readonly reason: 'UNKNOWN'; readonly status: number };

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** Délai d'une demande : le hachage argon2 du serveur prend moins d'une seconde. */
export const CHANGE_PASSWORD_TIMEOUT_MS = 30_000;
const PROBLEMS: readonly NewPasswordProblem[] = ['TOO_SHORT', 'TOO_LONG', 'UNCHANGED', 'MISMATCH'];

export async function changePassword(input: {
  readonly accessToken: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}): Promise<ChangePasswordResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl('/api/v1/auth/change-password'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({
        current_password: input.currentPassword,
        new_password: input.newPassword,
      }),
      signal: AbortSignal.timeout(CHANGE_PASSWORD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }
  if (GATEWAY_STATUSES.has(response.status)) return { ok: false, reason: 'OFFLINE' };
  if (response.ok) return { ok: true };

  const error = await response
    .json()
    .then((body: { error?: { code?: string; details?: { problem?: string } } }) => body.error ?? {})
    .catch(() => ({}) as { code?: string; details?: { problem?: string } });
  if (response.status === 429) return { ok: false, reason: 'LOCKED' };
  if (response.status === 401) {
    return error.code === 'INVALID_CREDENTIALS'
      ? { ok: false, reason: 'INVALID_CURRENT' }
      : { ok: false, reason: 'SESSION_EXPIRED' };
  }
  if (response.status === 400 && error.code === 'PASSWORD_INVALID') {
    const problem = PROBLEMS.find((candidate) => candidate === error.details?.problem);
    return { ok: false, reason: 'INVALID_NEW', problem: problem ?? 'TOO_SHORT' };
  }
  return { ok: false, reason: 'UNKNOWN', status: response.status };
}

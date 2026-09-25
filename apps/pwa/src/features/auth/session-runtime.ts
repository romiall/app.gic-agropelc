/**
 * État de session en mémoire (jamais persisté tel quel) : jeton d'accès courant, jeton de
 * rafraîchissement, et clé dérivée du PIN nécessaire pour re-chiffrer le jeton de
 * rafraîchissement après rotation (`/auth/refresh` en émet un nouveau à chaque appel,
 * `apps/server/.../session.ts` « rotateSession »). Un module-singleton plutôt qu'un contexte
 * React : le moteur de synchronisation (`sync/`) doit pouvoir y accéder hors du rendu React.
 */
import type { GicDatabase } from '../../storage/db.js';
import { encryptText } from '../../storage/crypto.js';
import { apiUrl } from '../../platform/env.js';

export interface SessionRuntime {
  userId: string;
  deviceId: string;
  deviceStatus: 'PENDING' | 'ACTIVE';
  refreshToken: string;
  /** `undefined` avant le premier rafraîchissement réussi (ex. déverrouillage hors ligne). */
  accessToken: string | undefined;
  accessTokenExpiresAt: number | undefined;
  /** Dérivée du PIN à la connexion ou au déverrouillage ; jamais persistée. */
  pinKey: CryptoKey;
}

let current: SessionRuntime | undefined;

export function getSessionRuntime(): SessionRuntime | undefined {
  return current;
}

export function setSessionRuntime(session: SessionRuntime): void {
  current = session;
}

export function clearSessionRuntime(): void {
  current = undefined;
}

export type AccessTokenResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly reason: 'OFFLINE' | 'SESSION_INVALID' };

/**
 * Jeton d'accès valide, en le rafraîchissant si nécessaire. Hors ligne, échoue proprement
 * (`OFFLINE`) : appelant (push/pull) reporte au prochain cycle, sans vider la session locale
 * (principe O2, le serveur est l'autorité — mais son absence n'est pas un rejet).
 */
export async function ensureAccessToken(db: GicDatabase): Promise<AccessTokenResult> {
  const session = current;
  if (!session) return { ok: false, reason: 'SESSION_INVALID' };

  const now = Date.now();
  const MARGIN_MS = 10_000;
  if (
    session.accessToken &&
    session.accessTokenExpiresAt &&
    session.accessTokenExpiresAt - MARGIN_MS > now
  ) {
    return { ok: true, accessToken: session.accessToken };
  }

  let response: Response;
  try {
    response = await fetch(apiUrl('/api/v1/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }

  if (!response.ok) {
    // Jeton de rafraîchissement invalide, réutilisé, ou session révoquée : la session locale
    // ne peut plus produire de jeton d'accès (BR-ADM-024 : reconnexion en ligne obligatoire).
    clearSessionRuntime();
    return { ok: false, reason: 'SESSION_INVALID' };
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  session.accessToken = body.access_token;
  session.accessTokenExpiresAt = now + body.expires_in * 1000;
  session.refreshToken = body.refresh_token;

  const encrypted = await encryptText(session.pinKey, body.refresh_token);
  await db.session.update('current', {
    encrypted_refresh_token: encrypted.ciphertext,
    iv: encrypted.iv,
  });

  return { ok: true, accessToken: body.access_token };
}

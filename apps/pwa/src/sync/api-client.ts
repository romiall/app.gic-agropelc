/**
 * Appel HTTP authentifié générique pour le moteur de synchronisation (`push.ts`, `pull.ts`) :
 * assure un jeton d'accès valide (`ensureAccessToken`), puis fait l'appel. Distingue
 * « hors ligne / session absente » (pas d'effet, réessai plus tard, principe O2) d'une
 * vraie erreur HTTP (le serveur a répondu).
 */
import type { GicDatabase } from '../storage/db.js';
import { ensureAccessToken } from '../features/auth/session-runtime.js';
import { apiUrl } from '../platform/env.js';

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: 'OFFLINE' | 'SESSION_INVALID' }
  | {
      readonly ok: false;
      readonly reason: 'HTTP_ERROR';
      readonly status: number;
      readonly body: unknown;
    };

export async function authorizedRequest<T>(
  db: GicDatabase,
  path: string,
  init: RequestInit,
): Promise<ApiResult<T>> {
  const token = await ensureAccessToken(db);
  if (!token.ok) return { ok: false, reason: token.reason };

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token.accessToken}`,
      },
    });
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }

  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    return { ok: false, reason: 'HTTP_ERROR', status: response.status, body };
  }
  return { ok: true, data: body as T };
}

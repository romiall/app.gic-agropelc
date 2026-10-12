/**
 * Appel HTTP authentifié générique pour le moteur de synchronisation (`push.ts`, `pull.ts`) :
 * assure un jeton d'accès valide (`ensureAccessToken`), puis fait l'appel. Distingue
 * « hors ligne / session absente » (pas d'effet, réessai plus tard, principe O2) d'une
 * vraie erreur HTTP (le serveur a répondu).
 *
 * Est « hors ligne » (ADR-037) : un échec de connexion, une requête sans réponse dans le délai
 * (`AbortSignal.timeout`), ou une passerelle qui ne joint pas le serveur (502, 503, 504). Toute autre
 * réponse prouve que le serveur est joignable et reste une erreur HTTP.
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

/** Délai par défaut d'une requête ; l'envoi d'un lot de commandes passe un délai plus long. */
export const DEFAULT_TIMEOUT_MS = 30_000;

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export async function authorizedRequest<T>(
  db: GicDatabase,
  path: string,
  init: RequestInit & { readonly timeoutMs?: number },
): Promise<ApiResult<T>> {
  const token = await ensureAccessToken(db);
  if (!token.ok) return { ok: false, reason: token.reason };

  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init;
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...requestInit,
      signal: requestInit.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        ...(requestInit.headers ?? {}),
        authorization: `Bearer ${token.accessToken}`,
      },
    });
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }

  if (GATEWAY_STATUSES.has(response.status)) return { ok: false, reason: 'OFFLINE' };
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    return { ok: false, reason: 'HTTP_ERROR', status: response.status, body };
  }
  return { ok: true, data: body as T };
}

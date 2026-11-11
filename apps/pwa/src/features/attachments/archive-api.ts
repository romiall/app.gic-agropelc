/**
 * Appels de l'archive des photos jointes (AV-539, ADR-070) : `GET` et `POST` de `/api/v1/attachment-archives`, en
 * ligne seulement, hors du journal des commandes. Le résultat distingue la réussite, l'échec du serveur (son code
 * d'erreur et ses détails) et la coupure.
 */
import { ATTACHMENT_ARCHIVES_PATH } from '@gic/contracts';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';

export const ARCHIVES_PATH = ATTACHMENT_ARCHIVES_PATH;

export type ArchiveCall<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** Code d'erreur du serveur, `HTTP_<statut>`, ou `OFFLINE` / `SESSION_INVALID` / `SESSION_CHANGED`. */
      readonly code: string;
      readonly details: Record<string, unknown> | undefined;
    };

/** Une préparation ou un vidage peut durer plusieurs dizaines de secondes (fichiers contrôlés un à un). */
const LONG_TIMEOUT_MS = 120_000;

export async function archiveCall<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: { readonly long?: boolean } = {},
): Promise<ArchiveCall<T>> {
  const result = await authorizedRequest<T>(getDb(), path, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
    ...(options.long ? { timeoutMs: LONG_TIMEOUT_MS } : {}),
  });
  if (result.ok) return { ok: true, data: result.data };
  if (result.reason === 'HTTP_ERROR') {
    const error = (
      result.body as { error?: { code?: string; details?: Record<string, unknown> } } | undefined
    )?.error;
    return { ok: false, code: error?.code ?? `HTTP_${result.status}`, details: error?.details };
  }
  return { ok: false, code: result.reason, details: undefined };
}

/** Clé de libellé du message d'une erreur d'archive (code inconnu : message générique). */
export function archiveErrorKey(code: string): string {
  switch (code) {
    case 'OFFLINE':
      return 'archive.error.OFFLINE';
    case 'SESSION_INVALID':
    case 'SESSION_CHANGED':
      return 'archive.error.SESSION';
    case 'FORBIDDEN':
    case 'HTTP_403':
      return 'archive.error.FORBIDDEN';
    case 'ARCHIVE_NOTHING_TO_ARCHIVE':
    case 'ARCHIVE_PERIOD_IN_PROGRESS':
    case 'ARCHIVE_NOT_DOWNLOADED':
    case 'ARCHIVE_HASH_MISMATCH':
    case 'ARCHIVE_BUSY':
    case 'ARCHIVE_NOT_READY':
    case 'ARCHIVE_VOLUME_RESOLVED':
    case 'ARCHIVE_VOLUME_INCOMPLETE':
      return `archive.error.${code}`;
    default:
      return 'archive.error.GENERIC';
  }
}

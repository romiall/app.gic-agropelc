/**
 * Lecture du contenu d'une pièce jointe reçue par le serveur (MP-10, AV-286) :
 * `GET /api/v1/attachments/{id}/content` avec le jeton de la session — l'écran des validations montre
 * la photo du document décidé. Le serveur contrôle la portée (403 hors périmètre) ; rien n'est gardé
 * sur l'appareil. Un 401 fait renouveler le jeton une fois puis rejouer la lecture (MP-11, AV-282).
 */
import type { GicDatabase } from '../storage/db.js';
import { ensureAccessToken, expireAccessToken } from '../features/auth/session-runtime.js';
import { apiUrl } from '../platform/env.js';

/** Où retrouver une photo vidée du serveur après l'archive (AV-539, ADR-070 §9). */
export interface ArchivedPhoto {
  readonly archivedAt: string;
  readonly reference: string;
  readonly volumeFileName: string;
  readonly entryPath: string;
}

export type AttachmentContentResult =
  | { readonly ok: true; readonly blob: Blob }
  | {
      readonly ok: false;
      /**
       * `FORBIDDEN` : hors périmètre ; `NOT_AVAILABLE` : pas encore reçue ou refusée ; `ARCHIVED` : vidée du serveur
       * (410), archivée par l'entreprise.
       */
      readonly reason:
        'OFFLINE' | 'SESSION_INVALID' | 'FORBIDDEN' | 'NOT_AVAILABLE' | 'ARCHIVED' | 'ERROR';
      /** Pour `ARCHIVED` : date, référence, fichier et chemin dans l'archive, si le serveur les a donnés. */
      readonly archived?: ArchivedPhoto;
    };

/** Détails du `410 ATTACHMENT_ARCHIVED` (absents ou malformés : la raison seule suffit à l'affichage). */
async function archivedDetails(response: Response): Promise<ArchivedPhoto | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { details?: Record<string, unknown> };
    };
    const details = body.error?.details;
    if (
      details &&
      typeof details.archived_at === 'string' &&
      typeof details.reference === 'string' &&
      typeof details.volume_file_name === 'string' &&
      typeof details.entry_path === 'string'
    ) {
      return {
        archivedAt: details.archived_at,
        reference: details.reference,
        volumeFileName: details.volume_file_name,
        entryPath: details.entry_path,
      };
    }
  } catch {
    // Corps absent ou illisible.
  }
  return undefined;
}

const TIMEOUT_MS = 60_000;

export async function fetchAttachmentContent(
  db: GicDatabase,
  attachmentId: string,
): Promise<AttachmentContentResult> {
  let response: Response;
  for (let attempt = 1; ; attempt++) {
    const token = await ensureAccessToken(db);
    if (!token.ok) return { ok: false, reason: token.reason };
    try {
      response = await fetch(
        apiUrl(`/api/v1/attachments/${encodeURIComponent(attachmentId)}/content`),
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token.accessToken}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch {
      return { ok: false, reason: 'OFFLINE' };
    }
    if (response.status !== 401 || attempt > 1) break;
    expireAccessToken(token.accessToken);
  }
  if (response.ok) {
    try {
      return { ok: true, blob: await response.blob() };
    } catch {
      // Coupure ou délai dépassé pendant la lecture du corps.
      return { ok: false, reason: 'OFFLINE' };
    }
  }
  if (response.status === 401) return { ok: false, reason: 'SESSION_INVALID' };
  if (response.status === 403 || response.status === 404) return { ok: false, reason: 'FORBIDDEN' };
  if (response.status === 409) return { ok: false, reason: 'NOT_AVAILABLE' };
  if (response.status === 410) {
    const archived = await archivedDetails(response);
    return archived
      ? { ok: false, reason: 'ARCHIVED', archived }
      : { ok: false, reason: 'ARCHIVED' };
  }
  if (response.status >= 502 && response.status <= 504) return { ok: false, reason: 'OFFLINE' };
  return { ok: false, reason: 'ERROR' };
}

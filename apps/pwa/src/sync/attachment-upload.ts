/**
 * Envoi des octets des pièces jointes (MP-10 ; ADR-012 point 3, ADR-046 ; 02-synchronisation.md §8) :
 * après l'envoi des commandes, une pièce part quand sa commande d'enregistrement est acceptée, par
 * morceaux reprenables (`POST …/upload-session` donne l'offset reçu, `PUT …/content` avec
 * `Content-Range`), les plus petites d'abord, dans un budget d'octets par cycle (le cycle tient le
 * verrou de synchronisation). Seul l'auteur envoie (le serveur refuse les autres) : seules les pièces
 * de l'utilisateur de la session partent.
 *
 * - `AVAILABLE` : octets retirés de l'appareil, la fiche reste (`SENT`) ;
 * - `QUARANTINED` (empreinte ou signature fausse) : terminal, une nouvelle photo est à prendre (AV-290) ;
 * - commande d'enregistrement refusée, ou envoi refusé par un code d'erreur connu du serveur :
 *   `REFUSED` ; une réponse sans code reconnu (passerelle, pare-feu) n'est jamais définitive ;
 * - pièce pas encore connue (404), erreur du serveur ou réseau coupé : nouvel essai avec attente
 *   progressive ; l'envoi des photos s'interrompt alors, le tirage a lieu quand même (revue de MP-10 :
 *   une photo bloquée ne doit pas priver l'appareil de ses données) ; rien n'est perdu, l'offset
 *   est relu au cycle suivant.
 */
import type { Clock } from '@gic/domain';
import type { AttachmentFile, GicDatabase } from '../storage/db.js';
import { authorizedRequest, type ApiResult } from './api-client.js';

/** Morceau envoyé (le serveur en recommande 256 Ko ; plus petit pour un réseau lent, ADR-012). */
export const UPLOAD_CHUNK_BYTES = 128 * 1024;
/** Octets envoyés au plus par cycle (le cycle tient le verrou de synchronisation). */
export const UPLOAD_BUDGET_BYTES = 2 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;

/**
 * `INTERRUPTED` : réseau coupé pendant l'envoi d'une pièce (reportée) ; le cycle de synchronisation
 * poursuit par le tirage, qui juge lui-même de la joignabilité du serveur.
 */
export type UploadCycleOutcome =
  'NOTHING_TO_UPLOAD' | 'UPLOADED' | 'INTERRUPTED' | 'SESSION_INVALID' | 'SESSION_CHANGED';

export interface UploadCycleResult {
  readonly outcome: UploadCycleOutcome;
  /** Pièces reçues et vérifiées par le serveur pendant ce cycle. */
  readonly sent: number;
}

const ACCEPTED_REGISTER: ReadonlySet<string> = new Set(['SYNCED', 'SYNCED_WITH_WARNING']);
const FAILED_REGISTER: ReadonlySet<string> = new Set(['REJECTED', 'CONFLICT']);

interface UploadSessionBody {
  readonly uploaded_bytes: number;
}
interface ChunkBody {
  readonly uploaded_bytes: number;
  readonly upload_status: string;
}
interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: { readonly uploaded_bytes?: number; readonly upload_status?: string };
  };
}

function retryAt(clock: Clock, attempts: number): string {
  const delay = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
  return new Date(clock.now().getTime() + delay).toISOString();
}

/** Pièces de l'utilisateur prêtes à partir : enregistrement accepté, attente écoulée, petites d'abord. */
async function candidates(
  db: GicDatabase,
  clock: Clock,
  userId: string,
): Promise<AttachmentFile[]> {
  const files = await db.attachmentFiles
    .where('author_user_id')
    .equals(userId)
    .filter((file) => file.status === 'QUEUED' || file.status === 'UPLOADING')
    .toArray();
  const now = clock.now().toISOString();
  const ready: AttachmentFile[] = [];
  for (const file of files) {
    const register = await db.outbox.get(file.register_command_id);
    if (register && FAILED_REGISTER.has(register.status)) {
      await db.attachmentFiles.update(file.attachment_id, {
        status: 'REFUSED',
        last_error: register.last_error?.message_fr ?? register.last_error?.code ?? null,
      });
      await db.attachmentBlobs.delete(file.attachment_id);
      continue;
    }
    // Commande d'enregistrement absente (purgée après acceptation) : la pièce est connue du serveur.
    if (register && !ACCEPTED_REGISTER.has(register.status)) continue;
    if (file.next_attempt_at !== null && file.next_attempt_at > now) continue;
    ready.push(file);
  }
  return ready.sort(
    (a, b) => a.size_bytes - b.size_bytes || a.captured_at.localeCompare(b.captured_at),
  );
}

async function settle(
  db: GicDatabase,
  clock: Clock,
  file: AttachmentFile,
  status: 'SENT' | 'QUARANTINED' | 'REFUSED',
  lastError: string | null = null,
): Promise<void> {
  await db.transaction('rw', db.attachmentFiles, db.attachmentBlobs, async () => {
    await db.attachmentFiles.update(file.attachment_id, {
      status,
      last_error: lastError,
      next_attempt_at: null,
      ...(status === 'SENT'
        ? { uploaded_bytes: file.size_bytes, sent_at: clock.now().toISOString() }
        : {}),
    });
    // Reçue ou définitivement perdue : les octets n'ont plus à rester sur l'appareil.
    await db.attachmentBlobs.delete(file.attachment_id);
  });
}

async function postpone(
  db: GicDatabase,
  clock: Clock,
  file: AttachmentFile,
  lastError: string | null,
): Promise<void> {
  const attempts = file.attempts + 1;
  await db.attachmentFiles.update(file.attachment_id, {
    attempts,
    next_attempt_at: retryAt(clock, attempts),
    last_error: lastError,
  });
}

type Failure =
  | { readonly stop: 'OFFLINE' | 'SESSION_INVALID' | 'SESSION_CHANGED' }
  | { readonly stop?: undefined; readonly status: number; readonly body: unknown };

/** Échec d'un appel : arrêt du cycle (réseau, session) ou réponse d'erreur du serveur. */
function failureOf(result: Extract<ApiResult<unknown>, { readonly ok: false }>): Failure {
  return result.reason === 'HTTP_ERROR'
    ? { status: result.status, body: result.body }
    : { stop: result.reason };
}

/** Codes d'erreur du serveur qui rendent l'envoi d'une pièce définitivement impossible. */
const DEFINITIVE_ERRORS: ReadonlySet<string> = new Set([
  'ATTACHMENT_SIZE',
  'VALIDATION_ERROR',
  'FORBIDDEN',
]);

/**
 * Suite d'une réponse d'erreur du serveur pour une pièce : reçue (409 rendant `AVAILABLE`), en
 * quarantaine, refusée sur un code connu, ou à réessayer (tout le reste). Rend `true` si la pièce est
 * reçue.
 */
async function settleFailure(
  db: GicDatabase,
  clock: Clock,
  file: AttachmentFile,
  failure: { readonly status: number; readonly body: unknown },
): Promise<boolean> {
  const error = (failure.body as ErrorBody | undefined)?.error;
  const terminal = error?.details?.upload_status;
  if (failure.status === 409 && error?.code === 'CONFLICT' && terminal === 'AVAILABLE') {
    await settle(db, clock, file, 'SENT');
    return true;
  }
  if (failure.status === 409 && error?.code === 'CONFLICT' && terminal === 'QUARANTINED') {
    await settle(db, clock, file, 'QUARANTINED');
  } else if (
    (failure.status === 409 && error?.code === 'CONFLICT' && terminal !== undefined) ||
    ((failure.status === 400 || failure.status === 403) &&
      error?.code !== undefined &&
      DEFINITIVE_ERRORS.has(error.code))
  ) {
    await settle(db, clock, file, 'REFUSED', error?.code ?? `HTTP_${failure.status}`);
  } else {
    // 404 (enregistrement pas encore appliqué), erreur du serveur, réponse sans code reconnu.
    await postpone(db, clock, file, error?.code ?? `HTTP_${failure.status}`);
  }
  return false;
}

export async function runAttachmentUploadCycle(
  db: GicDatabase,
  deps: { readonly clock: Clock; readonly userId?: string; readonly isStopped?: () => boolean },
): Promise<UploadCycleResult> {
  if (!deps.userId) return { outcome: 'NOTHING_TO_UPLOAD', sent: 0 };
  const userId = deps.userId;
  const files = await candidates(db, deps.clock, userId);
  if (files.length === 0) return { outcome: 'NOTHING_TO_UPLOAD', sent: 0 };
  let budget = UPLOAD_BUDGET_BYTES;
  let sent = 0;
  for (const file of files) {
    if (deps.isStopped?.()) return { outcome: 'SESSION_CHANGED', sent };
    if (budget <= 0) break;
    const blob = await db.attachmentBlobs.get(file.attachment_id);
    if (!blob) {
      // Octets perdus sur l'appareil (stockage effacé) : la pièce ne partira jamais.
      await settle(db, deps.clock, file, 'REFUSED', 'LOCAL_BYTES_MISSING');
      continue;
    }
    const base = `/api/v1/attachments/${encodeURIComponent(file.attachment_id)}`;
    const session = await authorizedRequest<UploadSessionBody>(db, `${base}/upload-session`, {
      method: 'POST',
      expectedUserId: userId,
    });
    if (!session.ok) {
      const failure = failureOf(session);
      if (failure.stop === 'OFFLINE') {
        await postpone(db, deps.clock, file, 'OFFLINE');
        return { outcome: 'INTERRUPTED', sent };
      }
      if (failure.stop) return { outcome: failure.stop, sent };
      if (await settleFailure(db, deps.clock, file, failure)) sent++;
      continue;
    }
    let offset = session.data.uploaded_bytes;
    const total = blob.bytes.byteLength;
    let finished = false;
    while (!finished && budget > 0) {
      if (deps.isStopped?.()) return { outcome: 'SESSION_CHANGED', sent };
      if (offset >= total) {
        // Tout est reçu mais la fin n'a pas été constatée (coupure au dernier morceau) : renvoyer le
        // dernier octet rejouerait un décalage ; on relit l'état au cycle suivant.
        await postpone(db, deps.clock, file, null);
        break;
      }
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total) - 1;
      const chunk = blob.bytes.slice(offset, end + 1);
      await db.attachmentFiles.update(file.attachment_id, {
        status: 'UPLOADING',
        uploaded_bytes: offset,
      });
      const put = await authorizedRequest<ChunkBody>(db, `${base}/content`, {
        method: 'PUT',
        body: chunk,
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${offset}-${end}/${total}`,
        },
        timeoutMs: UPLOAD_TIMEOUT_MS,
        expectedUserId: userId,
      });
      if (!put.ok) {
        const failure = failureOf(put);
        if (failure.stop === 'OFFLINE') {
          await postpone(db, deps.clock, file, 'OFFLINE');
          return { outcome: 'INTERRUPTED', sent };
        }
        if (failure.stop) return { outcome: failure.stop, sent };
        const error = (failure.body as ErrorBody | undefined)?.error;
        const serverOffset = error?.details?.uploaded_bytes;
        if (
          failure.status === 409 &&
          error?.code === 'UPLOAD_OFFSET_MISMATCH' &&
          typeof serverOffset === 'number' &&
          serverOffset !== offset
        ) {
          // Le serveur a reçu davantage (ou moins) : reprendre à son offset.
          offset = serverOffset;
          continue;
        }
        if (await settleFailure(db, deps.clock, file, failure)) sent++;
        finished = true;
        continue;
      }
      budget -= chunk.byteLength;
      offset = put.data.uploaded_bytes;
      if (put.data.upload_status === 'AVAILABLE') {
        await settle(db, deps.clock, file, 'SENT');
        sent++;
        finished = true;
      } else if (put.data.upload_status === 'QUARANTINED') {
        await settle(db, deps.clock, file, 'QUARANTINED');
        finished = true;
      } else {
        await db.attachmentFiles.update(file.attachment_id, { uploaded_bytes: offset });
      }
    }
  }
  return { outcome: 'UPLOADED', sent };
}

/** Pièces de l'utilisateur encore à envoyer et leur poids (écran de synchronisation, budget local). */
export async function pendingAttachments(
  db: GicDatabase,
  userId?: string,
): Promise<{ readonly count: number; readonly bytes: number }> {
  const files = await db.attachmentFiles
    .where('status')
    .anyOf(['QUEUED', 'UPLOADING'])
    .filter((file) => userId === undefined || file.author_user_id === userId)
    .toArray();
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.size_bytes - file.uploaded_bytes, 0),
  };
}

/**
 * Photos jointes dans la PWA (MP-10, ADR-046) : pièce préparée → pièce de la file (`NewAttachment`),
 * photo jointe après coup à un document déjà enregistré, état d'envoi des photos d'un document (fiche
 * locale d'abord, état servi par le serveur ensuite), budget des photos en attente (NFR-06, AV-291).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { clock, idGenerator } from '../../platform/composition.js';
import { isEffectivelyOnline } from '../../platform/connectivity.js';
import { getDb } from '../../storage/db.js';
import { enqueueAttachment, type NewAttachment } from '../../sync/outbox.js';
import { pendingAttachments } from '../../sync/attachment-upload.js';
import { getSyncEngine } from '../sync/sync-engine-instance.js';
import type { PreparedPhoto } from './photo.js';

/** Pièces en attente d'envoi sur l'appareil, au plus (NFR-06 : 50 Mo). */
export const PHOTO_PENDING_BUDGET_BYTES = 50 * 1024 * 1024;

export interface PhotoTarget {
  /** `DELIVERY_NOTE` (bon de livraison d'une réception), `PHOTO` (perte, mortalité). */
  readonly kind: 'DELIVERY_NOTE' | 'PHOTO';
  readonly ownerType: 'GOODS_RECEIPT' | 'STOCK_LOSS';
  /** Citée par l'opération (réception) ou rattachée par son propriétaire (perte, mortalité). */
  readonly cited: boolean;
  /** Document propriétaire ; par défaut l'agrégat de l'opération enregistrée avec la photo. */
  readonly ownerId?: string;
}

export function photoAttachment(photo: PreparedPhoto, target: PhotoTarget): NewAttachment {
  return {
    kind: target.kind,
    ownerType: target.ownerType,
    cited: target.cited,
    ...(target.ownerId !== undefined ? { ownerId: target.ownerId } : {}),
    mimeType: photo.mimeType,
    bytes: photo.bytes,
    sha256: photo.sha256,
    capturedAt: photo.capturedAt,
  };
}

/** La photo tient-elle encore dans le budget des pièces en attente de l'appareil ? */
export async function fitsPendingBudget(sizeBytes: number): Promise<boolean> {
  const pending = await pendingAttachments(getDb());
  return pending.bytes + sizeBytes <= PHOTO_PENDING_BUDGET_BYTES;
}

/**
 * Joint une photo à un document déjà enregistré (photo manquante d'une réception, mortalité en
 * attente) : seule la commande d'enregistrement de la pièce part, puis ses octets.
 */
export async function submitAttachment(input: {
  readonly authorUserId: string;
  readonly photo: PreparedPhoto;
  readonly target: PhotoTarget & { readonly ownerId: string };
}): Promise<string> {
  const attachmentId = await enqueueAttachment(
    getDb(),
    { clock, idGenerator },
    {
      authorUserId: input.authorUserId,
      capturedOffline: !isEffectivelyOnline(),
      attachment: { ...photoAttachment(input.photo, input.target), ownerId: input.target.ownerId },
    },
  );
  void getSyncEngine()?.trigger();
  return attachmentId;
}

/**
 * État d'une photo d'un document, vu de l'appareil ; `OTHER_AUTHOR` : photo d'un autre utilisateur de
 * la tablette, qu'il enverra à sa prochaine connexion (seul l'auteur envoie, ADR-046 §7).
 */
export type PhotoState = 'LOCAL' | 'UPLOADING' | 'RECEIVED' | 'REFUSED' | 'OTHER_AUTHOR';

export interface PhotoView {
  readonly id: string;
  readonly state: PhotoState;
  /** Part déjà envoyée (0 à 100), pour une photo en cours d'envoi. */
  readonly percent: number;
}

/**
 * Photos d'un document : celles de l'appareil (fiche locale), puis celles que le serveur connaît
 * (jeu `attachment` ; photo prise sur un autre appareil, ou fiche locale déjà retirée).
 */
export function useOwnerPhotos(
  ownerId: string | undefined,
  userId?: string,
): readonly PhotoView[] | undefined {
  return useLiveQuery(async () => {
    if (!ownerId) return [];
    const db = getDb();
    const views = new Map<string, PhotoView>();
    const projected = await db.projections
      .where('[dataset+entity_type]')
      .equals(['attachment', 'ATTACHMENT'])
      .filter((row) => (row.data as { owner_id?: string }).owner_id === ownerId)
      .toArray();
    for (const row of projected) {
      const status = (row.data as { upload_status?: string }).upload_status;
      if (status === 'SUPERSEDED') continue;
      views.set(row.entity_id, {
        id: row.entity_id,
        state:
          status === 'AVAILABLE' ? 'RECEIVED' : status === 'QUARANTINED' ? 'REFUSED' : 'UPLOADING',
        percent: status === 'AVAILABLE' ? 100 : 0,
      });
    }
    const local = await db.attachmentFiles.where('owner_id').equals(ownerId).toArray();
    for (const file of local) {
      const server = views.get(file.attachment_id);
      // Le serveur a le dernier mot une fois la pièce reçue ou refusée.
      if (server && server.state !== 'UPLOADING') continue;
      const foreign = userId !== undefined && file.author_user_id !== userId;
      views.set(file.attachment_id, {
        id: file.attachment_id,
        state:
          file.status === 'SENT'
            ? 'RECEIVED'
            : file.status === 'QUARANTINED' || file.status === 'REFUSED'
              ? 'REFUSED'
              : foreign
                ? 'OTHER_AUTHOR'
                : file.status === 'UPLOADING'
                  ? 'UPLOADING'
                  : 'LOCAL',
        percent:
          file.size_bytes > 0 ? Math.floor((file.uploaded_bytes / file.size_bytes) * 100) : 0,
      });
    }
    const all = [...views.values()];
    // Une photo refusée, remplacée par une autre reçue ou en route, n'est plus montrée.
    return all.some((view) => view.state !== 'REFUSED')
      ? all.filter((view) => view.state !== 'REFUSED')
      : all;
  }, [ownerId, userId]);
}

/** Photos refusées de l'utilisateur (écran de synchronisation : à reprendre depuis leur document). */
export async function refusedPhotosCount(userId: string | undefined): Promise<number> {
  if (!userId) return 0;
  return getDb()
    .attachmentFiles.where('author_user_id')
    .equals(userId)
    .filter((file) => file.status === 'REFUSED' || file.status === 'QUARANTINED')
    .count();
}

/** Une photo du document est-elle reçue, ou en route (pas refusée) ? */
export function hasUsablePhoto(photos: readonly PhotoView[] | undefined): boolean {
  return (photos ?? []).some((photo) => photo.state !== 'REFUSED');
}

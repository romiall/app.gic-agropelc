/**
 * API publique du module `attachments` (01-architecture-logicielle.md §3, règle 1). P0-13 :
 * un seul besoin côté consommateur (`approvals`, graphe autorisé) — savoir si les pièces
 * attendues par une demande de validation sont reçues (BR-ADM-020, `ATTACHMENT_MISSING`).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Vrai si `attachmentIds` est vide, ou si chacune est `AVAILABLE` (BR-ADM-020). */
export async function areAttachmentsAvailable(
  executor: Kysely<DB> | Transaction<DB>,
  attachmentIds: readonly string[],
): Promise<boolean> {
  if (attachmentIds.length === 0) return true;
  const rows = await executor
    .selectFrom('attachments_attachments')
    .select(['id', 'upload_status'])
    .where(
      'id',
      'in',
      attachmentIds.map((id) => toBin(id)),
    )
    .execute();
  if (rows.length !== attachmentIds.length) return false; // une pièce référencée est introuvable
  return rows.every((row) => row.upload_status === 'AVAILABLE');
}

/**
 * Vrai si le document (`ownerType`, `ownerId`) possède au moins une pièce `AVAILABLE` (de la
 * nature `kind` si elle est précisée). P7-02 (AV-107) : une mortalité enregistrée sans photo
 * attend qu'une photo lui soit jointe après coup — la liste `required_attachment_ids` d'une
 * demande de validation étant figée à sa création, l'approbation vérifie ici les pièces du
 * document lui-même.
 */
export async function hasAvailableAttachment(
  executor: Kysely<DB> | Transaction<DB>,
  owner: { readonly ownerType: string; readonly ownerId: string; readonly kind?: string },
): Promise<boolean> {
  const row = await executor
    .selectFrom('attachments_attachments')
    .select('id')
    .where('owner_type', '=', owner.ownerType)
    .where('owner_id', '=', toBin(owner.ownerId))
    .where('upload_status', '=', 'AVAILABLE')
    .$if(owner.kind !== undefined, (qb) => qb.where('kind', '=', owner.kind!))
    .executeTakeFirst();
  return row !== undefined;
}

export interface OwnedAttachment {
  readonly id: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly uploadStatus: string;
}

/**
 * Pièces des documents, par `${ownerType}:${ownerId}`, les plus anciennes d'abord, hors pièces
 * remplacées (MP-10 : photos montrées au valideur, AV-296).
 */
export async function attachmentsOfOwners(
  executor: Kysely<DB> | Transaction<DB>,
  owners: readonly { readonly ownerType: string; readonly ownerId: string }[],
): Promise<ReadonlyMap<string, readonly OwnedAttachment[]>> {
  const result = new Map<string, OwnedAttachment[]>();
  if (owners.length === 0) return result;
  const rows = await executor
    .selectFrom('attachments_attachments')
    .select(['id', 'owner_type', 'owner_id', 'kind', 'mime_type', 'upload_status', 'created_at'])
    .where(
      'owner_id',
      'in',
      [...new Set(owners.map((owner) => owner.ownerId))].map((id) => toBin(id)),
    )
    .where('upload_status', '<>', 'SUPERSEDED')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const wanted = new Set(owners.map((owner) => `${owner.ownerType}:${owner.ownerId}`));
  for (const row of rows) {
    const key = `${row.owner_type}:${fromBin(row.owner_id)}`;
    if (!wanted.has(key)) continue;
    const list = result.get(key) ?? [];
    list.push({
      id: fromBin(row.id),
      kind: row.kind,
      mimeType: row.mime_type,
      uploadStatus: row.upload_status,
    });
    result.set(key, list);
  }
  return result;
}

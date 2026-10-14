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
 * remplacées (MP-10 : photos montrées au valideur, AV-286).
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

/**
 * Les pièces exigées par une demande de validation sont-elles reçues (BR-ADM-020) ? La liste d'une
 * demande est figée à sa création ; une pièce exigée refusée, en quarantaine ou jamais enregistrée
 * est **remplacée** par une autre pièce reçue du même document — de même nature si la pièce exigée
 * est connue —, chacune ne remplaçant qu'une pièce (AV-290 : « nouvelle photo, même document » ;
 * revue de MP-10 : sans cela, la validation restait bloquée à vie).
 */
export async function requiredAttachmentsSatisfied(
  executor: Kysely<DB> | Transaction<DB>,
  input: {
    readonly requiredIds: readonly string[];
    readonly ownerType: string;
    readonly ownerId: string;
  },
): Promise<boolean> {
  if (input.requiredIds.length === 0) return true;
  const required = await executor
    .selectFrom('attachments_attachments')
    .select(['id', 'kind', 'upload_status'])
    .where(
      'id',
      'in',
      input.requiredIds.map((id) => toBin(id)),
    )
    .execute();
  const byId = new Map(required.map((row) => [fromBin(row.id), row]));
  const missing = input.requiredIds.filter((id) => byId.get(id)?.upload_status !== 'AVAILABLE');
  if (missing.length === 0) return true;
  const replacements = (
    await executor
      .selectFrom('attachments_attachments')
      .select(['id', 'kind'])
      .where('owner_type', '=', input.ownerType)
      .where('owner_id', '=', toBin(input.ownerId))
      .where('upload_status', '=', 'AVAILABLE')
      .execute()
  ).filter((row) => !input.requiredIds.includes(fromBin(row.id)));
  // Les pièces exigées connues d'abord : leur remplaçante doit avoir la même nature.
  const ordered = [...missing].sort((a, b) => Number(byId.has(b)) - Number(byId.has(a)));
  for (const id of ordered) {
    const kind = byId.get(id)?.kind;
    const index = replacements.findIndex((row) => kind === undefined || row.kind === kind);
    if (index < 0) return false;
    replacements.splice(index, 1);
  }
  return true;
}

/**
 * API publique du module `attachments` (01-architecture-logicielle.md §3, règle 1). P0-13 :
 * un seul besoin côté consommateur (`approvals`, graphe autorisé) — savoir si les pièces
 * attendues par une demande de validation sont reçues (BR-ADM-020, `ATTACHMENT_MISSING`).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

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

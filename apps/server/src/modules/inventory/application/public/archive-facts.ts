/**
 * Ce que l'archive des photos jointes a besoin de savoir d'une déclaration de perte ou de mortalité (AV-539,
 * ADR-070 §2) : son numéro, sa pièce papier, sa catégorie de dossier (`MORTALITE` ou `PERTE`) et si l'opération est
 * fermée.
 *
 * Fermée : enregistrée sans validation (`RECORDED`), approuvée (`APPROVED`), rejetée comme injustifiée
 * (`REJECTED_UNJUSTIFIED`) ou annulée (`CANCELLED`). Ouvertes : en attente de validation (`PENDING_APPROVAL`),
 * rejetée à compléter (`REJECTED_RETURNED`) et annulation en attente (`CANCELLATION_PENDING`) — la photo est la
 * preuve que le valideur attend (AV-107, AV-546).
 */
import type { Kysely, Transaction } from 'kysely';
import type { ArchiveOwnerFacts } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export const LOSS_ARCHIVE_CLOSED_STATUSES: readonly string[] = [
  'RECORDED',
  'APPROVED',
  'REJECTED_UNJUSTIFIED',
  'CANCELLED',
];

export async function lossArchiveFacts(
  executor: Kysely<DB> | Transaction<DB>,
  lossIds: readonly string[],
): Promise<ReadonlyMap<string, ArchiveOwnerFacts>> {
  const facts = new Map<string, ArchiveOwnerFacts>();
  if (lossIds.length === 0) return facts;
  const rows = await executor
    .selectFrom('inventory_loss_declarations')
    .select(['id', 'doc_number', 'local_ref', 'category', 'status'])
    .where('id', 'in', lossIds.map(toBin))
    .execute();
  for (const row of rows) {
    facts.set(fromBin(row.id), {
      reference: row.doc_number,
      secondaryReferences: [row.local_ref],
      category: row.category === 'MORTALITE' ? 'MORTALITE' : 'PERTE',
      closed: LOSS_ARCHIVE_CLOSED_STATUSES.includes(row.status),
    });
  }
  return facts;
}

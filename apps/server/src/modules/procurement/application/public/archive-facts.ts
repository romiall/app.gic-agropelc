/**
 * Ce que l'archive des photos jointes a besoin de savoir d'une réception d'achat (AV-539, ADR-070 §2) : son numéro,
 * ses références secondaires (bon de livraison du fournisseur, pièce papier) et si l'opération est fermée.
 *
 * Fermée : réception comptabilisée (`POSTED`), refusée (`REJECTED`) ou annulée (`CANCELLED`). Ouvertes : en revue
 * (`POSTED_PENDING_REVIEW`), revue refusée (`REVIEW_REJECTED`), en quarantaine (`QUARANTINED`) et annulation en
 * attente (`CANCELLATION_PENDING`) — la photo du bon est alors la preuve que le valideur attend (AV-546).
 */
import type { Kysely, Transaction } from 'kysely';
import type { ArchiveOwnerFacts } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export const RECEIPT_ARCHIVE_CLOSED_STATUSES: readonly string[] = [
  'POSTED',
  'REJECTED',
  'CANCELLED',
];

export async function receiptArchiveFacts(
  executor: Kysely<DB> | Transaction<DB>,
  receiptIds: readonly string[],
): Promise<ReadonlyMap<string, ArchiveOwnerFacts>> {
  const facts = new Map<string, ArchiveOwnerFacts>();
  if (receiptIds.length === 0) return facts;
  const rows = await executor
    .selectFrom('procurement_goods_receipts')
    .select(['id', 'doc_number', 'local_ref', 'supplier_delivery_note_ref', 'status'])
    .where('id', 'in', receiptIds.map(toBin))
    .execute();
  for (const row of rows) {
    facts.set(fromBin(row.id), {
      reference: row.doc_number,
      secondaryReferences: [row.supplier_delivery_note_ref, row.local_ref],
      category: 'RECEPTION',
      closed: RECEIPT_ARCHIVE_CLOSED_STATUSES.includes(row.status),
    });
  }
  return facts;
}

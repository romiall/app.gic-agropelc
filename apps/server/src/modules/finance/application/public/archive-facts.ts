/**
 * Ce que l'archive des photos jointes a besoin de savoir d'une dépense ou d'une facture fournisseur (AV-539,
 * ADR-070 §2) : le numéro du document, ses références secondaires (pièce papier, numéro de facture du fournisseur)
 * et si l'opération est fermée.
 *
 * Dépense fermée : payée (`PAID`), rejetée (`REJECTED`, `PAID_REJECTED`) ou annulée (`CANCELLED`) ; ouvertes :
 * enregistrée (`RECORDED`), en attente de validation (`PENDING_APPROVAL`), approuvée non payée (`APPROVED`) et payée
 * en attente de validation (`PAID_PENDING_APPROVAL`). Facture fermée : payée (`PAID`) ou annulée (`CANCELLED`) ;
 * ouvertes : écart (`MISMATCH`), contestée (`DISPUTED`), approuvée (`APPROVED`) et partiellement payée
 * (`PARTIALLY_PAID`). Une dépense jamais payée ou une facture jamais soldée garde donc sa photo sur le serveur
 * (AV-546).
 */
import type { Kysely, Transaction } from 'kysely';
import type { ArchiveOwnerFacts } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export const EXPENSE_ARCHIVE_CLOSED_STATUSES: readonly string[] = [
  'PAID',
  'REJECTED',
  'PAID_REJECTED',
  'CANCELLED',
];
export const SUPPLIER_INVOICE_ARCHIVE_CLOSED_STATUSES: readonly string[] = ['PAID', 'CANCELLED'];

export async function expenseArchiveFacts(
  executor: Kysely<DB> | Transaction<DB>,
  expenseIds: readonly string[],
): Promise<ReadonlyMap<string, ArchiveOwnerFacts>> {
  const facts = new Map<string, ArchiveOwnerFacts>();
  if (expenseIds.length === 0) return facts;
  const rows = await executor
    .selectFrom('finance_expenses')
    .select(['id', 'doc_number', 'local_ref', 'status'])
    .where('id', 'in', expenseIds.map(toBin))
    .execute();
  for (const row of rows) {
    facts.set(fromBin(row.id), {
      reference: row.doc_number,
      secondaryReferences: [row.local_ref],
      category: 'DEPENSE',
      closed: EXPENSE_ARCHIVE_CLOSED_STATUSES.includes(row.status),
    });
  }
  return facts;
}

export async function supplierInvoiceArchiveFacts(
  executor: Kysely<DB> | Transaction<DB>,
  invoiceIds: readonly string[],
): Promise<ReadonlyMap<string, ArchiveOwnerFacts>> {
  const facts = new Map<string, ArchiveOwnerFacts>();
  if (invoiceIds.length === 0) return facts;
  const rows = await executor
    .selectFrom('finance_supplier_invoices')
    .select(['id', 'doc_number', 'supplier_invoice_ref', 'status'])
    .where('id', 'in', invoiceIds.map(toBin))
    .execute();
  for (const row of rows) {
    facts.set(fromBin(row.id), {
      reference: row.doc_number,
      secondaryReferences: [row.supplier_invoice_ref],
      category: 'FACTURE_FOURNISSEUR',
      closed: SUPPLIER_INVOICE_ARCHIVE_CLOSED_STATUSES.includes(row.status),
    });
  }
  return facts;
}

/** Lecture des fournisseurs (phase P1 : `GET /suppliers`, fiche seule). */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export interface SupplierSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly suppliedCategories: readonly string[];
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  /** Servis depuis P5-23 (S-30) : la modification les relit. */
  readonly address: string | null;
  readonly taxId: string | null;
  readonly paymentTermsDays: number | null;
  readonly notes: string | null;
  readonly status: string;
}

function summaryOf(row: {
  id: Buffer;
  code: string;
  name: string;
  supplied_categories: unknown;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tax_id: string | null;
  payment_terms_days: number | null;
  notes: string | null;
  status: string;
}): SupplierSummary {
  return {
    id: fromBin(row.id),
    code: row.code,
    name: row.name,
    suppliedCategories: row.supplied_categories as readonly string[],
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    taxId: row.tax_id,
    paymentTermsDays: row.payment_terms_days,
    notes: row.notes,
    status: row.status,
  };
}

/**
 * Fiche d'un fournisseur (P8-05 ; annoncée `procurement.supplier(id)` par 02-modules.md §6) : lue par
 * `finance` (dépense, facture, paiement fournisseur), qui n'écrit jamais cette table.
 */
export async function findSupplier(
  executor: Kysely<DB> | Transaction<DB>,
  supplierId: string,
): Promise<SupplierSummary | undefined> {
  const row = await executor
    .selectFrom('procurement_suppliers')
    .selectAll()
    .where('id', '=', toBin(supplierId))
    .executeTakeFirst();
  return row ? summaryOf(row) : undefined;
}

export async function listSuppliers(
  executor: Kysely<DB> | Transaction<DB>,
  filter: { readonly status?: 'ACTIVE' | 'INACTIVE' } = {},
): Promise<readonly SupplierSummary[]> {
  const rows = await executor
    .selectFrom('procurement_suppliers')
    .selectAll()
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => summaryOf(row));
}

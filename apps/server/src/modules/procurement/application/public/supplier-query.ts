/** Lecture des fournisseurs (phase P1 : `GET /suppliers`, fiche seule). */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';

export interface SupplierSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly suppliedCategories: readonly string[];
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly taxId: string | null;
  readonly paymentTermsDays: number | null;
  readonly status: string;
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
  return rows.map((row) => ({
    id: fromBin(row.id),
    code: row.code,
    name: row.name,
    suppliedCategories: row.supplied_categories as unknown as readonly string[],
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    taxId: row.tax_id,
    paymentTermsDays: row.payment_terms_days,
    status: row.status,
  }));
}

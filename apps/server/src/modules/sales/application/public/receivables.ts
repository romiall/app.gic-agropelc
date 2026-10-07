/**
 * Encours d'un client (BR-VEN-025, D09 §7.1) : somme des soldes dus de ses ventes non annulées. Les
 * créances et l'encours ne sont jamais stockés (ADR-010) : ils se calculent sur `balance_due_xaf`
 * (colonne générée, index `(customer_id, occurred_at)`). Un compte fusionné s'ajoute à celui qui
 * l'a absorbé (BR-CRM-007) : l'appelant passe le compte conservé.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { absorbedCustomerIds } from '../../../crm/application/public/index.js';

export async function customerOutstandingXaf(
  executor: Kysely<DB> | Transaction<DB>,
  keptCustomerId: string,
): Promise<number> {
  const accounts = [keptCustomerId, ...(await absorbedCustomerIds(executor, keptCustomerId))];
  const row = await executor
    .selectFrom('sales_sales')
    .select(sql<string>`COALESCE(SUM(balance_due_xaf), 0)`.as('outstanding'))
    .where(
      'customer_id',
      'in',
      accounts.map((id) => toBin(id)),
    )
    .where('status', '<>', 'CANCELLED')
    // Lecture verrouillante : le compte est verrouillé par l'appelant, mais en isolation répétable
    // une lecture simple ne verrait pas la vente à crédit d'une transaction concurrente déjà validée
    // (plafond dépassé sans être détecté, BR-VEN-025).
    .forShare()
    .executeTakeFirst();
  return Number(row?.outstanding ?? 0);
}

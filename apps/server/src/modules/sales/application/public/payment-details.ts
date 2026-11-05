/**
 * Détail d'identification de chaque encaissement client (lot Finance du 05/11/2026, AV-518 ; ECR-FIN-05) :
 * numéro de pièce, mode de paiement et référence externe, propriété de `sales`. Sert à la couche de transport
 * pour composer le détail des mouvements de trésorerie (`finance` n'importe pas `sales`). Lecture sans
 * décision d'autorisation (l'appelant s'en charge).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

const CHUNK = 500;

export interface CustomerPaymentDetail {
  readonly docNumber: string;
  readonly paymentMethodCode: string;
  readonly externalReference: string | null;
}

export async function customerPaymentDetails(
  executor: Executor,
  paymentIds: readonly string[],
): Promise<ReadonlyMap<string, CustomerPaymentDetail>> {
  const details = new Map<string, CustomerPaymentDetail>();
  for (let start = 0; start < paymentIds.length; start += CHUNK) {
    const chunk = paymentIds.slice(start, start + CHUNK);
    const rows = await executor
      .selectFrom('sales_customer_payments')
      .select(['id', 'doc_number', 'payment_method_code', 'external_reference'])
      .where(
        'id',
        'in',
        chunk.map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) {
      details.set(fromBin(row.id), {
        docNumber: row.doc_number,
        paymentMethodCode: row.payment_method_code,
        externalReference: row.external_reference,
      });
    }
  }
  return details;
}

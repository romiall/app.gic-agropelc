/**
 * Vendeur ayant reçu chaque encaissement (P5-14 ; AV-155, AV-187) : `received_by_user_id`, propriété de
 * `sales`. Sert à la couche de transport pour composer les sous-totaux par vendeur d'une session de
 * caisse (`finance` n'importe pas `sales`). Lecture sans décision d'autorisation (l'appelant s'en charge).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

const CHUNK = 500;

export async function paymentReceivers(
  executor: Executor,
  paymentIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const receivers = new Map<string, string>();
  for (let start = 0; start < paymentIds.length; start += CHUNK) {
    const chunk = paymentIds.slice(start, start + CHUNK);
    const rows = await executor
      .selectFrom('sales_customer_payments')
      .select(['id', 'received_by_user_id'])
      .where(
        'id',
        'in',
        chunk.map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) receivers.set(fromBin(row.id), fromBin(row.received_by_user_id));
  }
  return receivers;
}

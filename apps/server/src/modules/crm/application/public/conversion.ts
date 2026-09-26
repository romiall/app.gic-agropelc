/**
 * Conversion prospect → client (UC-CRM-07 ; BR-CRM-010, SM-CUSTOMER) : API interne appelée par
 * `sales` (P4) à la confirmation d'une vente, dans sa transaction — la conversion est
 * exclusivement serveur. `converted_at` = `occurred_at` de la **première** vente confirmée : une
 * vente antérieure synchronisée plus tard devient la première vente. Un compte fusionné est
 * converti via son compte conservé (lectures agrégées par la chaîne de fusion, BR-CRM-007).
 * `markConversionReverted` : D02 §11, la vente de conversion annulée sans autre vente confirmée
 * laisse le compte `CUSTOMER`, avec l'indicateur `conversion_reverted` (pas de retour silencieux).
 */
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { emitCustomerChange } from '../sync-changes.js';

export type ConversionOutcome = 'CONVERTED' | 'FIRST_SALE_UPDATED' | 'UNCHANGED' | 'NOT_FOUND';

export async function convertOnConfirmedSale(
  uow: Transaction<DB>,
  input: {
    readonly customerId: string;
    readonly saleId: string;
    readonly saleOccurredAt: Date;
    readonly actorUserId: string;
    /** Identifiant de la ligne d'historique de stade éventuelle (fourni par l'appelant). */
    readonly historyId: string;
  },
): Promise<ConversionOutcome> {
  let customer = await lock(uow, input.customerId);
  if (customer?.stage === 'MERGED' && customer.merged_into_id !== null) {
    customer = await lock(uow, fromBin(customer.merged_into_id));
  }
  if (!customer || customer.stage === 'MERGED') return 'NOT_FOUND';

  const at = input.saleOccurredAt;
  const lastSaleAt =
    customer.last_sale_at === null || at.getTime() > customer.last_sale_at.getTime()
      ? at
      : customer.last_sale_at;
  if (customer.stage === 'CUSTOMER') {
    const earlier =
      customer.converted_at === null || at.getTime() < customer.converted_at.getTime();
    await uow
      .updateTable('crm_customers')
      .set({
        ...(earlier ? { converted_at: at, first_sale_id: toBin(input.saleId) } : {}),
        last_sale_at: lastSaleAt,
        version: sql`version + 1`,
      })
      .where('id', '=', customer.id)
      .execute();
    await emitCustomerChange(uow, fromBin(customer.id), at);
    return earlier ? 'FIRST_SALE_UPDATED' : 'UNCHANGED';
  }

  // PROSPECT ou LOST → CUSTOMER (SM-CUSTOMER : « l'historique garde le passage par LOST »).
  await uow
    .updateTable('crm_customers')
    .set({
      stage: 'CUSTOMER',
      converted_at: at,
      first_sale_id: toBin(input.saleId),
      last_sale_at: lastSaleAt,
      version: sql`version + 1`,
    })
    .where('id', '=', customer.id)
    .execute();
  await uow
    .insertInto('crm_customer_stage_history')
    .values({
      id: toBin(input.historyId),
      customer_id: customer.id,
      from_stage: customer.stage,
      to_stage: 'CUSTOMER',
      from_step_id: customer.pipeline_step_id,
      to_step_id: null,
      occurred_at: at,
      actor_user_id: toBin(input.actorUserId),
      cause_ref: toBin(input.saleId),
    })
    .execute();
  await emitCustomerChange(uow, fromBin(customer.id), at);
  return 'CONVERTED';
}

export async function markConversionReverted(
  uow: Transaction<DB>,
  customerId: string,
  at: Date,
): Promise<void> {
  await uow
    .updateTable('crm_customers')
    .set({ conversion_reverted: 1, version: sql`version + 1` })
    .where('id', '=', toBin(customerId))
    .where('stage', '=', 'CUSTOMER')
    .execute();
  await emitCustomerChange(uow, customerId, at);
}

async function lock(uow: Transaction<DB>, customerId: string) {
  return uow
    .selectFrom('crm_customers')
    .select(['id', 'stage', 'merged_into_id', 'pipeline_step_id', 'converted_at', 'last_sale_at'])
    .where('id', '=', toBin(customerId))
    .forUpdate()
    .executeTakeFirst();
}

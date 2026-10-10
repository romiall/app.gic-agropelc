/**
 * Événements explicites des sessions de caisse (P5-12 ; D05 §10 ; catalogue d'événements §2.8 ; D13) :
 * `CashSessionOpened`, `CashSessionClosed`, `CashVarianceDetected` et `CashSessionOpenLongDetected`,
 * écrits dans `platform_domain_events` dans la transaction de la commande (ou de la tâche).
 *
 * Le pipeline écrit en plus sa ligne générique (`event_type` = type de commande) ; les consommateurs
 * (alertes de P9) filtrent sur ces noms explicites : une ouverture fusionnée ne crée pas de session et
 * les montants calculés par le serveur ne sont pas dans la charge utile de la commande.
 */
import type { IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { jsonValue } from '../../../platform/kysely/json-value.js';
import { toBin, toBinOrNull } from '../../../platform/kysely/uuid-columns.js';

export type CashSessionEventType =
  | 'CashSessionOpened'
  | 'CashSessionClosed'
  | 'CashVarianceDetected'
  | 'CashSessionOpenLongDetected';

export async function publishCashSessionEvent(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly eventType: CashSessionEventType;
    readonly sessionId: string;
    readonly occurredAt: Date;
    readonly commandId: string | null;
    readonly payload: Record<string, unknown>;
  },
): Promise<void> {
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(deps.idGenerator.newId()),
      event_type: input.eventType,
      producer_module: 'finance',
      aggregate_type: 'CASH_SESSION',
      aggregate_id: toBin(input.sessionId),
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
      command_id: toBinOrNull(input.commandId),
    })
    .execute();
}

/**
 * Événements des exports (P9-20 ; ADR-067 §7, catalogue d'événements) : `AnalyticsExportRequested` (la demande) et
 * `AnalyticsExportCompleted` (la fin : `DONE` ou `FAILED`), écrits dans `platform_domain_events` dans la transaction
 * qui les produit. Le consommateur `communication.direct` prévient le demandeur à la fin (`AnalyticsExportCompleted`) ;
 * `analytics` n'importe pas `communication` (ADR-060). Aucune donnée de l'export n'est dans l'événement.
 */
import type { IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

export type ExportEventType = 'AnalyticsExportRequested' | 'AnalyticsExportCompleted';

export async function publishExportEvent(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly eventType: ExportEventType;
    readonly exportId: string;
    readonly occurredAt: Date;
    readonly commandId: string | null;
    readonly payload: Record<string, unknown>;
  },
): Promise<string> {
  const eventId = deps.idGenerator.newId();
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(eventId),
      event_type: input.eventType,
      producer_module: 'analytics',
      aggregate_type: 'ANALYTICS_EXPORT',
      aggregate_id: toBin(input.exportId),
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
      command_id: toBinOrNull(input.commandId),
    })
    .execute();
  return eventId;
}

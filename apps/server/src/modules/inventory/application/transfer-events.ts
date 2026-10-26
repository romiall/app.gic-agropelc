/**
 * Événements de transfert pour les notifications directes (P9-11 (3/3) ; catalogue d'événements §2.4 ;
 * AV-439, AV-480) : `StockTransferRequested` à la demande d'un transfert (prévient les expéditeurs du site
 * source) et `StockTransferDispatched` à son expédition (prévient les réceptionnaires du site
 * destinataire), écrits dans `platform_domain_events` dans la transaction de la commande.
 *
 * Le pipeline écrit en plus sa ligne générique (`event_type` = type de commande) ; les consommateurs
 * filtrent sur ces noms explicites. L'identifiant de l'événement est déterministe (type + transfert) : une
 * demande et une expédition n'arrivent qu'une fois par transfert. La charge utile ne porte ni quantité ni
 * produit : ni valeur ni stock à diffuser dans une notification.
 */
import { sql } from 'kysely';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { deterministicEventId } from '../../../platform/events/deterministic-event-id.js';
import { jsonValue } from '../../../platform/kysely/json-value.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../platform/kysely/uuid-columns.js';

export type TransferNotificationEventType = 'StockTransferRequested' | 'StockTransferDispatched';

/**
 * Publie l'événement du transfert, relu dans la transaction (numéro de document, emplacements et sites des
 * deux côtés — un emplacement virtuel n'a pas de site). Sans effet si le transfert n'existe pas.
 */
export async function publishTransferEvent(
  uow: UnitOfWork,
  input: {
    readonly eventType: TransferNotificationEventType;
    readonly transferId: string;
    /** Le demandeur (`StockTransferRequested`) ou l'expéditeur (`StockTransferDispatched`). */
    readonly actorUserId: string;
    readonly occurredAt: Date;
    readonly commandId: string | null;
  },
): Promise<void> {
  const row = await uow
    .selectFrom('inventory_stock_transfers as t')
    .leftJoin('organization_locations as source', 'source.id', 't.from_location_id')
    .leftJoin('organization_locations as target', 'target.id', 't.to_location_id')
    .select([
      't.doc_number',
      't.from_location_id',
      't.to_location_id',
      'source.site_id as from_site_id',
      'target.site_id as to_site_id',
      sql<number>`(SELECT COUNT(*) FROM inventory_stock_transfer_lines l WHERE l.transfer_id = t.id)`.as(
        'line_count',
      ),
    ])
    .where('t.id', '=', toBin(input.transferId))
    .executeTakeFirst();
  if (row === undefined) return;

  const requested = input.eventType === 'StockTransferRequested';
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(deterministicEventId(input.eventType, input.transferId)),
      event_type: input.eventType,
      producer_module: 'inventory',
      aggregate_type: 'STOCK_TRANSFER',
      aggregate_id: toBin(input.transferId),
      occurred_at: input.occurredAt,
      payload: jsonValue({
        transfer_id: input.transferId,
        doc_number: row.doc_number,
        from_location_id: fromBin(row.from_location_id),
        to_location_id: fromBin(row.to_location_id),
        from_site_id: fromBinOrNull(row.from_site_id),
        to_site_id: fromBinOrNull(row.to_site_id),
        line_count: Number(row.line_count),
        [requested ? 'requested_by' : 'dispatched_by']: input.actorUserId,
        occurred_at: input.occurredAt.toISOString(),
      }),
      command_id: toBinOrNull(input.commandId),
    })
    .execute();
}

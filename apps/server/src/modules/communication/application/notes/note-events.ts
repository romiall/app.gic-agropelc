/**
 * Événements explicites des notes de direction (P9-11 ; D13 §10 ; catalogue d'événements §2.9 ; ADR-073 §7) :
 * `InternalNotePublished`, `InternalNoteArchived` et `InternalNoteAcknowledged`, écrits dans
 * `platform_domain_events` dans la transaction de la commande. Ils servent la synchronisation (jeu `comms`) et
 * l'audit : **aucun autre module ne les consomme pour agir** (BR-NOT-007 : une note ne porte aucun effet métier).
 *
 * Le pipeline écrit en plus sa ligne générique (`event_type` = type de commande) ; les consommateurs filtrent
 * sur ces noms explicites. L'identifiant de l'événement de publication sert de source aux notifications de la
 * note : un rejeu ne les double pas.
 */
import type { IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

export type NoteEventType =
  'InternalNotePublished' | 'InternalNoteArchived' | 'InternalNoteAcknowledged';

/** Écrit l'événement ; renvoie son identifiant. */
export async function publishNoteEvent(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly eventType: NoteEventType;
    readonly noteId: string;
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
      producer_module: 'communication',
      aggregate_type: 'INTERNAL_NOTE',
      aggregate_id: toBin(input.noteId),
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
      command_id: toBinOrNull(input.commandId),
    })
    .execute();
  return eventId;
}

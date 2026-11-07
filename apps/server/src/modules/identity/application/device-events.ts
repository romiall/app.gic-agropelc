/**
 * Événement d'appareil pour les notifications directes (AV-432 ; catalogue d'événements §2.1 ; D13 §7) :
 * `DeviceEnrollmentRequested` à la première connexion d'un appareil (statut `PENDING`) prévient ceux qui peuvent
 * l'approuver. Il est écrit dans `platform_domain_events` **dans la transaction de la connexion** ; l'identifiant est
 * déterministe (type + appareil) : un appareil n'est enrôlé qu'une fois, un rejeu ne publie rien de plus.
 *
 * La charge utile ne porte que ce qu'un approbateur lit déjà sur la file des appareils (code court, enrôleur) : ni
 * étiquette, ni plateforme, ni donnée du compte.
 */
import { deterministicEventId } from '../../../platform/events/deterministic-event-id.js';
import { jsonValue } from '../../../platform/kysely/json-value.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

export async function publishDeviceEnrollmentRequested(
  uow: UnitOfWork,
  input: {
    readonly deviceId: string;
    readonly shortCode: string;
    /** Le compte qui a connecté l'appareil : propriétaire de la ressource, jamais destinataire (AV-258). */
    readonly enrolledByUserId: string;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(deterministicEventId('DeviceEnrollmentRequested', input.deviceId)),
      event_type: 'DeviceEnrollmentRequested',
      producer_module: 'identity',
      aggregate_type: 'DEVICE',
      aggregate_id: toBin(input.deviceId),
      occurred_at: input.occurredAt,
      payload: jsonValue({
        device_id: input.deviceId,
        short_code: input.shortCode,
        enrolled_by_user_id: input.enrolledByUserId,
        occurred_at: input.occurredAt.toISOString(),
      }),
      command_id: null,
    })
    .execute();
}

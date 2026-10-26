/**
 * Consommateur `communication.direct` (P9-11 (3/3) ; AV-389, AV-430, AV-431 ; ADR-062 §4) : transforme les
 * événements du catalogue dont la conséquence est « notification » — une demande de validation, sa
 * décision, un transfert demandé ou expédié — en notifications `IN_APP` de nature `DIRECT`, adressées à la
 * personne qui doit agir ou qui attendait la réponse.
 *
 * - **Au moins une fois** : l'unicité (utilisateur, canal, événement source) de `communication.
 *   notifications` rend un événement rejoué sans effet ; aucun marqueur à part.
 * - **Un type par réglage** : `communication.direct_notification_disabled_types` désactive les
 *   notifications d'un type, sans arrêter l'événement (AV-431).
 * - **Destinataires** jugés à l'instant du traitement, par le port du résolveur (ADR-062 §2) ; l'auteur du
 *   fait n'est jamais prévenu.
 * - **Charge fautive** : l'exception remonte au coureur de consommateurs, qui consigne l'échec et alerte
 *   (`CONSUMER_FAILED`) ; jamais d'événement ignoré en silence.
 * - Aucune lecture des tables d'un autre module : tout ce qu'il faut est dans l'événement.
 */
import {
  disabledDirectNotificationTypes,
  isDirectNotificationEventType,
  planDirectNotification,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import type { DomainEvent } from '../../../../platform/events/domain-event.js';
import type { EventConsumerRegistry } from '../../../../platform/events/event-consumer-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { insertNotification } from '../notifications/notification-store.js';
import type { AlertRecipientResolver } from '../recipients/recipient-resolver.js';
import { resolveDirectRecipients } from '../recipients/resolve-direct-recipients.js';

export const DIRECT_CONSUMER_NAME = 'communication.direct';
export const DIRECT_DISABLED_TYPES_KEY = 'communication.direct_notification_disabled_types';

export interface DirectNotificationsDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly resolver: AlertRecipientResolver;
}

/** Traite un événement ; renvoie le nombre de notifications écrites (0 si rejouée ou sans destinataire). */
export function createDirectNotificationHandler(
  deps: DirectNotificationsDeps,
): (uow: UnitOfWork, event: DomainEvent) => Promise<number> {
  return async (uow, event) => {
    const eventType = event.eventType;
    if (!isDirectNotificationEventType(eventType)) return 0;
    const now = deps.clock.now();
    const disabled = disabledDirectNotificationTypes(
      await currentSettingValue(uow, {
        key: DIRECT_DISABLED_TYPES_KEY,
        scopeType: 'GLOBAL',
        scopeId: null,
        at: now,
      }),
    );
    if (disabled.has(eventType)) return 0;

    const plan = planDirectNotification({
      eventType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    });
    const userIds = await resolveDirectRecipients(uow, deps.resolver, plan.audience, now);
    let written = 0;
    for (const userId of userIds) {
      const inserted = await insertNotification(uow, deps.idGenerator, {
        userId,
        channel: 'IN_APP',
        kind: plan.kind ?? 'DIRECT',
        sourceType: plan.sourceType,
        sourceId: plan.sourceId,
        sourceEventId: event.eventId,
        title: plan.title,
        body: plan.body,
        link: null,
        createdAt: now,
        deliveredAt: now,
      });
      if (inserted) written += 1;
    }
    return written;
  };
}

export function registerDirectNotificationsConsumer(
  registry: EventConsumerRegistry,
  deps: DirectNotificationsDeps,
): void {
  const handle = createDirectNotificationHandler(deps);
  registry.register(DIRECT_CONSUMER_NAME, async (uow, event: DomainEvent) => {
    await handle(uow, event);
  });
}

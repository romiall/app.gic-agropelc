/**
 * Consommateur d'événements `identity.rbac_cache` (P0-10) : invalide, dans le cache mémoire
 * du processus courant (`rbac-cache.ts`), les droits de l'utilisateur visé par un octroi/une
 * révocation d'affectation de rôle. Enregistré comme n'importe quel consommateur P0-08
 * (`EventConsumerRegistry`, position durable dans `platform_event_consumer_offsets`), mais
 * **jamais drainé par le worker** : `worker.module.ts` n'importe pas `IdentityModule`, donc
 * n'enregistre jamais ce nom — seul `rbac-cache-poller.ts`, dans le processus API, l'appelle
 * (`rbac-cache.ts`, commentaire de tête : le cache n'a de sens que colocalisé avec les
 * évaluations qu'il accélère).
 */
import type { EventConsumerRegistry } from '../../../../platform/events/event-consumer-registry.js';
import type { DomainEvent } from '../../../../platform/events/domain-event.js';
import { ROLE_ASSIGNMENT_EVENT_TYPES } from '../commands/role-assignment-commands.js';
import { invalidateUser } from './rbac-cache.js';

export const RBAC_CACHE_CONSUMER_NAME = 'identity.rbac_cache';

const INVALIDATING_EVENT_TYPES: ReadonlySet<string> = new Set(ROLE_ASSIGNMENT_EVENT_TYPES);

export function registerRbacCacheConsumer(registry: EventConsumerRegistry): void {
  registry.register(RBAC_CACHE_CONSUMER_NAME, async (_uow, event: DomainEvent) => {
    if (!INVALIDATING_EVENT_TYPES.has(event.eventType)) return;
    const payload = event.payload as { userId?: unknown };
    if (typeof payload.userId === 'string') {
      invalidateUser(payload.userId);
    }
  });
}

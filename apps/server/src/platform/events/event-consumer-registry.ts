/**
 * Registre `consumer_name → gestionnaire` (05-architecture/02-modules.md §17 `sync`, même
 * inversion de dépendance que `CommandHandlerRegistry`/`JobHandlerRegistry`) : chaque
 * consommateur (alertes, projections, Kommo…) s'enregistre au démarrage sous le nom qui sert
 * de clé dans `platform_event_consumer_offsets.consumer_name`
 * (08-api-events/02-catalogue-evenements.md §1 : ex. `communication.alerts`,
 * `integrations.kommo`, `analytics.projections`).
 */
import type { UnitOfWork } from '../unit-of-work.js';
import type { DomainEvent } from './domain-event.js';

export type EventConsumerHandler<P = unknown> = (
  uow: UnitOfWork,
  event: DomainEvent<P>,
) => Promise<void>;

export class EventConsumerRegistry {
  private readonly handlers = new Map<string, EventConsumerHandler>();

  register<P>(consumerName: string, handler: EventConsumerHandler<P>): void {
    if (this.handlers.has(consumerName)) {
      throw new Error(`Consommateur déjà enregistré : ${consumerName}.`);
    }
    this.handlers.set(consumerName, handler as EventConsumerHandler);
  }

  resolve(consumerName: string): EventConsumerHandler | undefined {
    return this.handlers.get(consumerName);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}

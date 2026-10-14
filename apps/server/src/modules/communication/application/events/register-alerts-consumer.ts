/**
 * Enregistrement du consommateur `communication.alerts` au démarrage (même inversion de dépendance que
 * `AllocationRevocationConsumerRegistrar`). Porté par `CommunicationJobsModule`, importé par le processus
 * worker, qui draine les consommateurs enregistrés.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdGenerator } from '@gic/domain';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../../../../platform/events/event-consumer-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { registerAlertsConsumer } from './alerts-consumer.js';

@Injectable()
export class AlertsConsumerRegistrar implements OnModuleInit {
  constructor(
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly registry: EventConsumerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  onModuleInit(): void {
    registerAlertsConsumer(this.registry, { idGenerator: this.idGenerator });
  }
}

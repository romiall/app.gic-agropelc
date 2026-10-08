/**
 * Enregistrement du consommateur `inventory.allocation_revocation` au démarrage (même inversion de
 * dépendance que `RbacCacheConsumerRegistrar`). Porté par `InventoryJobsModule`, importé par le
 * processus worker, qui draine les consommateurs enregistrés.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdGenerator } from '@gic/domain';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../../../../platform/events/event-consumer-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { registerAllocationRevocationConsumer } from './allocation-revocation-consumer.js';

@Injectable()
export class AllocationRevocationConsumerRegistrar implements OnModuleInit {
  constructor(
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly registry: EventConsumerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  onModuleInit(): void {
    registerAllocationRevocationConsumer(this.registry, this.idGenerator);
  }
}

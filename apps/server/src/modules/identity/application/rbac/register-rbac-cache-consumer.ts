/**
 * Enregistrement du consommateur `identity.rbac_cache` au démarrage (même inversion de
 * dépendance que `IdentityCommandsRegistrar`, `commands/register-identity-commands.ts`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../../../../platform/events/event-consumer-registry.provider.js';
import { registerRbacCacheConsumer } from './rbac-cache-consumer.js';

@Injectable()
export class RbacCacheConsumerRegistrar implements OnModuleInit {
  constructor(@Inject(EVENT_CONSUMER_REGISTRY) private readonly registry: EventConsumerRegistry) {}

  onModuleInit(): void {
    registerRbacCacheConsumer(this.registry);
  }
}

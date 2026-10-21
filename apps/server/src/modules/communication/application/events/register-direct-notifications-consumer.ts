/**
 * Enregistrement du consommateur `communication.direct` au démarrage (même inversion de dépendance que
 * `AlertsConsumerRegistrar`) : porté par `CommunicationJobsModule`, importé par le processus worker, qui
 * draine les consommateurs enregistrés. Le résolveur de destinataires est fourni par jeton.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../../../../platform/events/event-consumer-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  ALERT_RECIPIENT_RESOLVER,
  type AlertRecipientResolver,
} from '../recipients/recipient-resolver.js';
import { registerDirectNotificationsConsumer } from './direct-notifications-consumer.js';

@Injectable()
export class DirectNotificationsConsumerRegistrar implements OnModuleInit {
  constructor(
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly registry: EventConsumerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ALERT_RECIPIENT_RESOLVER) private readonly resolver: AlertRecipientResolver,
  ) {}

  onModuleInit(): void {
    registerDirectNotificationsConsumer(this.registry, {
      idGenerator: this.idGenerator,
      clock: this.clock,
      resolver: this.resolver,
    });
  }
}

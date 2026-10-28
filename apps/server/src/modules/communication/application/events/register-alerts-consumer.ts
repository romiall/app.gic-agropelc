/**
 * Enregistrement du consommateur `communication.alerts` au démarrage (même inversion de dépendance que
 * `AllocationRevocationConsumerRegistrar`). Porté par `CommunicationJobsModule`, importé par le processus
 * worker, qui draine les consommateurs enregistrés. P9-05 : la suite d'une levée (destinataires,
 * notifications) est branchée ici, avec le résolveur et le canal Web Push fournis par jeton.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../../../../platform/events/event-consumer-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { createAlertNotifier } from '../notifications/alert-notifier.js';
import { WEB_PUSH_SENDER, type WebPushSender } from '../notifications/web-push.js';
import {
  ALERT_RECIPIENT_RESOLVER,
  type AlertRecipientResolver,
} from '../recipients/recipient-resolver.js';
import { registerAlertsConsumer } from './alerts-consumer.js';

@Injectable()
export class AlertsConsumerRegistrar implements OnModuleInit {
  constructor(
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly registry: EventConsumerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ALERT_RECIPIENT_RESOLVER) private readonly resolver: AlertRecipientResolver,
    @Inject(WEB_PUSH_SENDER) private readonly push: WebPushSender,
  ) {}

  onModuleInit(): void {
    registerAlertsConsumer(this.registry, {
      idGenerator: this.idGenerator,
      clock: this.clock,
      afterRaise: createAlertNotifier({
        idGenerator: this.idGenerator,
        clock: this.clock,
        resolver: this.resolver,
        push: this.push,
      }),
    });
  }
}

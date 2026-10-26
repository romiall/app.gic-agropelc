/**
 * `communication.alerts.escalate` (P9-05 ; BR-NOT-005 ; ADR-062 §7) : escalade les alertes critiques non
 * prises en compte dont l'échéance est passée. Voir `alerts/alert-escalation.ts`. Récurrence : toutes les
 * dix minutes (`communication-recurring-jobs.ts`).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { escalateDueAlerts } from '../alerts/alert-escalation.js';
import { WEB_PUSH_SENDER, type WebPushSender } from '../notifications/web-push.js';
import {
  ALERT_RECIPIENT_RESOLVER,
  type AlertRecipientResolver,
} from '../recipients/recipient-resolver.js';

export const ALERT_ESCALATION_JOB_TYPE = 'communication.alerts.escalate';

@Injectable()
export class AlertEscalationJob implements OnModuleInit {
  private readonly logger = new Logger(AlertEscalationJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(ALERT_RECIPIENT_RESOLVER) private readonly resolver: AlertRecipientResolver,
    @Inject(WEB_PUSH_SENDER) private readonly push: WebPushSender,
  ) {}

  onModuleInit(): void {
    this.registry.register(ALERT_ESCALATION_JOB_TYPE, async (uow) => {
      const result = await escalateDueAlerts(uow, {
        idGenerator: this.idGenerator,
        clock: this.clock,
        resolver: this.resolver,
        push: this.push,
      });
      if (result.escalated > 0) {
        this.logger.log(`Alertes escaladées : ${result.escalated} sur ${result.examined}.`);
      }
    });
  }
}

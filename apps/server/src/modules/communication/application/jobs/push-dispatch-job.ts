/**
 * `communication.push.dispatch` (P9-05 ; ADR-062 §5 ; BR-NOT-004) : envoie, après validation de la
 * transaction qui les a créées, les notifications Web Push en attente. Voir
 * `notifications/push-dispatch.ts`. Récurrence : chaque minute.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { dispatchPendingPushes } from '../notifications/push-dispatch.js';
import { WEB_PUSH_SENDER, type WebPushSender } from '../notifications/web-push.js';

export const PUSH_DISPATCH_JOB_TYPE = 'communication.push.dispatch';

@Injectable()
export class PushDispatchJob implements OnModuleInit {
  private readonly logger = new Logger(PushDispatchJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(WEB_PUSH_SENDER) private readonly sender: WebPushSender,
  ) {}

  onModuleInit(): void {
    this.registry.register(PUSH_DISPATCH_JOB_TYPE, async (uow) => {
      const result = await dispatchPendingPushes(uow, { clock: this.clock, sender: this.sender });
      if (result.delivered > 0 || result.revoked > 0) {
        this.logger.log(
          `Push : ${result.delivered} envoyé(s), ${result.revoked} abonnement(s) révoqué(s).`,
        );
      }
    });
  }
}

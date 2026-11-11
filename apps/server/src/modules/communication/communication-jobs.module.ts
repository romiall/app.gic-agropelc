/**
 * Consommateur d'événements et tâches planifiées de `communication` (P9-04 : consommateur
 * `communication.alerts` ; P9-05 : destinataires, notifications, escalade et envoi des push ; P9-10 :
 * consommateur en échec ; P9-11 : consommateur `communication.direct` des notifications directes ; P9-25 :
 * purges techniques ; P9-27 : tâches de fond en échec, `JOB_FAILED`). Module séparé de `CommunicationModule` (comme `InventoryJobsModule`) : il ne
 * dépend que de `platform` — et du port du résolveur de destinataires, fourni par jeton par
 * `CommunicationRecipientsModule` (global) — pour être importé aussi par le processus worker sans tirer
 * les gestionnaires de commande.
 *
 * Le canal Web Push est **désactivé tant que le porteur n'a pas posé ses clés VAPID** (`VAPID_PUBLIC_KEY`,
 * `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, AV-365 et AV-536) : l'adaptateur est alors `DisabledWebPushSender` et
 * les notifications restent `IN_APP`. Avec des clés valides, c'est `VapidWebPushSender` (RFC 8291 et 8292).
 */
import { Logger, Module } from '@nestjs/common';
import type { Env } from '../../platform/env.js';
import { ENV } from '../../platform/env.provider.js';
import { AlertsConsumerRegistrar } from './application/events/register-alerts-consumer.js';
import { DirectNotificationsConsumerRegistrar } from './application/events/register-direct-notifications-consumer.js';
import { AlertEscalationJob } from './application/jobs/alert-escalation-job.js';
import { CommunicationPurgeJob } from './application/jobs/communication-purge-job.js';
import { CommunicationRecurringJobs } from './application/jobs/communication-recurring-jobs.js';
import { ConsumerFailureJob } from './application/jobs/consumer-failure-job.js';
import { JobFailureJob } from './application/jobs/job-failure-job.js';
import { PushDispatchJob } from './application/jobs/push-dispatch-job.js';
import { webPushSenderFromEnv } from './application/notifications/vapid-web-push.js';
import { WEB_PUSH_SENDER, type WebPushSender } from './application/notifications/web-push.js';

@Module({
  providers: [
    {
      provide: WEB_PUSH_SENDER,
      useFactory: (env: Env): WebPushSender => {
        const logger = new Logger('communication.push');
        const sender = webPushSenderFromEnv(env, (issues) =>
          logger.warn(`Configuration VAPID invalide, Web Push désactivé : ${issues.join(' ; ')}.`),
        );
        logger.log(
          sender.enabled
            ? 'Web Push activé (clés VAPID posées).'
            : 'Web Push désactivé (aucune clé VAPID valide) : notifications dans l’application seulement.',
        );
        return sender;
      },
      inject: [ENV],
    },
    AlertsConsumerRegistrar,
    DirectNotificationsConsumerRegistrar,
    AlertEscalationJob,
    PushDispatchJob,
    ConsumerFailureJob,
    JobFailureJob,
    CommunicationPurgeJob,
    CommunicationRecurringJobs,
  ],
})
export class CommunicationJobsModule {}

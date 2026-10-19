/**
 * Consommateur d'événements et tâches planifiées de `communication` (P9-04 : consommateur
 * `communication.alerts` ; P9-05 : destinataires, notifications, escalade et envoi des push ; P9-10 :
 * consommateur en échec). Module séparé de `CommunicationModule` (comme `InventoryJobsModule`) : il ne
 * dépend que de `platform` — et du port du résolveur de destinataires, fourni par jeton par
 * `CommunicationRecipientsModule` (global) — pour être importé aussi par le processus worker sans tirer
 * les gestionnaires de commande.
 *
 * Le canal Web Push par défaut est désactivé : aucune bibliothèque ni clé VAPID tant que le porteur n'a
 * pas tranché AV-415. Un adaptateur réel remplace le jeton sans autre changement.
 */
import { Module } from '@nestjs/common';
import { AlertsConsumerRegistrar } from './application/events/register-alerts-consumer.js';
import { AlertEscalationJob } from './application/jobs/alert-escalation-job.js';
import { CommunicationRecurringJobs } from './application/jobs/communication-recurring-jobs.js';
import { ConsumerFailureJob } from './application/jobs/consumer-failure-job.js';
import { PushDispatchJob } from './application/jobs/push-dispatch-job.js';
import { DisabledWebPushSender, WEB_PUSH_SENDER } from './application/notifications/web-push.js';

@Module({
  providers: [
    { provide: WEB_PUSH_SENDER, useValue: new DisabledWebPushSender() },
    AlertsConsumerRegistrar,
    AlertEscalationJob,
    PushDispatchJob,
    ConsumerFailureJob,
    CommunicationRecurringJobs,
  ],
})
export class CommunicationJobsModule {}

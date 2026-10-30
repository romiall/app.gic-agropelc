/**
 * Récurrences des tâches de `communication` (P9-05 ; ordonnanceur `platform/jobs/job-scheduler.ts`) :
 * - `communication.alerts.escalate` : toutes les 10 minutes (BR-NOT-005 : l'écart toléré sur une échéance
 *   de plusieurs heures est de quelques minutes) ;
 * - `communication.push.dispatch` : chaque minute (BR-NOT-004 : push « immédiat » après validation) ;
 * - `communication.consumers.failure_check` : toutes les cinq minutes (P9-10, AV-425) — le retard toléré est de
 *   300 s (`communication.consumer_lag_alert_seconds`) : la passe le rattrape à une cadence du même ordre ;
 * - `communication.jobs.failure_check` : toutes les cinq minutes (P9-27, AV-469 choix (b)) — même cadence que la
 *   vérification des consommateurs ; la fenêtre des tâches échouées est `platform.failed_jobs_window_hours` ;
 * - `communication.maintenance.purge_daily` : chaque jour à 03:30 (P9-25, PF-1 et PF-7 ; ADR-068 §8), après la
 *   chaîne d'audit de 03:00.
 * Constantes techniques de planification, pas des seuils métier (comme `inventory-recurring-jobs.ts`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { ALERT_ESCALATION_JOB_TYPE } from './alert-escalation-job.js';
import { COMMUNICATION_PURGE_JOB_TYPE } from './communication-purge-job.js';
import { CONSUMER_FAILURE_JOB_TYPE } from './consumer-failure-job.js';
import { JOB_FAILURE_JOB_TYPE } from './job-failure-job.js';
import { PUSH_DISPATCH_JOB_TYPE } from './push-dispatch-job.js';

export const COMMUNICATION_RECURRING_JOBS = [
  { jobType: ALERT_ESCALATION_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 600 } },
  { jobType: PUSH_DISPATCH_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 60 } },
  { jobType: CONSUMER_FAILURE_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 300 } },
  { jobType: JOB_FAILURE_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 300 } },
  { jobType: COMMUNICATION_PURGE_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '03:30' } },
] as const;

@Injectable()
export class CommunicationRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of COMMUNICATION_RECURRING_JOBS) this.recurring.register(job);
  }
}

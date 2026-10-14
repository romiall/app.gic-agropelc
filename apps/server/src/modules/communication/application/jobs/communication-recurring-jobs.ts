/**
 * Récurrences des tâches de `communication` (P9-05 ; ordonnanceur `platform/jobs/job-scheduler.ts`) :
 * - `communication.alerts.escalate` : toutes les 10 minutes (BR-NOT-005 : l'écart toléré sur une échéance
 *   de plusieurs heures est de quelques minutes) ;
 * - `communication.push.dispatch` : chaque minute (BR-NOT-004 : push « immédiat » après validation).
 * Constantes techniques de planification, pas des seuils métier (comme `inventory-recurring-jobs.ts`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { ALERT_ESCALATION_JOB_TYPE } from './alert-escalation-job.js';
import { PUSH_DISPATCH_JOB_TYPE } from './push-dispatch-job.js';

export const COMMUNICATION_RECURRING_JOBS = [
  { jobType: ALERT_ESCALATION_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 600 } },
  { jobType: PUSH_DISPATCH_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 60 } },
] as const;

@Injectable()
export class CommunicationRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of COMMUNICATION_RECURRING_JOBS) this.recurring.register(job);
  }
}

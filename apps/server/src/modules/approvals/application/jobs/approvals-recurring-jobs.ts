/**
 * Récurrences des tâches de `approvals` (ordonnanceur `platform/jobs/job-scheduler.ts`, P9-09) :
 * - `approvals.requests.pending_long_check` : toutes les heures — le délai se compte en heures
 *   (`approvals.pending_long_hours`, 24) : la passe rapproche la levée du dépassement et la fermeture de la
 *   décision à moins d'une heure (même cadence que les ouvertures de caisse prolongées de `finance`).
 * Constante technique de planification, pas un seuil métier.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { APPROVAL_PENDING_LONG_JOB_TYPE } from './approval-pending-long-job.js';

export const APPROVALS_RECURRING_JOBS = [
  {
    jobType: APPROVAL_PENDING_LONG_JOB_TYPE,
    schedule: { kind: 'INTERVAL', intervalSeconds: 3600 },
  },
] as const;

@Injectable()
export class ApprovalsRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of APPROVALS_RECURRING_JOBS) this.recurring.register(job);
  }
}

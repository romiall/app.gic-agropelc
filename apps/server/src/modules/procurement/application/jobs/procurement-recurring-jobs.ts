/**
 * Récurrences des tâches de `procurement` (ordonnanceur `platform/jobs/job-scheduler.ts`, P9-09) :
 * - `procurement.receipts.attachment_missing_check` : chaque jour à 06:15, heure de Douala (D13 §7.1 ; le
 *   délai de la photo se compte en jours, `attachments.missing_alert_days`) ;
 * - `procurement.orders.receipt_incomplete_check` : chaque jour à 07:15 — le retard de livraison se compte
 *   en jours métier (`procurement.receipt_incomplete_alert_days`) : la passe suit le changement de jour de
 *   Douala (AV-410 : « tâche quotidienne pour le retard »).
 * Constantes techniques de planification, pas des seuils métier.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { RECEIPT_ATTACHMENT_MISSING_JOB_TYPE } from './receipt-attachment-missing-job.js';
import { RECEIPT_INCOMPLETE_JOB_TYPE } from './receipt-incomplete-job.js';

export const PROCUREMENT_RECURRING_JOBS = [
  {
    jobType: RECEIPT_ATTACHMENT_MISSING_JOB_TYPE,
    schedule: { kind: 'DAILY', localTime: '06:15' },
  },
  { jobType: RECEIPT_INCOMPLETE_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '07:15' } },
] as const;

@Injectable()
export class ProcurementRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of PROCUREMENT_RECURRING_JOBS) this.recurring.register(job);
  }
}

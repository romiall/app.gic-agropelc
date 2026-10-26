/**
 * Récurrences des tâches de `sales` (P9-07 ; ordonnanceur `platform/jobs/job-scheduler.ts`) : des passes
 * quotidiennes de détection d'alertes d'état, dont les créneaux sont des constantes de planification
 * (AV-361) et non des seuils métier (les seuils restent des paramètres système lus par chaque tâche) :
 * - `sales.losses.sales_share_check` (P9-08) : 06:45 — pertes des deux derniers jours clos rapportées au CA
 *   net du site (`HIGH_LOSS`, AV-405) ;
 * - `sales.receivables.overdue_daily` (P4-09) : 07:00 — BR-FIN-007 « l'alerte est levée chaque jour à
 *   07:00 » ;
 * - `sales.orders.undelivered_check` : 07:30 — vente confirmée non livrée (AV-132) ;
 * - `sales.commercial.inactivity_check` : 08:00 — BR-TER-013 « le lendemain à 08:00 ».
 * Heure de Douala. Les passes ne se chevauchent pas : une passe est une transaction de quelques secondes.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { HIGH_LOSS_SALES_SHARE_JOB_TYPE } from './high-loss-sales-share-job.js';
import { INACTIVE_COMMERCIAL_JOB_TYPE } from './inactive-commercial-job.js';
import { RECEIVABLES_OVERDUE_JOB_TYPE } from './receivables-overdue-job.js';
import { UNDELIVERED_SALES_JOB_TYPE } from './undelivered-sales-job.js';

export const SALES_RECURRING_JOBS = [
  { jobType: HIGH_LOSS_SALES_SHARE_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '06:45' } },
  { jobType: RECEIVABLES_OVERDUE_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '07:00' } },
  { jobType: UNDELIVERED_SALES_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '07:30' } },
  { jobType: INACTIVE_COMMERCIAL_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '08:00' } },
] as const;

@Injectable()
export class SalesRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of SALES_RECURRING_JOBS) this.recurring.register(job);
  }
}

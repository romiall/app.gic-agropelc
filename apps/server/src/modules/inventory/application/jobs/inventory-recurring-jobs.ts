/**
 * Récurrences des tâches d'`inventory` (P5-16 ; ordonnanceur `platform/jobs/job-scheduler.ts`) :
 * - `inventory.transfers.unmatched_sweep` : toutes les heures (BR-STK-024, délai compté en heures) ;
 * - `inventory.allocations.expiry_daily` (P5-08) : chaque jour à 00:05, heure de Douala — juste
 *   après la fin du jour métier, validité par défaut d'un quota (AV-160) ;
 * - `inventory.ledger.reconcile_daily` (P2-07) : chaque jour à 02:00, heure de Douala, hors activité.
 * Constantes techniques de planification, pas des seuils métier. Les tâches quotidiennes des autres
 * modules (audit, finance, ventes, terrain) s'inscrivent de la même façon, une ligne chacune, dans
 * leur propre module (02-modules.md §1).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { ALLOCATION_EXPIRY_JOB_TYPE } from './allocation-expiry-job.js';
import { LEDGER_RECONCILIATION_JOB_TYPE } from './ledger-reconciliation-job.js';
import { UNMATCHED_TRANSFER_SWEEP_JOB_TYPE } from './unmatched-transfer-sweep-job.js';

export const INVENTORY_RECURRING_JOBS = [
  {
    jobType: UNMATCHED_TRANSFER_SWEEP_JOB_TYPE,
    schedule: { kind: 'INTERVAL', intervalSeconds: 3600 },
  },
  { jobType: ALLOCATION_EXPIRY_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '00:05' } },
  { jobType: LEDGER_RECONCILIATION_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '02:00' } },
] as const;

@Injectable()
export class InventoryRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of INVENTORY_RECURRING_JOBS) this.recurring.register(job);
  }
}

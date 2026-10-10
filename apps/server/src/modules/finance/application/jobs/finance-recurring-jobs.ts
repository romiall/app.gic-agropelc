/**
 * Récurrences des tâches de `finance` (ordonnanceur `platform/jobs/job-scheduler.ts`, P5-16) :
 * - `finance.cash_sessions.open_long_check` (P5-12) : toutes les heures — le seuil d'ouverture
 *   prolongée se compte en heures (`finance.cash_session_force_close_hours`, 24 par défaut) ;
 * - `finance.cash_transfers.unreceived_check` (P5-15) : toutes les heures — délai d'une remise non
 *   reçue compté en heures (`finance.cash_transfer_unreceived_hours`, 48 par défaut, AV-158) ;
 * - `finance.cash.reconcile_daily` (P4-03) : chaque jour à 02:30, heure de Douala, hors activité et
 *   après la réconciliation du stock (02:00).
 * Constantes techniques de planification, pas des seuils métier (les seuils restent des paramètres
 * système lus par chaque tâche).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { CASH_LEDGER_RECONCILIATION_JOB_TYPE } from './cash-ledger-reconciliation-job.js';
import { CASH_SESSION_OPEN_LONG_JOB_TYPE } from './cash-session-open-long-job.js';
import { CASH_TRANSFER_UNRECEIVED_JOB_TYPE } from './cash-transfer-unreceived-job.js';

export const FINANCE_RECURRING_JOBS = [
  {
    jobType: CASH_SESSION_OPEN_LONG_JOB_TYPE,
    schedule: { kind: 'INTERVAL', intervalSeconds: 3600 },
  },
  {
    jobType: CASH_TRANSFER_UNRECEIVED_JOB_TYPE,
    schedule: { kind: 'INTERVAL', intervalSeconds: 3600 },
  },
  { jobType: CASH_LEDGER_RECONCILIATION_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '02:30' } },
] as const;

@Injectable()
export class FinanceRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of FINANCE_RECURRING_JOBS) this.recurring.register(job);
  }
}

/**
 * Tâches planifiées de `finance` (P4-03 : `finance.cash.reconcile_daily` ; P5-12 :
 * `finance.cash_sessions.open_long_check` ; P5-15 : `finance.cash_transfers.unreceived_check`) et leur
 * inscription à l'ordonnanceur (`FinanceRecurringJobs`, P5-16). Module séparé de `FinanceModule`,
 * comme `InventoryJobsModule` : il ne dépend que de `platform`, pour être importé aussi par le
 * processus worker sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { CashLedgerReconciliationJob } from './application/jobs/cash-ledger-reconciliation-job.js';
import { CashSessionOpenLongJob } from './application/jobs/cash-session-open-long-job.js';
import { CashTransferUnreceivedJob } from './application/jobs/cash-transfer-unreceived-job.js';
import { FinanceRecurringJobs } from './application/jobs/finance-recurring-jobs.js';

@Module({
  providers: [
    CashLedgerReconciliationJob,
    CashSessionOpenLongJob,
    CashTransferUnreceivedJob,
    FinanceRecurringJobs,
  ],
})
export class FinanceJobsModule {}

/**
 * Tâches planifiées de `finance` et leur inscription à l'ordonnanceur (`FinanceRecurringJobs`, P5-16) :
 * `finance.cash.reconcile_daily` (P4-03), `finance.cash_sessions.open_long_check` (P5-12),
 * `finance.cash_transfers.unreceived_check` (P5-15), `finance.cash_holdings.high_check` et
 * `finance.expenses.attachment_missing_check` (P9-07). Module séparé de `FinanceModule`, comme
 * `InventoryJobsModule` : il ne dépend que de `platform`, pour être importé aussi par le processus worker
 * sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { CashHoldingHighJob } from './application/jobs/cash-holding-high-job.js';
import { CashLedgerReconciliationJob } from './application/jobs/cash-ledger-reconciliation-job.js';
import { CashSessionOpenLongJob } from './application/jobs/cash-session-open-long-job.js';
import { CashTransferUnreceivedJob } from './application/jobs/cash-transfer-unreceived-job.js';
import { ExpenseAttachmentMissingJob } from './application/jobs/expense-attachment-missing-job.js';
import { FinanceRecurringJobs } from './application/jobs/finance-recurring-jobs.js';

@Module({
  providers: [
    CashHoldingHighJob,
    CashLedgerReconciliationJob,
    CashSessionOpenLongJob,
    CashTransferUnreceivedJob,
    ExpenseAttachmentMissingJob,
    FinanceRecurringJobs,
  ],
})
export class FinanceJobsModule {}

/**
 * Tâches planifiées de `finance` (P4-03 : `finance.cash.reconcile_daily`). Module séparé de
 * `FinanceModule`, comme `InventoryJobsModule` : il ne dépend que de `platform`, pour être importé
 * aussi par le processus worker sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { CashLedgerReconciliationJob } from './application/jobs/cash-ledger-reconciliation-job.js';

@Module({
  providers: [CashLedgerReconciliationJob],
})
export class FinanceJobsModule {}

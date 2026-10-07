/**
 * Tâches planifiées de `sales` (P4-09 : `sales.receivables.overdue_daily`). Module séparé de
 * `SalesModule`, comme `FinanceJobsModule` : il ne dépend que de `platform`, pour être importé aussi
 * par le processus worker sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { ReceivablesOverdueJob } from './application/jobs/receivables-overdue-job.js';

@Module({
  providers: [ReceivablesOverdueJob],
})
export class SalesJobsModule {}

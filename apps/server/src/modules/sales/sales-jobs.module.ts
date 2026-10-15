/**
 * Tâches planifiées de `sales` (P4-09 : `sales.receivables.overdue_daily` ; P9-07 : passes de détection
 * d'alertes d'état et leurs récurrences). Module séparé de `SalesModule`, comme `FinanceJobsModule` : il
 * ne dépend que de `platform`, pour être importé aussi par le processus worker sans tirer les
 * gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { InactiveCommercialJob } from './application/jobs/inactive-commercial-job.js';
import { ReceivablesOverdueJob } from './application/jobs/receivables-overdue-job.js';
import { SalesRecurringJobs } from './application/jobs/sales-recurring-jobs.js';
import { UndeliveredSalesJob } from './application/jobs/undelivered-sales-job.js';

@Module({
  providers: [
    ReceivablesOverdueJob,
    UndeliveredSalesJob,
    InactiveCommercialJob,
    SalesRecurringJobs,
  ],
})
export class SalesJobsModule {}

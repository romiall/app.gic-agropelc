/**
 * Tâches planifiées de `production` et leur inscription à l'ordonnanceur (`ProductionRecurringJobs`,
 * P9-09) : `production.lots.daily_entry_check` et `production.products.standard_cost_check`. Module séparé
 * de `ProductionModule`, comme `FinanceJobsModule` : il ne dépend que de `platform`, pour être importé aussi
 * par le processus worker sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { DailyEntryMissingJob } from './application/jobs/daily-entry-missing-job.js';
import { ProductionRecurringJobs } from './application/jobs/production-recurring-jobs.js';
import { StandardCostMissingJob } from './application/jobs/standard-cost-missing-job.js';

@Module({
  providers: [DailyEntryMissingJob, StandardCostMissingJob, ProductionRecurringJobs],
})
export class ProductionJobsModule {}

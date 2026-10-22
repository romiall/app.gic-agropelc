/**
 * Tâches planifiées du module `analytics` (P9-20 : calcul des exports ; P9-22 : purges). Module séparé de
 * `AnalyticsModule`, comme `CommunicationJobsModule` : il ne dépend que de `platform` (global) pour être importé aussi
 * par le processus worker, qui exécute réellement les tâches, sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { AnalyticsJobs } from './application/jobs/analytics-jobs.js';

@Module({
  providers: [AnalyticsJobs],
})
export class AnalyticsJobsModule {}

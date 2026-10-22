/**
 * Tâche d'instantanés personnels d'indicateurs (P9-18) et son inscription à l'ordonnanceur. Dans la couche de
 * transport parce que le contenu d'un instantané se compose avec les fonctions de référence de plusieurs modules,
 * comme les tableaux (`dashboards/`). Module séparé de `AnalyticsApiModule`, comme `SyncJobsModule` : il ne dépend que
 * de `platform` (global) pour être importé aussi par le processus worker, sans `IdentityModule` ni contrôleur HTTP.
 */
import { Module } from '@nestjs/common';
import { KpiSnapshotsRefreshJob } from './jobs/kpi-snapshots-refresh-job.js';
import { SnapshotsRecurringJobs } from './jobs/snapshots-recurring-jobs.js';

@Module({
  providers: [KpiSnapshotsRefreshJob, SnapshotsRecurringJobs],
})
export class AnalyticsSnapshotsJobsModule {}

/**
 * Récurrence de la tâche d'instantanés personnels d'indicateurs (ordonnanceur `platform/jobs/job-scheduler.ts`,
 * P9-18) : toutes les 15 minutes (ADR-066 §5 : la fraîcheur d'un instantané se mesure à son « à jour au »).
 * Constante technique de planification, pas un seuil métier.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../platform/jobs/recurring-job-registry.provider.js';
import { KPI_SNAPSHOTS_REFRESH_JOB_TYPE } from './kpi-snapshots-refresh-job.js';

export const SNAPSHOTS_RECURRING_JOBS = [
  {
    jobType: KPI_SNAPSHOTS_REFRESH_JOB_TYPE,
    schedule: { kind: 'INTERVAL', intervalSeconds: 900 },
  },
] as const;

@Injectable()
export class SnapshotsRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of SNAPSHOTS_RECURRING_JOBS) this.recurring.register(job);
  }
}

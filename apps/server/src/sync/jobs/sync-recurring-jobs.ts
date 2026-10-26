/**
 * Récurrences des tâches d'alerte de la couche `sync` (ordonnanceur `platform/jobs/job-scheduler.ts`, P9-10) :
 * toutes les heures — D13 §7.1 « planifiée (horaire) » pour `SYNC_STALE`, les délais se comptent en heures
 * (`sync.stale_hours`, `sync.error_alert_window_hours`, `sync.seq_gap_alert_hours`, 24) et la passe rapproche
 * la levée et la fermeture des alertes d'état à moins d'une heure.
 * Constantes techniques de planification, pas des seuils métier.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../platform/jobs/recurring-job-registry.provider.js';
import { DEVICE_CLOCK_SKEW_JOB_TYPE } from './device-clock-skew-alert-job.js';
import { DEVICE_SEQ_GAP_JOB_TYPE } from './device-seq-gap-alert-job.js';
import { DEVICE_STALE_ALERT_JOB_TYPE } from './device-stale-alert-job.js';
import { SYNC_ERROR_ALERT_JOB_TYPE } from './sync-error-alert-job.js';

export const SYNC_RECURRING_JOBS = [
  { jobType: SYNC_ERROR_ALERT_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 3600 } },
  { jobType: DEVICE_STALE_ALERT_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 3600 } },
  { jobType: DEVICE_CLOCK_SKEW_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 3600 } },
  { jobType: DEVICE_SEQ_GAP_JOB_TYPE, schedule: { kind: 'INTERVAL', intervalSeconds: 3600 } },
] as const;

@Injectable()
export class SyncRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of SYNC_RECURRING_JOBS) this.recurring.register(job);
  }
}

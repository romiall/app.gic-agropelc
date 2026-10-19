/**
 * Tâches d'alerte de la couche `sync` et leur inscription à l'ordonnanceur (`SyncRecurringJobs`, P9-10) :
 * `sync.errors.alert_check`, `sync.devices.stale_check`, `sync.devices.clock_skew_check` et
 * `sync.devices.seq_gap_check`. Module séparé de `SyncModule`, comme `ChainVerificationModule` : il ne dépend
 * que de `platform`, pour être importé aussi par le processus worker (qui exécute réellement les tâches) sans
 * tirer le pipeline de commandes, `IdentityModule` ni aucun contrôleur HTTP.
 */
import { Module } from '@nestjs/common';
import { DeviceClockSkewAlertJob } from './jobs/device-clock-skew-alert-job.js';
import { DeviceSeqGapAlertJob } from './jobs/device-seq-gap-alert-job.js';
import { DeviceStaleAlertJob } from './jobs/device-stale-alert-job.js';
import { SyncErrorAlertJob } from './jobs/sync-error-alert-job.js';
import { SyncRecurringJobs } from './jobs/sync-recurring-jobs.js';

@Module({
  providers: [
    SyncErrorAlertJob,
    DeviceStaleAlertJob,
    DeviceClockSkewAlertJob,
    DeviceSeqGapAlertJob,
    SyncRecurringJobs,
  ],
})
export class SyncJobsModule {}

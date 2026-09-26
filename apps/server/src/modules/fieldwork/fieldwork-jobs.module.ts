/**
 * Tâches planifiées de `fieldwork` (`fieldwork.session.auto_close`, BR-TER-008). Module séparé,
 * dépendant de `platform` seulement, pour être importé aussi par le processus worker (même
 * précédent qu'`InventoryJobsModule`).
 */
import { Module } from '@nestjs/common';
import { SessionAutoCloseJob } from './application/jobs/session-auto-close-job.js';

@Module({
  providers: [SessionAutoCloseJob],
})
export class FieldworkJobsModule {}

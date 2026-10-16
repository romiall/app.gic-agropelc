/**
 * Tâches planifiées de `approvals` et leur inscription à l'ordonnanceur (`ApprovalsRecurringJobs`, P9-09) :
 * `approvals.requests.pending_long_check`. Module séparé de `ApprovalsModule`, comme `FinanceJobsModule` :
 * il ne dépend que de `platform`, pour être importé aussi par le processus worker sans tirer les
 * gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { ApprovalPendingLongJob } from './application/jobs/approval-pending-long-job.js';
import { ApprovalsRecurringJobs } from './application/jobs/approvals-recurring-jobs.js';

@Module({
  providers: [ApprovalPendingLongJob, ApprovalsRecurringJobs],
})
export class ApprovalsJobsModule {}

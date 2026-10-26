/**
 * Tâches planifiées de `procurement` et leur inscription à l'ordonnanceur (`ProcurementRecurringJobs`,
 * P9-09) : `procurement.orders.receipt_incomplete_check` et
 * `procurement.receipts.attachment_missing_check`. Module séparé de `ProcurementModule`, comme
 * `FinanceJobsModule` : il ne dépend que de `platform`, pour être importé aussi par le processus worker
 * sans tirer les gestionnaires de commande.
 */
import { Module } from '@nestjs/common';
import { ProcurementRecurringJobs } from './application/jobs/procurement-recurring-jobs.js';
import { ReceiptAttachmentMissingJob } from './application/jobs/receipt-attachment-missing-job.js';
import { ReceiptIncompleteJob } from './application/jobs/receipt-incomplete-job.js';

@Module({
  providers: [ReceiptIncompleteJob, ReceiptAttachmentMissingJob, ProcurementRecurringJobs],
})
export class ProcurementJobsModule {}

/**
 * Tâches planifiées et consommateurs d'événements d'`inventory` (P2-07 : `inventory.ledger.reconcile_daily` ;
 * P5-08 : `inventory.allocations.expiry_daily` et consommateur `inventory.allocation_revocation` ; P5-16 :
 * `inventory.transfers.unmatched_sweep` et l'inscription des trois tâches à l'ordonnanceur ; P9-08 :
 * `inventory.alerts.stock_threshold_sweep`, `inventory.alerts.transfer_not_received_check` et
 * `inventory.alerts.lot_expiring_daily`, détecteurs d'alertes de stock).
 * `approvals` est appelé par fonction (demande de validation d'un écart), sans module DI.
 * Module séparé d'`InventoryModule` (comme `ChainVerificationModule` pour `audit`) : il ne dépend que de
 * `platform`, pour être importé aussi par le processus worker (`worker.module.ts`) sans tirer
 * les gestionnaires de commande ni `ApprovalsModule` dans un processus qui ne les exécute pas.
 */
import { Module } from '@nestjs/common';
import { AllocationRevocationConsumerRegistrar } from './application/events/register-allocation-revocation-consumer.js';
import { AllocationExpiryJob } from './application/jobs/allocation-expiry-job.js';
import { LedgerReconciliationJob } from './application/jobs/ledger-reconciliation-job.js';
import { LotExpiringJob } from './application/jobs/lot-expiring-job.js';
import { StockThresholdSweepJob } from './application/jobs/stock-threshold-sweep-job.js';
import { TransferNotReceivedJob } from './application/jobs/transfer-not-received-job.js';
import { UnmatchedTransferSweepJob } from './application/jobs/unmatched-transfer-sweep-job.js';
import { InventoryRecurringJobs } from './application/jobs/inventory-recurring-jobs.js';

@Module({
  providers: [
    LedgerReconciliationJob,
    AllocationExpiryJob,
    AllocationRevocationConsumerRegistrar,
    UnmatchedTransferSweepJob,
    StockThresholdSweepJob,
    TransferNotReceivedJob,
    LotExpiringJob,
    InventoryRecurringJobs,
  ],
})
export class InventoryJobsModule {}

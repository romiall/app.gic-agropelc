/**
 * Tâches planifiées et consommateurs d'événements d'`inventory` (P2-07 : `inventory.ledger.reconcile_daily` ;
 * P5-08 : `inventory.allocations.expiry_daily` et consommateur `inventory.allocation_revocation`).
 * Module séparé d'`InventoryModule` (comme `ChainVerificationModule` pour `audit`) : il ne dépend que de
 * `platform`, pour être importé aussi par le processus worker (`worker.module.ts`) sans tirer
 * les gestionnaires de commande ni `ApprovalsModule` dans un processus qui ne les exécute pas.
 */
import { Module } from '@nestjs/common';
import { AllocationRevocationConsumerRegistrar } from './application/events/register-allocation-revocation-consumer.js';
import { AllocationExpiryJob } from './application/jobs/allocation-expiry-job.js';
import { LedgerReconciliationJob } from './application/jobs/ledger-reconciliation-job.js';

@Module({
  providers: [LedgerReconciliationJob, AllocationExpiryJob, AllocationRevocationConsumerRegistrar],
})
export class InventoryJobsModule {}

/**
 * Tâches planifiées d'`inventory` (P2-07 : `inventory.ledger.reconcile_daily`). Module séparé
 * d'`InventoryModule` (comme `ChainVerificationModule` pour `audit`) : il ne dépend que de
 * `platform`, pour être importé aussi par le processus worker (`worker.module.ts`) sans tirer
 * les gestionnaires de commande ni `ApprovalsModule` dans un processus qui ne les exécute pas.
 */
import { Module } from '@nestjs/common';
import { LedgerReconciliationJob } from './application/jobs/ledger-reconciliation-job.js';

@Module({
  providers: [LedgerReconciliationJob],
})
export class InventoryJobsModule {}

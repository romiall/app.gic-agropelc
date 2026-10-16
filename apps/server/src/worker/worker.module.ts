/**
 * Processus worker (P0-08 ; ADR-011 « un seul artefact, deux modes de démarrage : api,
 * worker ») : consomme `platform_domain_events` (consommateurs enregistrés) et
 * `platform_jobs` (SKIP LOCKED), aucune écoute HTTP. N'importe ni `IdentityModule` ni
 * `CommandsModule` : rien ne s'exécute côté worker qui en ait besoin — évite de tirer la
 * garde HTTP et les contrôleurs dans un processus qui n'écoute pas. `ChainVerificationModule`
 * (P0-07) n'a que `platform` comme dépendance (`audit --> platform`, N1) : c'est bien ce
 * processus qui réclame et exécute réellement `audit.chain.verify_daily`. Même raisonnement
 * pour `InventoryJobsModule` (P2-07, `inventory.ledger.reconcile_daily`), `FinanceJobsModule`
 * (P4-03, `finance.cash.reconcile_daily`), `SalesJobsModule` (P4-09,
 * `sales.receivables.overdue_daily`), `FieldworkJobsModule` (P3-03,
 * `fieldwork.session.auto_close`), `ProductionJobsModule` (P9-09, saisie du jour manquante, coût
 * standard manquant), `ProcurementJobsModule` (P9-09, réception incomplète, photo de réception) et
 * `ApprovalsJobsModule` (P9-09, validation en attente depuis longtemps).
 */
import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { ChainVerificationModule } from '../audit/chain-verification.module.js';
import { InventoryJobsModule } from '../modules/inventory/inventory-jobs.module.js';
import { FinanceJobsModule } from '../modules/finance/finance-jobs.module.js';
import { ProductionJobsModule } from '../modules/production/production-jobs.module.js';
import { ProcurementJobsModule } from '../modules/procurement/procurement-jobs.module.js';
import { ApprovalsJobsModule } from '../modules/approvals/approvals-jobs.module.js';
import { SalesJobsModule } from '../modules/sales/sales-jobs.module.js';
import { FieldworkJobsModule } from '../modules/fieldwork/fieldwork-jobs.module.js';
import { CommunicationJobsModule } from '../modules/communication/communication-jobs.module.js';
import { CommunicationRecipientsModule } from '../communication-api/communication-recipients.module.js';
import { WorkerService } from './worker.service.js';

@Module({
  imports: [
    PlatformModule,
    ChainVerificationModule,
    InventoryJobsModule,
    FinanceJobsModule,
    ProductionJobsModule,
    ProcurementJobsModule,
    ApprovalsJobsModule,
    SalesJobsModule,
    FieldworkJobsModule,
    CommunicationJobsModule,
    CommunicationRecipientsModule,
  ],
  providers: [WorkerService],
  exports: [WorkerService],
})
export class WorkerModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PlatformModule } from './platform/platform.module.js';
import { ApiErrorFilter } from './platform/http/api-error.filter.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { OrganizationModule } from './modules/organization/organization.module.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { PricingModule } from './modules/pricing/pricing.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { InventoryJobsModule } from './modules/inventory/inventory-jobs.module.js';
import { ProcurementModule } from './modules/procurement/procurement.module.js';
import { ProductionModule } from './modules/production/production.module.js';
import { FieldworkModule } from './modules/fieldwork/fieldwork.module.js';
import { FieldworkJobsModule } from './modules/fieldwork/fieldwork-jobs.module.js';
import { CrmModule } from './modules/crm/crm.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { ChainVerificationModule } from './audit/chain-verification.module.js';
import { AuditApiModule } from './audit-api/audit-api.module.js';
import { OrganizationApiModule } from './organization-api/organization-api.module.js';
import { AttachmentsApiModule } from './attachments-api/attachments-api.module.js';
import { CatalogApiModule } from './catalog-api/catalog-api.module.js';
import { PricingApiModule } from './pricing-api/pricing-api.module.js';
import { ProcurementApiModule } from './procurement-api/procurement-api.module.js';
import { ProductionApiModule } from './production-api/production-api.module.js';
import { InventoryApiModule } from './inventory-api/inventory-api.module.js';
import { CrmApiModule } from './crm-api/crm-api.module.js';
import { FieldworkApiModule } from './fieldwork-api/fieldwork-api.module.js';
import { SyncModule } from './sync/sync.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    PlatformModule,
    IdentityModule,
    OrganizationModule,
    AttachmentsModule,
    ApprovalsModule,
    CatalogModule,
    PricingModule,
    InventoryModule,
    InventoryJobsModule,
    ProcurementModule,
    ProductionModule,
    FieldworkModule,
    FieldworkJobsModule,
    CrmModule,
    CommandsModule,
    ChainVerificationModule,
    AuditApiModule,
    OrganizationApiModule,
    AttachmentsApiModule,
    CatalogApiModule,
    PricingApiModule,
    ProcurementApiModule,
    ProductionApiModule,
    InventoryApiModule,
    CrmApiModule,
    FieldworkApiModule,
    SyncModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}

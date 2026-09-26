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
import { ProcurementModule } from './modules/procurement/procurement.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { ChainVerificationModule } from './audit/chain-verification.module.js';
import { AuditApiModule } from './audit-api/audit-api.module.js';
import { OrganizationApiModule } from './organization-api/organization-api.module.js';
import { AttachmentsApiModule } from './attachments-api/attachments-api.module.js';
import { CatalogApiModule } from './catalog-api/catalog-api.module.js';
import { PricingApiModule } from './pricing-api/pricing-api.module.js';
import { ProcurementApiModule } from './procurement-api/procurement-api.module.js';
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
    ProcurementModule,
    CommandsModule,
    ChainVerificationModule,
    AuditApiModule,
    OrganizationApiModule,
    AttachmentsApiModule,
    CatalogApiModule,
    PricingApiModule,
    ProcurementApiModule,
    SyncModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}

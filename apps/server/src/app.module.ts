import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PlatformModule } from './platform/platform.module.js';
import { ApiErrorFilter } from './platform/http/api-error.filter.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { ChainVerificationModule } from './audit/chain-verification.module.js';
import { AuditApiModule } from './audit-api/audit-api.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    PlatformModule,
    IdentityModule,
    CommandsModule,
    ChainVerificationModule,
    AuditApiModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}

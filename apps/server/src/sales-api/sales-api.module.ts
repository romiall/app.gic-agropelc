/** Composition transport (comme `production-api/`) : rencontre de `sales`, `crm` et `identity`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { SalesReadController } from './sales-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [SalesReadController],
})
export class SalesApiModule {}

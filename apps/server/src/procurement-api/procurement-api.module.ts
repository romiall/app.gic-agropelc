/** Composition transport (comme `organization-api/`) : rencontre de `procurement` et `identity`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { SupplierReadController } from './supplier-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [SupplierReadController],
})
export class ProcurementApiModule {}

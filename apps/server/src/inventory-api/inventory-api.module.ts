/** Composition transport (comme `catalog-api/`) : rencontre d'`inventory`, `identity` et `audit`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { InventoryReadController } from './inventory-read.controller.js';
import { AllocationReadController } from './allocation-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [InventoryReadController, AllocationReadController],
})
export class InventoryApiModule {}

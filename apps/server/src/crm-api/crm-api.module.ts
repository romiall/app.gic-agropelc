/** Composition transport (comme `inventory-api/`) : rencontre de `crm`, `identity` et `audit`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { CrmReadController } from './crm-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [CrmReadController],
})
export class CrmApiModule {}

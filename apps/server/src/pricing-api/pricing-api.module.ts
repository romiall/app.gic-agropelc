/** Composition transport (comme `organization-api/`) : rencontre de `pricing` et `identity`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { PricingReadController } from './pricing-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [PricingReadController],
})
export class PricingApiModule {}

import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PricingCommandsRegistrar } from './application/commands/register-pricing-commands.js';
import { PricingReadController } from './api/pricing-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [PricingReadController],
  providers: [PricingCommandsRegistrar],
})
export class PricingModule {}

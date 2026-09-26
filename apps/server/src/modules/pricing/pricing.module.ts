import { Module } from '@nestjs/common';
import { PricingCommandsRegistrar } from './application/commands/register-pricing-commands.js';

@Module({
  providers: [PricingCommandsRegistrar],
})
export class PricingModule {}

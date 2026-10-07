/** Composition transport (comme `production-api/`) : rencontre de `finance` et `identity`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { FinanceReadController } from './finance-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [FinanceReadController],
})
export class FinanceApiModule {}

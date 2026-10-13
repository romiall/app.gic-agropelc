/** Composition transport (comme `production-api/`) : rencontre de `finance` et `identity`. */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { FinanceReadController } from './finance-read.controller.js';
import { CashOperationsReadController } from './cash-operations-read.controller.js';
import { FinanceOperationsReadController } from './finance-operations-read.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [
    FinanceReadController,
    CashOperationsReadController,
    FinanceOperationsReadController,
  ],
})
export class FinanceApiModule {}

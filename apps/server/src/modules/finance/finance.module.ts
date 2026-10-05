/**
 * Module `finance` (D09-FIN) : trésorerie (P4-03) — comptes, mouvements, solde. Les dépenses, les
 * dettes fournisseurs et les sessions de caisse arrivent avec P5 et P8.
 */
import { Module } from '@nestjs/common';
import { FinanceCommandsRegistrar } from './application/commands/register-finance-commands.js';

@Module({
  providers: [FinanceCommandsRegistrar],
})
export class FinanceModule {}

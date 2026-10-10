/**
 * Module `finance` (D09-FIN) : trésorerie (P4-03) — comptes, mouvements, solde ; remises de fonds
 * (P5-15). `ApprovalsModule` fournit le registre des décisions (`CASH_TRANSFER_DISCREPANCY`). Les
 * dépenses, les dettes fournisseurs et les sessions de caisse arrivent avec P5 et P8.
 */
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { FinanceCommandsRegistrar } from './application/commands/register-finance-commands.js';

@Module({
  imports: [ApprovalsModule],
  providers: [FinanceCommandsRegistrar],
})
export class FinanceModule {}

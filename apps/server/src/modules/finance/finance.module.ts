/**
 * Module `finance` (D09-FIN) : trésorerie (P4-03) — comptes, mouvements, solde ; sessions de caisse
 * (P5-12 : ouverture, clôture, clôture forcée, garde de désactivation d'un emplacement de vente) ;
 * remises de fonds (P5-15). `ApprovalsModule` fournit le registre des décisions
 * (`CASH_TRANSFER_DISCREPANCY`). Les dépenses et les dettes fournisseurs arrivent avec P8.
 */
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { FinanceCommandsRegistrar } from './application/commands/register-finance-commands.js';
import { CashSessionCommandsRegistrar } from './application/commands/register-cash-session-commands.js';

@Module({
  // `OrganizationModule` : registre des gardes de désactivation d'un emplacement (P5-12,
  // LOCATION_HAS_OPEN_CASH_SESSION), comme `inventory` (P5-05). `ApprovalsModule` : registre des
  // décisions (P5-15, CASH_TRANSFER_DISCREPANCY).
  imports: [OrganizationModule, ApprovalsModule],
  providers: [FinanceCommandsRegistrar, CashSessionCommandsRegistrar],
})
export class FinanceModule {}

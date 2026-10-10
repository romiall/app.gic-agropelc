/**
 * Module `finance` (D09-FIN) : trésorerie (P4-03) — comptes, mouvements, solde ; sessions de caisse
 * (P5-12 : ouverture, clôture, clôture forcée, garde de désactivation d'un emplacement de vente). Les
 * remises de fonds, les dépenses et les dettes fournisseurs arrivent avec P5 et P8.
 */
import { Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import { FinanceCommandsRegistrar } from './application/commands/register-finance-commands.js';
import { CashSessionCommandsRegistrar } from './application/commands/register-cash-session-commands.js';

@Module({
  // `OrganizationModule` : registre des gardes de désactivation d'un emplacement (P5-12,
  // LOCATION_HAS_OPEN_CASH_SESSION), comme `inventory` (P5-05).
  imports: [OrganizationModule],
  providers: [FinanceCommandsRegistrar, CashSessionCommandsRegistrar],
})
export class FinanceModule {}

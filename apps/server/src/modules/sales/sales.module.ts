/**
 * Module `sales` (D04-VEN) : ventes directes (P4-04), annulations (P4-05) ; commandes, livraisons et
 * encaissements suivent (P4-06 à P4-08). Dépend, selon le graphe, d'`identity`, `organization`,
 * `catalog`, `approvals`, `crm`, `fieldwork`, `pricing`, `inventory` et `finance` : leurs API
 * publiques sont importées directement ; `ApprovalsModule` fournit le registre des décisions
 * (`SALE_CANCELLATION`…).
 */
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { SalesCommandsRegistrar } from './application/commands/register-sales-commands.js';

@Module({
  imports: [ApprovalsModule],
  providers: [SalesCommandsRegistrar],
})
export class SalesModule {}

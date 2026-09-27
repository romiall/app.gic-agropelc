/**
 * Module `procurement` (D08-APP) : fournisseurs (P1-05), demandes d'achat, bons de commande et
 * réceptions (P6). `ApprovalsModule` : registre des décisions (`PURCHASE_REQUEST`…), déjà
 * autorisé par le graphe (`procurement` → `approvals`).
 */
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { ProcurementCommandsRegistrar } from './application/commands/register-procurement-commands.js';

@Module({
  imports: [ApprovalsModule],
  providers: [ProcurementCommandsRegistrar],
})
export class ProcurementModule {}

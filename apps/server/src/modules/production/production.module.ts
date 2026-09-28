/**
 * Module `production` (D07-PRD ; P7) : lots de production et leurs entrées (P7-05), saisies du
 * jour, collectes d'œufs, incubation, abattage et répartition des frais généraux (P7-06 à
 * P7-10). `ApprovalsModule` : registre des décisions, autorisé par le graphe
 * (`production` → `approvals`).
 */
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { ProductionCommandsRegistrar } from './application/commands/register-production-commands.js';

@Module({
  imports: [ApprovalsModule],
  providers: [ProductionCommandsRegistrar],
})
export class ProductionModule {}

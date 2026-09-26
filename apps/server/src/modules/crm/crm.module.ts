/**
 * Module `crm` (D02-CRM) : comptes clients, portefeuille, pipeline (P3-04) ; visites,
 * interactions et objectifs (P3-05). Importe `FieldworkModule` pour s'enregistrer auprès de son
 * registre de réactions au rejet d'une dérogation (`SESSION_REJECTED_LISTENERS`).
 */
import { Module } from '@nestjs/common';
import { FieldworkModule } from '../fieldwork/fieldwork.module.js';
import { CrmCommandsRegistrar } from './application/commands/register-crm-commands.js';
import { CrmSessionRejectionRegistrar } from './application/reactions/session-rejection.js';

@Module({
  imports: [FieldworkModule],
  providers: [CrmCommandsRegistrar, CrmSessionRejectionRegistrar],
})
export class CrmModule {}

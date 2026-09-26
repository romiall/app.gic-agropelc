/**
 * Module `crm` (D02-CRM) : comptes clients, portefeuille, pipeline (P3-04) ; visites,
 * interactions et objectifs (P3-05).
 */
import { Module } from '@nestjs/common';
import { CrmCommandsRegistrar } from './application/commands/register-crm-commands.js';

@Module({
  providers: [CrmCommandsRegistrar],
})
export class CrmModule {}

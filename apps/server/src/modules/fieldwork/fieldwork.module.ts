/**
 * Module `fieldwork` (D03-TER). Fournit et exporte le registre des réactions au rejet d'une
 * dérogation (`SESSION_REJECTED_LISTENERS`) : `crm` (puis `sales`) importe ce module pour s'y
 * enregistrer — une seule instance, les modules NestJS étant des singletons.
 */
import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { FieldworkCommandsRegistrar } from './application/commands/register-fieldwork-commands.js';
import {
  SESSION_REJECTED_LISTENERS,
  SessionRejectedListenerRegistry,
} from './application/session-rejection.js';

@Module({
  imports: [ApprovalsModule],
  providers: [
    { provide: SESSION_REJECTED_LISTENERS, useValue: new SessionRejectedListenerRegistry() },
    FieldworkCommandsRegistrar,
  ],
  exports: [SESSION_REJECTED_LISTENERS],
})
export class FieldworkModule {}

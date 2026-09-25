import { Module } from '@nestjs/common';
import { ApprovalsCommandsRegistrar } from './application/commands/register-approvals-commands.js';
import {
  approvalDecisionHandlerRegistryProvider,
  APPROVAL_DECISION_HANDLER_REGISTRY,
} from './application/decision-handler-registry.provider.js';

@Module({
  providers: [approvalDecisionHandlerRegistryProvider, ApprovalsCommandsRegistrar],
  // Exporté pour le futur module propriétaire (inventory, P2+) qui enregistrera son
  // gestionnaire de décision — `imports: [ApprovalsModule]` alors nécessaire côté NestJS,
  // en plus de l'import de code déjà autorisé par le graphe (.dependency-cruiser.cjs).
  exports: [APPROVAL_DECISION_HANDLER_REGISTRY],
})
export class ApprovalsModule {}

/**
 * Enregistrement des gestionnaires de commande `approvals` au démarrage (même inversion de
 * dépendance que `OrganizationCommandsRegistrar`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { APPROVAL_DECISION_HANDLER_REGISTRY } from '../decision-handler-registry.provider.js';
import type { ApprovalDecisionHandlerRegistry } from '../decision-handler-registry.js';
import { registerPolicyCommands } from './policy-commands.js';
import { registerRequestCommands } from './request-commands.js';

@Injectable()
export class ApprovalsCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(APPROVAL_DECISION_HANDLER_REGISTRY)
    private readonly decisionRegistry: ApprovalDecisionHandlerRegistry,
  ) {}

  onModuleInit(): void {
    registerPolicyCommands(this.registry);
    registerRequestCommands(this.registry, this.decisionRegistry);
  }
}

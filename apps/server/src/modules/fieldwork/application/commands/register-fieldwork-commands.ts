/**
 * Enregistrement des gestionnaires de commande `fieldwork` au démarrage (même précédent que
 * `InventoryCommandsRegistrar`). Injections explicites (`@Inject`) : vitest/esbuild n'émet pas
 * de métadonnées de décorateur (leçon de P2-05).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { CLOCK } from '../../../../platform/clock.provider.js';
import {
  APPROVAL_DECISION_HANDLER_REGISTRY,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import {
  SESSION_REJECTED_LISTENERS,
  type SessionRejectedListenerRegistry,
} from '../session-rejection.js';
import { registerCheckinCommands } from './checkin-commands.js';

@Injectable()
export class FieldworkCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(APPROVAL_DECISION_HANDLER_REGISTRY)
    private readonly decisionRegistry: ApprovalDecisionHandlerRegistry,
    @Inject(SESSION_REJECTED_LISTENERS)
    private readonly listeners: SessionRejectedListenerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    registerCheckinCommands(
      this.registry,
      this.decisionRegistry,
      this.listeners,
      this.idGenerator,
      this.clock,
    );
  }
}

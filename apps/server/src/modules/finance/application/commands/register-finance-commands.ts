/**
 * Enregistrement des gestionnaires de commande `finance` au démarrage (même inversion de
 * dépendance que `OrganizationCommandsRegistrar`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { registerAccountCommands } from './account-commands.js';

@Injectable()
export class FinanceCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
  ) {}

  onModuleInit(): void {
    registerAccountCommands(this.registry);
  }
}

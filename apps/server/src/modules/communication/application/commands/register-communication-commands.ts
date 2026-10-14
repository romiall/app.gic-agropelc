/**
 * Enregistrement des gestionnaires de commande `communication` au démarrage (même inversion de
 * dépendance que `ApprovalsCommandsRegistrar`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { registerAlertCommands } from './alert-commands.js';

@Injectable()
export class CommunicationCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  onModuleInit(): void {
    registerAlertCommands(this.registry, this.idGenerator);
  }
}

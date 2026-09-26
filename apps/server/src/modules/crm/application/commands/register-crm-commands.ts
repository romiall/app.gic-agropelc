/**
 * Enregistrement des gestionnaires de commande `crm` au démarrage (même précédent que
 * `FieldworkCommandsRegistrar`). Injections explicites (`@Inject`) : vitest/esbuild n'émet pas
 * de métadonnées de décorateur (leçon de P2-05).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { registerCustomerCommands } from './customer-commands.js';
import { registerPipelineCommands } from './pipeline-commands.js';

@Injectable()
export class CrmCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  onModuleInit(): void {
    registerCustomerCommands(this.registry, this.idGenerator);
    registerPipelineCommands(this.registry);
  }
}

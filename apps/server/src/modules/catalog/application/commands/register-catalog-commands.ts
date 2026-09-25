/** Enregistrement des gestionnaires de commande `catalog` au démarrage (même schéma que
 * `OrganizationCommandsRegistrar`, `identity/application/commands/register-identity-
 * commands.ts`). */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { registerReferenceCommands } from './reference-commands.js';
import { registerProductCommands } from './product-commands.js';

@Injectable()
export class CatalogCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
  ) {}

  onModuleInit(): void {
    registerReferenceCommands(this.registry);
    registerProductCommands(this.registry);
  }
}

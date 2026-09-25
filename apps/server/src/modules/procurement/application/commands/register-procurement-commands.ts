/** Enregistrement des gestionnaires de commande `procurement` au démarrage. */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { registerSupplierCommands } from './supplier-commands.js';

@Injectable()
export class ProcurementCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
  ) {}

  onModuleInit(): void {
    registerSupplierCommands(this.registry);
  }
}

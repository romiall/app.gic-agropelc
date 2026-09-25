/**
 * Enregistrement des gestionnaires de commande `identity` au démarrage (inversion de
 * dépendance : le registre est un noyau `platform` qui ne connaît aucun module métier
 * d'avance, 05-architecture/03-graphe-dependances.md note 2).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { registerDeviceCommands } from './device-commands.js';
import { registerUserCommands } from './user-commands.js';

@Injectable()
export class IdentityCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
  ) {}

  onModuleInit(): void {
    registerDeviceCommands(this.registry);
    registerUserCommands(this.registry);
  }
}

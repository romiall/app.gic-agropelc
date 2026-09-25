/**
 * Enregistrement des gestionnaires de commande `organization` au démarrage (même inversion
 * de dépendance que `IdentityCommandsRegistrar`, identity/application/commands/register-
 * identity-commands.ts).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { registerZoneCommands } from './zone-commands.js';
import { registerSiteCommands } from './site-commands.js';
import { registerPosCommands } from './pos-commands.js';
import { registerLocationCommands } from './location-commands.js';
import { registerTeamCommands } from './team-commands.js';
import { registerSettingCommands } from './setting-commands.js';

@Injectable()
export class OrganizationCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
  ) {}

  onModuleInit(): void {
    registerZoneCommands(this.registry);
    registerSiteCommands(this.registry);
    registerPosCommands(this.registry);
    registerLocationCommands(this.registry);
    registerTeamCommands(this.registry);
    registerSettingCommands(this.registry);
  }
}

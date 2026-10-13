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
import { LOCATION_DEACTIVATION_GUARD_REGISTRY } from '../deactivation-guard-registry.provider.js';
import type { LocationDeactivationGuardRegistry } from '../deactivation-guard-registry.js';
import { POS_CONFIGURATION_GUARD_REGISTRY } from '../pos-configuration-guard-registry.provider.js';
import type { PosConfigurationGuardRegistry } from '../pos-configuration-guard-registry.js';
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
    @Inject(LOCATION_DEACTIVATION_GUARD_REGISTRY)
    private readonly deactivationGuards: LocationDeactivationGuardRegistry,
    @Inject(POS_CONFIGURATION_GUARD_REGISTRY)
    private readonly posGuards: PosConfigurationGuardRegistry,
  ) {}

  onModuleInit(): void {
    registerZoneCommands(this.registry);
    registerSiteCommands(this.registry, this.deactivationGuards);
    registerPosCommands(this.registry, this.posGuards);
    registerLocationCommands(this.registry, this.deactivationGuards);
    registerTeamCommands(this.registry);
    registerSettingCommands(this.registry);
  }
}

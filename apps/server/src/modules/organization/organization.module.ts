import { Module } from '@nestjs/common';
import { OrganizationCommandsRegistrar } from './application/commands/register-organization-commands.js';
import {
  LOCATION_DEACTIVATION_GUARD_REGISTRY,
  locationDeactivationGuardRegistryProvider,
} from './application/deactivation-guard-registry.provider.js';
import {
  POS_CONFIGURATION_GUARD_REGISTRY,
  posConfigurationGuardRegistryProvider,
} from './application/pos-configuration-guard-registry.provider.js';

@Module({
  providers: [
    locationDeactivationGuardRegistryProvider,
    posConfigurationGuardRegistryProvider,
    OrganizationCommandsRegistrar,
  ],
  // Exportés : `inventory` (et plus tard d'autres modules) y enregistre ses gardes de désactivation d'un
  // emplacement (INV-STK-07) et de configuration d'un PDV (AV-230) — `imports: [OrganizationModule]`.
  exports: [LOCATION_DEACTIVATION_GUARD_REGISTRY, POS_CONFIGURATION_GUARD_REGISTRY],
})
export class OrganizationModule {}

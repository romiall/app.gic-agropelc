import { Module } from '@nestjs/common';
import { OrganizationCommandsRegistrar } from './application/commands/register-organization-commands.js';
import {
  LOCATION_DEACTIVATION_GUARD_REGISTRY,
  locationDeactivationGuardRegistryProvider,
} from './application/deactivation-guard-registry.provider.js';

@Module({
  providers: [locationDeactivationGuardRegistryProvider, OrganizationCommandsRegistrar],
  // Exporté : `inventory` (et plus tard d'autres modules) y enregistre ses gardes de désactivation d'un
  // emplacement (INV-STK-07) — `imports: [OrganizationModule]` côté câblage NestJS.
  exports: [LOCATION_DEACTIVATION_GUARD_REGISTRY],
})
export class OrganizationModule {}

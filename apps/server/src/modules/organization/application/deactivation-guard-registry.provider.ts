import type { Provider } from '@nestjs/common';
import { LocationDeactivationGuardRegistry } from './deactivation-guard-registry.js';

export const LOCATION_DEACTIVATION_GUARD_REGISTRY = Symbol('LOCATION_DEACTIVATION_GUARD_REGISTRY');

export const locationDeactivationGuardRegistryProvider: Provider = {
  provide: LOCATION_DEACTIVATION_GUARD_REGISTRY,
  useValue: new LocationDeactivationGuardRegistry(),
};

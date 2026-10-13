import type { Provider } from '@nestjs/common';
import { PosConfigurationGuardRegistry } from './pos-configuration-guard-registry.js';

export const POS_CONFIGURATION_GUARD_REGISTRY = Symbol('POS_CONFIGURATION_GUARD_REGISTRY');

export const posConfigurationGuardRegistryProvider: Provider = {
  provide: POS_CONFIGURATION_GUARD_REGISTRY,
  useValue: new PosConfigurationGuardRegistry(),
};

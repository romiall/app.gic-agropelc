import type { Provider } from '@nestjs/common';
import { JobHandlerRegistry } from './job-handler-registry.js';

export { JobHandlerRegistry } from './job-handler-registry.js';
export const JOB_HANDLER_REGISTRY = Symbol('JOB_HANDLER_REGISTRY');

/** Registre unique par processus : chaque module métier s'y enregistre au démarrage. */
export const jobHandlerRegistryProvider: Provider = {
  provide: JOB_HANDLER_REGISTRY,
  useValue: new JobHandlerRegistry(),
};

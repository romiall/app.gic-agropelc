import type { Provider } from '@nestjs/common';
import { RecurringJobRegistry } from './recurring-job-registry.js';

export { RecurringJobRegistry } from './recurring-job-registry.js';
export type { RecurringJob, RecurringSchedule } from './recurring-job-registry.js';
export const RECURRING_JOB_REGISTRY = Symbol('RECURRING_JOB_REGISTRY');

/** Registre unique par processus : chaque module y inscrit ses récurrences au démarrage. */
export const recurringJobRegistryProvider: Provider = {
  provide: RECURRING_JOB_REGISTRY,
  useValue: new RecurringJobRegistry(),
};

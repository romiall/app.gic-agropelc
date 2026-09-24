import type { Provider } from '@nestjs/common';
import { EventConsumerRegistry } from './event-consumer-registry.js';

export { EventConsumerRegistry } from './event-consumer-registry.js';
export const EVENT_CONSUMER_REGISTRY = Symbol('EVENT_CONSUMER_REGISTRY');

export const eventConsumerRegistryProvider: Provider = {
  provide: EVENT_CONSUMER_REGISTRY,
  useValue: new EventConsumerRegistry(),
};

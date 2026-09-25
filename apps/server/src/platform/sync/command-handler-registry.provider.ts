import type { Provider } from '@nestjs/common';
import { CommandHandlerRegistry } from './command-handler-registry.js';

export { CommandHandlerRegistry } from './command-handler-registry.js';
export const COMMAND_HANDLER_REGISTRY = Symbol('COMMAND_HANDLER_REGISTRY');

/** Registre unique par processus : chaque module métier s'y enregistre au démarrage. */
export const commandHandlerRegistryProvider: Provider = {
  provide: COMMAND_HANDLER_REGISTRY,
  useValue: new CommandHandlerRegistry(),
};

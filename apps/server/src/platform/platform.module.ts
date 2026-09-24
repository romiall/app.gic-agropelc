/**
 * Noyau technique partagé (N0, 03-graphe-dependances.md) : horloge, générateur
 * d'identifiants, configuration, connexion base, registre de commandes. `@Global()` — tout
 * module métier en dispose sans avoir à l'importer explicitement (comme documenté :
 * « platform et audit sont omis du graphe... tout module métier en dispose »).
 */
import { Global, Module } from '@nestjs/common';
import { clockProvider, CLOCK } from './clock.provider.js';
import { idGeneratorProvider, ID_GENERATOR } from './id-generator.provider.js';
import { envProvider, ENV } from './env.provider.js';
import { databaseProviders, DATABASE } from './kysely/database.provider.js';
import {
  commandHandlerRegistryProvider,
  COMMAND_HANDLER_REGISTRY,
} from './sync/command-handler-registry.provider.js';

@Global()
@Module({
  providers: [
    clockProvider,
    idGeneratorProvider,
    envProvider,
    ...databaseProviders,
    commandHandlerRegistryProvider,
  ],
  exports: [CLOCK, ID_GENERATOR, ENV, DATABASE, COMMAND_HANDLER_REGISTRY],
})
export class PlatformModule {}

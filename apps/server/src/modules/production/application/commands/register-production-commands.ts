/**
 * Enregistrement des gestionnaires de commande `production` au démarrage (même précédent que
 * `ProcurementCommandsRegistrar`) : lots et entrées (P7-05), saisie du jour (P7-06), collectes d'œufs
 * (P7-07). Injections explicites (`@Inject`) :
 * vitest/esbuild n'émet pas de métadonnées de décorateur (P2-05).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { registerLotCommands } from './lot-commands.js';
import { registerDailyCommands } from './daily-commands.js';
import { registerEggCollectionCommands } from './egg-collection-commands.js';

@Injectable()
export class ProductionCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(DocumentSequenceService) private readonly documentSequences: DocumentSequenceService,
  ) {}

  onModuleInit(): void {
    registerLotCommands(this.registry, this.idGenerator, this.documentSequences);
    registerDailyCommands(this.registry, this.idGenerator, this.documentSequences);
    registerEggCollectionCommands(this.registry, this.idGenerator, this.documentSequences);
  }
}

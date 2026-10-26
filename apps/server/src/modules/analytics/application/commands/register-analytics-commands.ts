/**
 * Enregistrement des gestionnaires de commande `analytics` au démarrage (P9-19, P9-20 ; même inversion de
 * dépendance que `CommunicationCommandsRegistrar`) : vues sauvegardées et demande d'export.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { JobsService } from '../../../../platform/jobs/jobs.service.js';
import { registerExportCommands } from './export-commands.js';
import { registerViewCommands } from './view-commands.js';

@Injectable()
export class AnalyticsCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    registerViewCommands(this.registry, { idGenerator: this.idGenerator, clock: this.clock });
    registerExportCommands(this.registry, {
      idGenerator: this.idGenerator,
      clock: this.clock,
      jobs: this.jobs,
    });
  }
}

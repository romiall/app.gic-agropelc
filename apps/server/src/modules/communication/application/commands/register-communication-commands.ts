/**
 * Enregistrement des gestionnaires de commande `communication` au démarrage (même inversion de
 * dépendance que `ApprovalsCommandsRegistrar`).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  NOTE_AUDIENCE_RESOLVER,
  type NoteAudienceResolver,
} from '../notes/note-audience-resolver.js';
import { registerAlertCommands } from './alert-commands.js';
import { registerNoteCommands } from './note-commands.js';
import { registerNotificationCommands } from './notification-commands.js';

@Injectable()
export class CommunicationCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(NOTE_AUDIENCE_RESOLVER) private readonly noteAudience: NoteAudienceResolver,
  ) {}

  onModuleInit(): void {
    registerAlertCommands(this.registry, this.idGenerator);
    registerNotificationCommands(this.registry, this.idGenerator);
    registerNoteCommands(this.registry, {
      idGenerator: this.idGenerator,
      clock: this.clock,
      audience: this.noteAudience,
    });
  }
}

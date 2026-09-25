/**
 * Enregistrement des gestionnaires de commande `attachments` au démarrage (même inversion de
 * dépendance que `OrganizationCommandsRegistrar`, organization/application/commands/
 * register-organization-commands.ts).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { registerAttachmentCommands } from './attachment-commands.js';

@Injectable()
export class AttachmentsCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
  ) {}

  onModuleInit(): void {
    registerAttachmentCommands(this.registry);
  }
}

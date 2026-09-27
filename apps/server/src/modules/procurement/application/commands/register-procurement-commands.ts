/**
 * Enregistrement des gestionnaires de commande `procurement` au démarrage (même précédent que
 * `InventoryCommandsRegistrar`) : fournisseurs (P1-05), demandes d'achat (P6-03). Injections
 * explicites (`@Inject`) : vitest/esbuild n'émet pas de métadonnées de décorateur (P2-05).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  APPROVAL_DECISION_HANDLER_REGISTRY,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { registerSupplierCommands } from './supplier-commands.js';
import { registerRequestCommands } from './request-commands.js';

@Injectable()
export class ProcurementCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(APPROVAL_DECISION_HANDLER_REGISTRY)
    private readonly decisionRegistry: ApprovalDecisionHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(DocumentSequenceService) private readonly documentSequences: DocumentSequenceService,
  ) {}

  onModuleInit(): void {
    registerSupplierCommands(this.registry);
    registerRequestCommands(
      this.registry,
      this.decisionRegistry,
      this.idGenerator,
      this.documentSequences,
    );
  }
}

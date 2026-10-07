/**
 * Enregistrement des gestionnaires de commande `sales` au démarrage (même précédent que
 * `ProcurementCommandsRegistrar`) : ventes directes (P4-04), annulations de ventes (P4-05), commandes (P4-06), livraisons (P4-07), encaissements (P4-08).
 * Injections explicites (`@Inject`) : vitest/esbuild n'émet pas de métadonnées de décorateur (P2-05).
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
import { registerSaleCommands } from './sale-commands.js';
import { registerCancelCommands } from './cancel-commands.js';
import { registerOrderCommands } from './order-commands.js';
import { registerDeliveryCommands } from './delivery-commands.js';
import { registerPaymentCommands } from './payment-commands.js';

@Injectable()
export class SalesCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(APPROVAL_DECISION_HANDLER_REGISTRY)
    private readonly decisionRegistry: ApprovalDecisionHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(DocumentSequenceService) private readonly documentSequences: DocumentSequenceService,
  ) {}

  onModuleInit(): void {
    registerSaleCommands(this.registry, this.idGenerator, this.documentSequences);
    registerCancelCommands(
      this.registry,
      this.decisionRegistry,
      this.idGenerator,
      this.documentSequences,
    );
    registerOrderCommands(this.registry, this.idGenerator, this.documentSequences);
    registerDeliveryCommands(this.registry, this.idGenerator, this.documentSequences);
    registerPaymentCommands(
      this.registry,
      this.decisionRegistry,
      this.idGenerator,
      this.documentSequences,
    );
  }
}

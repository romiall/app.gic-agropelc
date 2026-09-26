/**
 * Enregistrement des gestionnaires de commande `inventory` au démarrage (même précédent
 * que `ApprovalsCommandsRegistrar`/`ProcurementCommandsRegistrar`). Contrairement à ces
 * deux-là, `inventory` a aussi besoin de `ID_GENERATOR` et `DocumentSequenceService`
 * (numérotation `TRF`/`PRT`, `document-sequence.service.ts`) en plus du registre de
 * décisions d'approbation (`TRANSFER_DISCREPANCY`, `LOSS_DECLARATION`, P2-04).
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
import { registerTransferCommands } from './transfer-commands.js';
import { registerLossCommands } from './loss-commands.js';
import { registerConsumptionCommands } from './consumption-commands.js';

@Injectable()
export class InventoryCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(APPROVAL_DECISION_HANDLER_REGISTRY)
    private readonly decisionRegistry: ApprovalDecisionHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly documentSequences: DocumentSequenceService,
  ) {}

  onModuleInit(): void {
    registerTransferCommands(
      this.registry,
      this.decisionRegistry,
      this.idGenerator,
      this.documentSequences,
    );
    registerLossCommands(
      this.registry,
      this.decisionRegistry,
      this.idGenerator,
      this.documentSequences,
    );
    registerConsumptionCommands(this.registry, this.idGenerator);
  }
}

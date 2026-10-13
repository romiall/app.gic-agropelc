/**
 * Enregistrement des gestionnaires de commande `finance` au démarrage (même inversion de
 * dépendance que `OrganizationCommandsRegistrar`) : comptes (P4-03), remises de fonds et décision
 * `CASH_TRANSFER_DISCREPANCY` (P5-15), catégories de dépense (P8-04). Injections explicites (`@Inject`) : vitest/esbuild n'émet pas
 * de métadonnées de décorateur (P2-05).
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
import { registerAccountCommands } from './account-commands.js';
import { registerCashTransferCommands } from './cash-transfer-commands.js';
import { registerExpenseCategoryCommands } from './expense-category-commands.js';

@Injectable()
export class FinanceCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(APPROVAL_DECISION_HANDLER_REGISTRY)
    private readonly decisionRegistry: ApprovalDecisionHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(DocumentSequenceService) private readonly documentSequences: DocumentSequenceService,
  ) {}

  onModuleInit(): void {
    registerAccountCommands(this.registry);
    registerExpenseCategoryCommands(this.registry);
    registerCashTransferCommands(
      this.registry,
      this.decisionRegistry,
      this.idGenerator,
      this.documentSequences,
    );
  }
}

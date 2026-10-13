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
import {
  LOCATION_DEACTIVATION_GUARD_REGISTRY,
  POS_CONFIGURATION_GUARD_REGISTRY,
  type LocationDeactivationGuardRegistry,
  type PosConfigurationGuardRegistry,
} from '../../../organization/application/public/index.js';
import { inventoryLocationDeactivationGuard } from '../location-deactivation-guard.js';
import { inventoryPosConfigurationGuard } from '../pos-configuration-guard.js';
import { registerTransferCommands } from './transfer-commands.js';
import { registerLossCommands } from './loss-commands.js';
import { registerConsumptionCommands } from './consumption-commands.js';
import { registerThresholdCommands } from './threshold-commands.js';
import { registerCountCommands } from './count-commands.js';
import { registerOverheadCommands } from './overhead-commands.js';
import { registerAllocationCommands } from './allocation-commands.js';

@Injectable()
export class InventoryCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(APPROVAL_DECISION_HANDLER_REGISTRY)
    private readonly decisionRegistry: ApprovalDecisionHandlerRegistry,
    @Inject(LOCATION_DEACTIVATION_GUARD_REGISTRY)
    private readonly deactivationGuards: LocationDeactivationGuardRegistry,
    @Inject(POS_CONFIGURATION_GUARD_REGISTRY)
    private readonly posGuards: PosConfigurationGuardRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    // `@Inject` explicite (comme sync.controller.ts) : sous vitest (esbuild), aucune
    // métadonnée de décorateur n'est émise — une injection par le seul type laissait
    // `documentSequences` à `undefined` dans l'application Nest réelle (révélé par
    // inventory-read.e2e.test.ts, P2-05 ; les tests P2-04 construisaient le registre à la main).
    @Inject(DocumentSequenceService) private readonly documentSequences: DocumentSequenceService,
  ) {}

  onModuleInit(): void {
    this.deactivationGuards.register('inventory', inventoryLocationDeactivationGuard);
    // P5-23 (AV-230) : pas de passage en garde exclusive d'un emplacement qui porte un quota actif.
    this.posGuards.register('inventory', inventoryPosConfigurationGuard);
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
    registerThresholdCommands(this.registry);
    registerAllocationCommands(this.registry, this.idGenerator);
    registerOverheadCommands(this.registry, this.idGenerator);
    registerCountCommands(
      this.registry,
      this.decisionRegistry,
      this.idGenerator,
      this.documentSequences,
    );
  }
}

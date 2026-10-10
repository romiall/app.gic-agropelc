/**
 * Enregistrement des commandes de session de caisse (P5-12) et de la garde de désactivation
 * d'emplacement de `finance` (LOCATION_HAS_OPEN_CASH_SESSION) au démarrage. Registrar distinct de
 * `FinanceCommandsRegistrar` : les sessions ont besoin de `ID_GENERATOR` et du registre des gardes
 * d'`organization`, que les commandes de comptes n'utilisent pas.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  LOCATION_DEACTIVATION_GUARD_REGISTRY,
  type LocationDeactivationGuardRegistry,
} from '../../../organization/application/public/index.js';
import { financeLocationDeactivationGuard } from '../location-deactivation-guard.js';
import { registerCashSessionCommands } from './cash-session-commands.js';

@Injectable()
export class CashSessionCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(LOCATION_DEACTIVATION_GUARD_REGISTRY)
    private readonly deactivationGuards: LocationDeactivationGuardRegistry,
  ) {}

  onModuleInit(): void {
    this.deactivationGuards.register('finance', financeLocationDeactivationGuard);
    registerCashSessionCommands(this.registry, this.idGenerator);
  }
}

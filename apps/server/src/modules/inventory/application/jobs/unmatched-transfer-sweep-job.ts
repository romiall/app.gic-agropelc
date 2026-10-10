/**
 * `inventory.transfers.unmatched_sweep` (P5-16 ; BR-STK-024 ; SM-TRANSFER « délai de 48 h dépassé » ;
 * AV-184). Tâche horaire déposée par l'ordonnanceur (`platform_job_schedules`) : rapproche les
 * réceptions sans document encore `UNMATCHED` dont l'expédition est arrivée (filet du rapprochement
 * à l'application), puis ouvre le conflit `TRANSFER_UNMATCHED` et publie `StockTransferUnmatched` pour
 * celles dont le délai est échu (`transfer-matching.ts::sweepUnmatchedTransfers`).
 *
 * Une **transaction par paire** (source, destination), ouverte par la tâche elle-même sur la
 * connexion : le verrou de la paire y est pris en premier (lectures à jour), les verrous restent
 * courts et une paire en échec n'annule pas les autres ; la tâche est rejouable sans doublon. La
 * transaction passée par `JobRunner` ne porte que l'état de la tâche.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { DATABASE, type Database } from '../../../../platform/kysely/database.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { sweepUnmatchedTransfers } from '../transfer-matching.js';

export const UNMATCHED_TRANSFER_SWEEP_JOB_TYPE = 'inventory.transfers.unmatched_sweep';

@Injectable()
export class UnmatchedTransferSweepJob implements OnModuleInit {
  private readonly logger = new Logger(UnmatchedTransferSweepJob.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(UNMATCHED_TRANSFER_SWEEP_JOB_TYPE, async () => {
      const result = await sweepUnmatchedTransfers(this.db, {
        idGenerator: this.idGenerator,
        clock: this.clock,
      });
      this.logger.log(
        `Réceptions sans document : ${result.pairs} paire(s), ${result.matched} rapprochée(s), ` +
          `${result.signalled} signalée(s) au délai.`,
      );
    });
  }
}

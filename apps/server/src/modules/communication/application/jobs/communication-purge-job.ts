/**
 * `communication.maintenance.purge_daily` (P9-25, PF-1 et PF-7 ; ADR-068 §8 ; AV-470, AV-471, AV-472) : chaque jour
 * à 03:30 (heure de Douala), purge les notifications périmées, les abonnements push révoqués, les tâches terminées
 * et les événements sautés de la plateforme, et signale les alertes closes en attente du script d'exploitation
 * `db:purge-alerts` (`gic_app` n'a pas `DELETE` sur les alertes). Voir `maintenance/purge.ts`.
 *
 * Voie courte : lots plafonnés, quelques secondes au plus. Si la mesure dit autrement, ajouter le type à
 * `platform/jobs/job-lanes.ts` (voie longue) et à l'assertion de `analytics-units.test.ts`.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { runCommunicationPurge } from '../maintenance/purge.js';

export const COMMUNICATION_PURGE_JOB_TYPE = 'communication.maintenance.purge_daily';

@Injectable()
export class CommunicationPurgeJob implements OnModuleInit {
  private readonly logger = new Logger(CommunicationPurgeJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(COMMUNICATION_PURGE_JOB_TYPE, async (uow) => {
      // Chaque étape en échec est déjà consignée par `guardedStep` : le gestionnaire ne lève pas pour autant
      // (le JobRunner annulerait aussi les suppressions réussies).
      const outcome = await runCommunicationPurge(uow, { clock: this.clock });
      this.logger.log(
        `Purge de la communication : ${outcome.notificationsDeleted} notification(s), ` +
          `${outcome.pushSubscriptionsDeleted} abonnement(s) push, ${outcome.jobsDeleted} tâche(s) terminée(s), ` +
          `${outcome.consumerFailuresDeleted} saut(s) de consommateur supprimé(s)` +
          (outcome.truncated.length > 0
            ? ` (plafond de lots atteint : ${outcome.truncated.join(', ')}, reprise demain)`
            : '') +
          '.',
      );
      if (outcome.alertsAwaitingPurge > 0) {
        this.logger.warn(
          `${outcome.alertsAwaitingPurge} alerte(s) close(s) au-delà de leur conservation attendent le script ` +
            `d'exploitation db:purge-alerts (rôle de maintenance).`,
        );
      }
    });
  }
}

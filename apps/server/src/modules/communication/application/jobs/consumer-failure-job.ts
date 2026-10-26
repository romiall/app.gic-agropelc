/**
 * `communication.consumers.failure_check` (P9-10 ; D13 §7.1 `CONSUMER_FAILED`, ADR-061 §12, ADR-068 §7 ;
 * AV-362, AV-425) : toutes les cinq minutes, publie un événement `ConsumerFailureDetected` par consommateur
 * d'événements **en échec** — au moins un événement sauté après cinq essais dans les
 * `communication.consumer_failure_window_hours` dernières heures (24), ou un retard de position strictement
 * supérieur à `communication.consumer_lag_alert_seconds` (300) — puis le marqueur de fin de passe : un
 * consommateur rétabli (retard résorbé, sauts sortis de la fenêtre) voit son alerte se fermer seule.
 *
 * - **Consommateurs surveillés** : toutes les positions enregistrées (`platform_event_consumer_offsets`), quel que
 *   soit le processus qui les draine. Le sujet est le nom du consommateur seul : une alerte par consommateur,
 *   d'état, qui reste ouverte tant que l'une des deux conditions dure (D13 et l'ADR-061 §12 disaient « un par
 *   consommateur et par jour métier » : le catalogue, plus précis, fait foi).
 * - **Retard** : l'âge du plus ancien événement non traité (jamais un comptage). Il n'est pas la mesure d'un
 *   arrêt : un consommateur au repos n'a pas de retard, et un consommateur qui n'a jamais tourné n'a pas de ligne.
 * - **Boucle de rétroaction** : l'alerte est un événement publié dans la file que le consommateur d'alertes
 *   (`communication.alerts`) vide lui-même. Quand c'est lui qui saute des événements, il traite quand même les
 *   suivants, dont celui-ci ; quand il est en retard, l'alerte se lève après le rattrapage ; quand le worker est
 *   arrêté, ni cette tâche ni lui ne tournent. D'où le journal d'erreur de chaque passe (supervision
 *   indépendante de l'alerte) ; une sonde externe sur le retard en secondes est renvoyée à P9-22.
 * - **Données** : ni le message d'erreur ni le type de l'événement sauté ne sont lus ou publiés (ADR-061 §4).
 *   L'événement ne dépend que des positions : il ne rejoue rien.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  consumerFailureWindowHoursOrDefault,
  consumerInAlarm,
  consumerLagAlertSecondsOrDefault,
  consumerLagSeconds,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import { readConsumerStatuses } from '../../../../platform/events/consumer-status.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export const CONSUMER_FAILURE_JOB_TYPE = 'communication.consumers.failure_check';
export const CONSUMER_LAG_SETTING_KEY = 'communication.consumer_lag_alert_seconds';
export const CONSUMER_WINDOW_SETTING_KEY = 'communication.consumer_failure_window_hours';

export interface ConsumerFailureDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface ConsumerAlarm {
  readonly consumerName: string;
  readonly failedEvents: number;
  readonly lagSeconds: number;
}

export interface ConsumerFailureOutcome {
  readonly examined: number;
  readonly alarms: readonly ConsumerAlarm[];
  readonly published: number;
  readonly lagThresholdSeconds: number;
  readonly windowHours: number;
}

async function numberSetting(uow: UnitOfWork, key: string, at: Date): Promise<unknown> {
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

export async function runConsumerFailureCheck(
  uow: UnitOfWork,
  deps: ConsumerFailureDeps,
  payload: unknown,
): Promise<ConsumerFailureOutcome> {
  const now = deps.clock.now();
  const today = businessDayOf(now);
  const lagThresholdSeconds = consumerLagAlertSecondsOrDefault(
    await numberSetting(uow, CONSUMER_LAG_SETTING_KEY, now),
  );
  const windowHours = consumerFailureWindowHoursOrDefault(
    await numberSetting(uow, CONSUMER_WINDOW_SETTING_KEY, now),
  );
  const statuses = await readConsumerStatuses(uow, {
    failedSince: new Date(now.getTime() - windowHours * 3_600_000),
    now,
  });

  const passId = detectionPassId('CONSUMER_FAILED', passSlotOf(payload, now));
  const alarms: ConsumerAlarm[] = [];
  let published = 0;
  for (const status of statuses) {
    const lagSeconds = consumerLagSeconds(status.oldestPendingAt, now);
    if (!consumerInAlarm({ failedEvents: status.failedEvents, lagSeconds, lagThresholdSeconds })) {
      continue;
    }
    alarms.push({
      consumerName: status.consumerName,
      failedEvents: status.failedEvents,
      lagSeconds,
    });
    const inserted = await publishDetectionEvent(uow, deps.idGenerator, {
      eventType: 'ConsumerFailureDetected',
      producerModule: 'communication',
      aggregateType: 'EVENT_CONSUMER',
      aggregateId: compositeSubjectId('CONSUMER_FAILED', { consumer_name: status.consumerName }),
      occurredAt: now,
      passId,
      payload: {
        consumer_name: status.consumerName,
        failed_events: status.failedEvents,
        lag_seconds: lagSeconds,
        last_seq: status.lastSeq,
        ...(status.lastFailedAt !== null
          ? { last_failed_at: status.lastFailedAt.toISOString() }
          : {}),
        threshold_seconds: lagThresholdSeconds,
        window_hours: windowHours,
        business_day: today,
      },
    });
    if (inserted) published += 1;
  }
  await publishPassCompleted(uow, {
    producerModule: 'communication',
    alertType: 'CONSUMER_FAILED',
    passId,
    businessDay: today,
    occurredAt: now,
  });
  return { examined: statuses.length, alarms, published, lagThresholdSeconds, windowHours };
}

@Injectable()
export class ConsumerFailureJob implements OnModuleInit {
  private readonly logger = new Logger(ConsumerFailureJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(CONSUMER_FAILURE_JOB_TYPE, async (uow, payload) => {
      const outcome = await runConsumerFailureCheck(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator },
        payload,
      );
      // Supervision indépendante de l'alerte : le consommateur d'alertes peut être celui qui est en échec.
      for (const alarm of outcome.alarms) {
        this.logger.error(
          `Consommateur d'événements en échec : ${alarm.consumerName} — ${alarm.failedEvents} événement(s) ` +
            `sauté(s) sur ${outcome.windowHours} h, retard ${alarm.lagSeconds} s (seuil ${outcome.lagThresholdSeconds} s).`,
        );
      }
      this.logger.log(
        `Consommateurs d'événements : ${outcome.examined} examiné(s), ${outcome.alarms.length} en échec, ` +
          `${outcome.published} signalé(s).`,
      );
    });
  }
}

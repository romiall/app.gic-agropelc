/**
 * `communication.jobs.failure_check` (P9-27 ; D13 §7.1 `JOB_FAILED`, ADR-061, ADR-062 ; AV-469 choix (b), décision
 * du porteur du 29/10/2026) : toutes les cinq minutes, publie un événement `JobFailureDetected` par **type de
 * tâche** ayant au moins une tâche passée `FAILED` dans les `platform.failed_jobs_window_hours` dernières heures
 * (24), puis le marqueur de fin de passe : un type qui n'a plus aucune tâche échouée dans la fenêtre voit son
 * alerte se fermer seule. Complète la sonde `GET /health/ready` (qui ne fait que rapporter le nombre) et le journal
 * d'erreur de chaque échec (P9-25, PF-6) : l'Admin est prévenu dans l'application.
 *
 * - **Sujet** : le type de tâche seul (`analytics.export.run`, …) : une alerte ouverte par type, d'état, qui dure
 *   tant qu'une tâche du type reste échouée dans la fenêtre. Le nombre d'échecs est dans la charge utile.
 * - **Cadence** : cinq minutes, comme `communication.consumers.failure_check` (constante technique de
 *   planification, non un seuil métier) ; la fenêtre est le réglage `platform.failed_jobs_window_hours` déjà semé.
 * - **Données** : ni le message d'erreur (`last_error`) ni la charge utile des tâches ne sont lus ou publiés : ils
 *   peuvent citer des valeurs (ADR-061 §4). Le type de tâche est un nom technique.
 * - **Auto-référence** : si cette tâche échoue elle-même, elle apparaît dans sa propre fenêtre à la passe
 *   suivante, comme `CONSUMER_FAILED` pour le consommateur d'alertes ; le journal d'erreur de la passe
 *   (supervision indépendante de l'alerte) reste le filet.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, type Clock, type IdGenerator } from '@gic/domain';
import {
  FAILED_JOBS_WINDOW_SETTING_KEY,
  failedJobsWindowHoursOrDefault,
} from '../../../../health/worker-health.js';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import {
  readFailedJobsByType,
  type FailedJobsOfType,
} from '../../../../platform/jobs/job-status.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export const JOB_FAILURE_JOB_TYPE = 'communication.jobs.failure_check';

export interface JobFailureDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface JobFailureOutcome {
  /** Types de tâche ayant au moins une tâche `FAILED` dans la fenêtre. */
  readonly failing: readonly FailedJobsOfType[];
  /** Événements nouvellement publiés (un rejeu du même créneau n'en publie aucun). */
  readonly published: number;
  readonly windowHours: number;
}

export async function runJobFailureCheck(
  uow: UnitOfWork,
  deps: JobFailureDeps,
  payload: unknown,
): Promise<JobFailureOutcome> {
  const now = deps.clock.now();
  const today = businessDayOf(now);
  const windowHours = failedJobsWindowHoursOrDefault(
    await currentSettingValue(uow, {
      key: FAILED_JOBS_WINDOW_SETTING_KEY,
      scopeType: 'GLOBAL',
      scopeId: null,
      at: now,
    }),
  );
  const failing = await readFailedJobsByType(uow, {
    now,
    failedSince: new Date(now.getTime() - windowHours * 3_600_000),
  });

  const passId = detectionPassId('JOB_FAILED', passSlotOf(payload, now));
  let published = 0;
  for (const entry of failing) {
    const inserted = await publishDetectionEvent(uow, deps.idGenerator, {
      eventType: 'JobFailureDetected',
      producerModule: 'communication',
      aggregateType: 'JOB_TYPE',
      aggregateId: compositeSubjectId('JOB_FAILED', { job_type: entry.jobType }),
      occurredAt: now,
      passId,
      payload: {
        job_type: entry.jobType,
        failed_jobs: entry.failedJobs,
        last_failed_at: entry.lastFailedAt.toISOString(),
        window_hours: windowHours,
        business_day: today,
      },
    });
    if (inserted) published += 1;
  }
  await publishPassCompleted(uow, {
    producerModule: 'communication',
    alertType: 'JOB_FAILED',
    passId,
    businessDay: today,
    occurredAt: now,
  });
  return { failing, published, windowHours };
}

@Injectable()
export class JobFailureJob implements OnModuleInit {
  private readonly logger = new Logger(JobFailureJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_FAILURE_JOB_TYPE, async (uow, payload) => {
      const outcome = await runJobFailureCheck(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator },
        payload,
      );
      // Supervision indépendante de l'alerte : la tâche d'alerte peut être l'une de celles qui échouent.
      for (const entry of outcome.failing) {
        this.logger.error(
          `Tâche en échec : ${entry.jobType} — ${entry.failedJobs} tâche(s) FAILED sur ${outcome.windowHours} h.`,
        );
      }
      this.logger.log(
        `Tâches de fond : ${outcome.failing.length} type(s) en échec, ${outcome.published} signalé(s).`,
      );
    });
  }
}

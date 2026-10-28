/**
 * `GET /health` — sans authentification, sans dépendance : sonde de disponibilité externe
 * (NFR-17). `GET /health/ready` — base joignable et worker à jour
 * (09-non-functional/02-observabilite.md §7 ; P0-16).
 *
 * Le retard du worker ne se juge plus sur le seul nombre d'événements (P9-25, PF-6 ; AV-469) : retard du consommateur
 * le plus en retard en secondes et âge de la plus ancienne tâche due, en plus du proxy en événements ; les seuils sont
 * des réglages (`worker-health.ts`). Les tâches `FAILED` de la fenêtre sont rapportées, jamais un refus. La vérification
 * « migrations à jour » (§7) n'est pas faite ici : elle appartient à la CI/au déploiement (schema.sql committé, rejoué
 * avant démarrage), pas à une sonde d'exécution.
 */
import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import type { Clock } from '@gic/domain';
import { Public } from '../platform/http/authorization.decorators.js';
import { CLOCK } from '../platform/clock.provider.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../platform/events/event-consumer-registry.provider.js';
import {
  failedJobsSince,
  measureWorkerHealth,
  readWorkerHealthThresholds,
  workerHealthProblem,
} from './worker-health.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly consumers: EventConsumerRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Public()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  @Public()
  async ready(): Promise<{
    status: 'ok';
    checks: {
      readonly database: 'ok';
      readonly worker_lag_events: number;
      readonly worker_lag_seconds: number;
      readonly oldest_due_job_seconds: number;
      readonly failed_jobs: number;
    };
  }> {
    await sql`SELECT 1`.execute(this.db);

    const now = this.clock.now();
    const thresholds = await readWorkerHealthThresholds(this.db, now);
    // Seuls les consommateurs actuellement enregistrés (`EventConsumerRegistry`, alimenté au démarrage) comptent :
    // voir l'en-tête de `worker-health.ts`.
    const measures = await measureWorkerHealth(this.db, {
      consumerNames: this.consumers.names(),
      now,
      failedSince: failedJobsSince(now, thresholds),
    });

    const problem = workerHealthProblem(measures, thresholds);
    if (problem !== null) {
      throw new ApiError(503, 'WORKER_LAG', problem);
    }

    return {
      status: 'ok',
      checks: {
        database: 'ok',
        worker_lag_events: measures.lagEvents,
        worker_lag_seconds: measures.lagSeconds,
        oldest_due_job_seconds: measures.oldestDueJobSeconds,
        failed_jobs: measures.failedJobs,
      },
    };
  }
}

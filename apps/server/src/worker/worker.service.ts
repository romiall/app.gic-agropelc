/**
 * Boucle du worker (P0-08) : à chaque tour, un lot par consommateur d'événements enregistré
 * (`EventConsumerRunner.processOnce`), puis des tâches (`platform_jobs`) réclamées et
 * traitées une à une jusqu'à épuisement (`JobRunner.claimAndProcessOne`), puis une pause
 * avant de recommencer. `start()` ne rend la main qu'après `stop()` (SIGTERM/SIGINT dans
 * `worker.ts`, ou appel direct en test) — le lot en cours se termine avant l'arrêt ; un
 * verrou de ligne (`FOR UPDATE [SKIP LOCKED]`) protège déjà la reprise après coupure brutale
 * (job-runner.ts, event-consumer-runner.ts), donc aucun état supplémentaire à purger à
 * l'arrêt.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobRunner } from '../platform/jobs/job-runner.js';
import { EventConsumerRunner } from '../platform/events/event-consumer-runner.js';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../platform/events/event-consumer-registry.provider.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface WorkerLoopOptions {
  readonly pollIntervalMs?: number;
}

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);
  private stopping = false;

  constructor(
    @Inject(JobRunner) private readonly jobRunner: JobRunner,
    @Inject(EventConsumerRunner) private readonly eventRunner: EventConsumerRunner,
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly consumers: EventConsumerRegistry,
  ) {}

  /** Boucle indéfiniment jusqu'à {@link stop}. */
  async start(options: WorkerLoopOptions = {}): Promise<void> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stopping = false;
    this.logger.log(
      `Worker démarré (${this.consumers.names().length} consommateur(s) enregistré(s)).`,
    );
    while (!this.stopping) {
      await this.runOnce();
      if (!this.stopping) {
        await sleep(pollIntervalMs);
      }
    }
    this.logger.log('Worker arrêté.');
  }

  /** Signale l'arrêt à la prochaine vérification ; ne coupe pas le tour en cours. */
  stop(): void {
    this.stopping = true;
  }

  /** Un tour complet (tous les consommateurs, puis toutes les tâches dues) — utilisé en test. */
  async runOnce(): Promise<void> {
    for (const consumerName of this.consumers.names()) {
      await this.eventRunner.processOnce(consumerName);
    }
    let outcome = await this.jobRunner.claimAndProcessOne();
    while (outcome.claimed) {
      outcome = await this.jobRunner.claimAndProcessOne();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

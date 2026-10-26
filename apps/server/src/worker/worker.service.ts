/**
 * Boucle du worker (P0-08) : à chaque tour, d'abord le dépôt des tâches récurrentes dues
 * (`JobScheduler.enqueueDue`, P5-16 : au plus une par créneau, sans rattrapage en rafale ni
 * empilement), puis un lot par consommateur d'événements enregistré
 * (`EventConsumerRunner.processOnce`), puis des tâches (`platform_jobs`) réclamées et
 * traitées une à une jusqu'à épuisement (`JobRunner.claimAndProcessOne`), puis une pause
 * avant de recommencer. `start()` ne rend la main qu'après `stop()` (SIGTERM/SIGINT dans
 * `worker.ts`, ou appel direct en test) — le lot en cours se termine avant l'arrêt ; un
 * verrou de ligne (`FOR UPDATE [SKIP LOCKED]`) protège déjà la reprise après coupure brutale
 * (job-runner.ts, event-consumer-runner.ts), donc aucun état supplémentaire à purger à
 * l'arrêt.
 *
 * Deux voies (P9-22, ADR-078 §3) : la voie courte (ordonnanceur, consommateurs, tâches courtes) et la voie longue
 * (`LONG_RUNNING_JOB_TYPES` : calcul d'un export, instantanés), deux boucles concurrentes de `start()` ; un export de
 * 120 s ne retarde ainsi ni une alerte ni une tâche courte. `runOnce()` (tests, passe unique) joue les deux voies.
 *
 * Isolation des étapes (P5-16) : une étape du tour qui lève (ordonnanceur, un consommateur, la file
 * de tâches) est consignée dans le journal et le tour continue ; elle ne prive ni les autres étapes
 * ni les tours suivants, et n'arrête pas le processus.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobRunner } from '../platform/jobs/job-runner.js';
import { LONG_RUNNING_JOB_TYPES } from '../platform/jobs/job-lanes.js';
import { JobScheduler } from '../platform/jobs/job-scheduler.js';
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
    @Inject(JobScheduler) private readonly scheduler: JobScheduler,
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
    await Promise.all([
      this.loop(pollIntervalMs, () => this.runShortLane()),
      this.loop(pollIntervalMs, () => this.runLongLane()),
    ]);
    this.logger.log('Worker arrêté.');
  }

  private async loop(pollIntervalMs: number, turn: () => Promise<void>): Promise<void> {
    while (!this.stopping) {
      await turn();
      if (!this.stopping) {
        await sleep(pollIntervalMs);
      }
    }
  }

  /** Signale l'arrêt à la prochaine vérification ; ne coupe pas le tour en cours. */
  stop(): void {
    this.stopping = true;
  }

  /**
   * Un tour complet (récurrences dues, tous les consommateurs, puis toutes les tâches dues). Chaque
   * étape est isolée : son échec est consigné et ne prive pas les suivantes.
   */
  async runOnce(): Promise<void> {
    await this.runShortLane();
    await this.runLongLane();
  }

  /** Voie courte : récurrences dues, consommateurs, tâches courtes (les tâches longues en sont exclues). */
  async runShortLane(): Promise<void> {
    await this.guarded('ordonnanceur', () => this.scheduler.enqueueDue());
    for (const consumerName of this.consumers.names()) {
      await this.guarded(`consommateur « ${consumerName} »`, () =>
        this.eventRunner.processOnce(consumerName),
      );
    }
    await this.guarded('tâches', async () => {
      const lane = { excludeJobTypes: LONG_RUNNING_JOB_TYPES };
      let outcome = await this.jobRunner.claimAndProcessOne(lane);
      while (outcome.claimed) {
        outcome = await this.jobRunner.claimAndProcessOne(lane);
      }
    });
  }

  /** Voie longue : les seules tâches longues, une à une. */
  async runLongLane(): Promise<void> {
    await this.guarded('tâches longues', async () => {
      const lane = { jobTypes: LONG_RUNNING_JOB_TYPES };
      let outcome = await this.jobRunner.claimAndProcessOne(lane);
      while (outcome.claimed) {
        outcome = await this.jobRunner.claimAndProcessOne(lane);
      }
    });
  }

  private async guarded(step: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Étape « ${step} » en échec, le tour continue : ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

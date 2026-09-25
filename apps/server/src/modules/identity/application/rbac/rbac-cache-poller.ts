/**
 * Boucle d'invalidation du cache RBAC, dans le processus API (P0-10 ; voir `rbac-cache.ts`
 * et `rbac-cache-consumer.ts` pour le pourquoi). Même gabarit que `worker/worker.service.ts`
 * (P0-08) — `EventConsumerRunner.processOnce`, un intervalle court plutôt qu'un vrai temps
 * réel : un octroi/une révocation reste utilisable jusqu'à `pollIntervalMs` après sa
 * commande, borne de fraîcheur acceptable pour un cache (aucune exigence de latence n'est
 * documentée pour ce mécanisme au-delà de « invalidé par événement », pas « invalidé
 * immédiatement »).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventConsumerRunner } from '../../../../platform/events/event-consumer-runner.js';
import { RBAC_CACHE_CONSUMER_NAME } from './rbac-cache-consumer.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;

@Injectable()
export class RbacCachePoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RbacCachePoller.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(@Inject(EventConsumerRunner) private readonly runner: EventConsumerRunner) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.pollOnce().catch((error: unknown) => {
        this.logger.error(`Échec d'invalidation du cache RBAC : ${errorMessageOf(error)}`);
      });
    }, DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un tour, exposé pour les tests (au lieu d'attendre le minuteur réel). */
  async pollOnce(): Promise<void> {
    await this.runner.processOnce(RBAC_CACHE_CONSUMER_NAME);
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

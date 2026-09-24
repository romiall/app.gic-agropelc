/**
 * Traitement d'un lot pour un consommateur (P0-08 ; 08-api-events/02-catalogue-
 * evenements.md §1, §3) : « au moins une fois ; consommateurs idempotents (position + clé) ».
 *
 * Position = `last_seq` (platform_event_consumer_offsets), lu par `seq` croissant. Un
 * événement qui échoue est retenté immédiatement (`maxAttempts`, en mémoire — pas de colonne
 * de tentatives par événement, contrairement à `platform_jobs`) puis, l'échec persistant,
 * « le consommateur marque l'événement en erreur, continue avec les suivants » : la position
 * avance quand même sur cet événement (pas de blocage permanent du flux sur un doublon),
 * `last_error` retient le dernier échec pour diagnostic (pas d'alerte technique réelle —
 * module `communication`, hors périmètre P0-08).
 *
 * Effet de bord et avancée de position dans **la même transaction** : si le processus meurt
 * entre les deux, l'événement est redélivré au prochain passage (« au moins une fois ») — la
 * **clé** (`event_id` + consommateur, ou contrainte d'unicité métier, à la charge du
 * gestionnaire) est ce qui rend cette redélivrance sans effet double.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../kysely/database.provider.js';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from './event-consumer-registry.provider.js';
import { toDomainEvent } from './domain-event.js';

export interface EventConsumerRunOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
}

export interface EventConsumerRunResult {
  readonly processed: number;
  readonly failed: number;
  readonly lastSeq: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;

@Injectable()
export class EventConsumerRunner {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly registry: EventConsumerRegistry,
  ) {}

  async processOnce(
    consumerName: string,
    options: EventConsumerRunOptions = {},
  ): Promise<EventConsumerRunResult> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const handler = this.registry.resolve(consumerName);
    if (!handler) {
      throw new Error(`Aucun consommateur enregistré : « ${consumerName} ».`);
    }

    const offset = await this.db
      .selectFrom('platform_event_consumer_offsets')
      .select('last_seq')
      .where('consumer_name', '=', consumerName)
      .executeTakeFirst();
    let lastSeq = offset ? Number(offset.last_seq) : 0;

    const rows = await this.db
      .selectFrom('platform_domain_events')
      .selectAll()
      .where('seq', '>', lastSeq)
      .orderBy('seq', 'asc')
      .limit(batchSize)
      .execute();

    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const event = toDomainEvent(row);
      let succeeded = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts && !succeeded; attempt++) {
        try {
          await this.db.transaction().execute((trx) => handler(trx, event));
          succeeded = true;
        } catch (error) {
          lastError = error;
        }
      }
      lastSeq = event.seq;
      if (succeeded) {
        processed++;
      } else {
        failed++;
      }
      await this.saveOffset(consumerName, lastSeq, succeeded ? null : errorMessageOf(lastError));
    }

    if (rows.length === 0 && !offset) {
      await this.saveOffset(consumerName, 0, null);
    }

    return { processed, failed, lastSeq };
  }

  private async saveOffset(
    consumerName: string,
    lastSeq: number,
    lastError: string | null,
  ): Promise<void> {
    await this.db
      .insertInto('platform_event_consumer_offsets')
      .values({ consumer_name: consumerName, last_seq: lastSeq, last_error: lastError })
      .onDuplicateKeyUpdate({ last_seq: lastSeq, last_error: lastError })
      .execute();
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

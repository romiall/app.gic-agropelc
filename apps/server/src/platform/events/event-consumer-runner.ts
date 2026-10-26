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
 *
 * P5-23 (revue adverse, même défaut qu'AV-198) : `seq` est attribué à l'insertion de l'événement, pas à
 * la validation de sa transaction. La position ne dépasse jamais un trou récent de la numérotation
 * (`settledSequenceBound`) : les événements au-delà attendent le passage suivant, dans l'ordre. Sans
 * cela, un événement validé après un numéro supérieur était sauté sans trace (invalidation du cache
 * des droits, révocation des quotas d'un appareil perdu).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../kysely/database.provider.js';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from './event-consumer-registry.provider.js';
import { toDomainEvent, type DomainEvent } from './domain-event.js';
import { toBin } from '../kysely/uuid-columns.js';
import { settledSequenceBound } from '../kysely/settled-sequence.js';

export interface EventConsumerRunOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  /** Fenêtre de stabilisation de la numérotation (valeur technique du protocole, pas un seuil métier). */
  readonly settleSeconds?: number;
}

export interface EventConsumerRunResult {
  readonly processed: number;
  readonly failed: number;
  readonly lastSeq: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
/** Même fenêtre que le pull des appareils (AV-198, `sync.pull_settle_seconds`). */
export const EVENT_SETTLE_DEFAULT_SECONDS = 120;

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

    const read = await this.db
      .selectFrom('platform_domain_events')
      .selectAll()
      .where('seq', '>', lastSeq)
      .orderBy('seq', 'asc')
      .limit(batchSize)
      .execute();
    const bound = await settledSequenceBound(
      this.db,
      'platform_domain_events',
      { from: lastSeq, upTo: read.length > 0 ? Number(read[read.length - 1]!.seq) : lastSeq },
      options.settleSeconds ?? EVENT_SETTLE_DEFAULT_SECONDS,
    );
    const rows = read.filter((row) => Number(row.seq) <= bound);

    let processed = 0;
    let failed = 0;
    // Dernière erreur rencontrée dans CET appel (pas seulement pour l'événement courant) :
    // un échec doit rester visible pour diagnostic même si un événement suivant du même lot
    // réussit ensuite — sans quoi le succès du suivant écraserait `last_error` avec `null` et
    // effacerait la trace d'un échec pourtant définitif (l'événement en échec n'est jamais
    // retenté, sa position est dépassée).
    let batchError: string | null = null;
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
        batchError = errorMessageOf(lastError);
        // `last_error` est réécrit par le premier événement traité ensuite : le saut est consigné
        // à part (ajout seul), avant d'avancer la position (ADR-061 §12, AV-362). Un rejeu avant la
        // position ne le double pas (unicité consommateur × position).
        await this.recordFailure(consumerName, event, batchError, maxAttempts);
      }
      await this.saveOffset(consumerName, lastSeq, batchError);
    }

    if (rows.length === 0 && !offset) {
      await this.saveOffset(consumerName, 0, null);
    }

    return { processed, failed, lastSeq };
  }

  private async recordFailure(
    consumerName: string,
    event: DomainEvent,
    message: string,
    attempts: number,
  ): Promise<void> {
    try {
      await this.db
        .insertInto('platform_event_consumer_failures')
        .values({
          consumer_name: consumerName,
          event_seq: event.seq,
          event_id: toBin(event.eventId),
          event_type: event.eventType.slice(0, 80),
          error_message: message.slice(0, 1000),
          attempts,
        })
        .execute();
    } catch (error) {
      // Un rejeu avant l'avancée de la position retrouve la ligne : seule l'unicité (consommateur × position) est
      // ignorée. Toute autre erreur lève, si bien que la position n'avance pas sur un saut sans trace (un
      // `INSERT IGNORE` aurait aussi avalé une valeur refusée). La table est en ajout seul : pas d'UPDATE accordé.
      if (!isDuplicateKey(error)) throw error;
    }
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

function isDuplicateKey(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: string; errno?: number };
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

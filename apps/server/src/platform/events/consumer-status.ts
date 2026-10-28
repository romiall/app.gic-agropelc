/**
 * État des consommateurs d'événements (P9-10 ; AV-362, AV-425) : position, retard et événements sautés de
 * chaque consommateur, lus dans les tables que la plateforme possède (`platform_event_consumer_offsets`,
 * `platform_event_consumer_failures`, `platform_domain_events`). Lecture seule, sans verrou ; le détecteur
 * `CONSUMER_FAILED` de `communication` s'en sert, et la supervision pourra s'en servir aussi (retard en
 * secondes, métriques de P9-22) sans relire les tables.
 *
 * - **Consommateurs** : toutes les lignes de positions, quel que soit le processus qui les draine (le cache des
 *   droits est drainé par l'API, les alertes et les quotas par le worker). Une ligne n'existe qu'après le
 *   premier passage d'un consommateur : un consommateur qui n'a jamais tourné n'est pas visible. Renommer ou
 *   retirer un consommateur laisse sa ligne (aucune suppression accordée) : une migration doit la renommer ou
 *   l'apurer, sinon elle serait signalée à jamais.
 * - **Retard** : l'âge, selon l'horloge de la base (`recorded_at`), du plus ancien événement de numéro supérieur
 *   à la position — `NULL` si rien n'attend. Une sous-requête par clé primaire : coût constant par consommateur,
 *   quel que soit l'arriéré (aucun comptage).
 * - **Événements sautés** : lignes de `platform_event_consumer_failures` dans `(failedSince, now]` ; la borne
 *   haute est indispensable (une horloge de test dans le passé ne doit rien voir des lignes réelles). Agrégés
 *   en base : un gestionnaire qui échoue sur tout événement écrit une ligne par événement.
 * - Le message d'erreur d'un saut n'est **jamais** lu ici : il peut porter des données personnelles (ADR-061 §4).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../kysely/database.js';

export interface ConsumerStatus {
  readonly consumerName: string;
  readonly lastSeq: number;
  /** Réception par la base du plus ancien événement non traité ; `null` si aucun n'attend. */
  readonly oldestPendingAt: Date | null;
  /** Événements sautés dans la fenêtre demandée. */
  readonly failedEvents: number;
  /** Dernier saut de la fenêtre ; `null` s'il n'y en a pas. */
  readonly lastFailedAt: Date | null;
}

interface OffsetRow {
  readonly consumer_name: string;
  readonly last_seq: string | number;
  readonly oldest_pending_at: Date | string | null;
}

/** Exécuteur de lecture : une transaction (tâche) ou le pool (sonde de disponibilité, P9-25 PF-6). */
type ReadExecutor = Kysely<DB> | Transaction<DB>;

/** Position et retard d'un consommateur, sans les événements sautés. */
export interface ConsumerLag {
  readonly consumerName: string;
  readonly lastSeq: number;
  readonly oldestPendingAt: Date | null;
}

/**
 * Positions et retards de tous les consommateurs, par nom croissant, sans lire les événements sautés (la sonde
 * `GET /health/ready` n'en a pas besoin : une requête d'agrégation de moins par appel public).
 */
export async function readConsumerLags(executor: ReadExecutor): Promise<readonly ConsumerLag[]> {
  const offsets = (
    await sql<OffsetRow>`
      SELECT o.consumer_name, o.last_seq,
             (SELECT e.recorded_at FROM platform_domain_events e
               WHERE e.seq > o.last_seq ORDER BY e.seq ASC LIMIT 1) AS oldest_pending_at
        FROM platform_event_consumer_offsets o
       ORDER BY o.consumer_name
    `.execute(executor)
  ).rows;
  return offsets.map((row) => ({
    consumerName: row.consumer_name,
    lastSeq: Number(row.last_seq),
    oldestPendingAt: row.oldest_pending_at === null ? null : new Date(row.oldest_pending_at),
  }));
}

/** État de tous les consommateurs, par nom croissant. */
export async function readConsumerStatuses(
  executor: ReadExecutor,
  window: { readonly failedSince: Date; readonly now: Date },
): Promise<readonly ConsumerStatus[]> {
  const lags = await readConsumerLags(executor);
  const failures = await executor
    .selectFrom('platform_event_consumer_failures')
    .select(({ fn }) => [
      'consumer_name',
      fn.countAll<number>().as('failed_events'),
      fn.max('failed_at').as('last_failed_at'),
    ])
    .where('failed_at', '>', window.failedSince)
    .where('failed_at', '<=', window.now)
    .groupBy('consumer_name')
    .execute();
  const failuresOf = new Map(failures.map((row) => [row.consumer_name, row]));
  return lags.map((lag) => {
    const failed = failuresOf.get(lag.consumerName);
    return {
      ...lag,
      failedEvents: failed === undefined ? 0 : Number(failed.failed_events),
      lastFailedAt: failed?.last_failed_at == null ? null : new Date(failed.last_failed_at),
    };
  });
}

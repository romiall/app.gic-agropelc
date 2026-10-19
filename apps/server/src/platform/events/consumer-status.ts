/**
 * État des consommateurs d'événements (P9-10 ; AV-412, AV-475) : position, retard et événements sautés de
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
 * - Le message d'erreur d'un saut n'est **jamais** lu ici : il peut porter des données personnelles (ADR-071 §4).
 */
import { sql } from 'kysely';
import type { UnitOfWork } from '../unit-of-work.js';

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

/** État de tous les consommateurs, par nom croissant. */
export async function readConsumerStatuses(
  uow: UnitOfWork,
  window: { readonly failedSince: Date; readonly now: Date },
): Promise<readonly ConsumerStatus[]> {
  const offsets = (
    await sql<OffsetRow>`
      SELECT o.consumer_name, o.last_seq,
             (SELECT e.recorded_at FROM platform_domain_events e
               WHERE e.seq > o.last_seq ORDER BY e.seq ASC LIMIT 1) AS oldest_pending_at
        FROM platform_event_consumer_offsets o
       ORDER BY o.consumer_name
    `.execute(uow)
  ).rows;
  const failures = await uow
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
  return offsets.map((row) => {
    const failed = failuresOf.get(row.consumer_name);
    return {
      consumerName: row.consumer_name,
      lastSeq: Number(row.last_seq),
      oldestPendingAt: row.oldest_pending_at === null ? null : new Date(row.oldest_pending_at),
      failedEvents: failed === undefined ? 0 : Number(failed.failed_events),
      lastFailedAt: failed?.last_failed_at == null ? null : new Date(failed.last_failed_at),
    };
  });
}

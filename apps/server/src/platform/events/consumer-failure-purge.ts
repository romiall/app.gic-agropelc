/**
 * Purge du journal des événements sautés par un consommateur, `platform_event_consumer_failures` (P9-25, PF-7 ;
 * ADR-061 §12, ADR-068 §8 ; AV-425 « Limites », AV-472).
 *
 * Ce journal est **technique** : il ne porte aucune valeur métier (les événements restent dans
 * `platform_domain_events`, immuable) et son message d'erreur peut contenir une donnée personnelle (ADR-061 §4).
 * Cette fonction ne lit ni ne publie ce message : elle ne sélectionne que les clés. `DELETE` est accordé à
 * l'application par la migration 20261201090700, pour cette seule purge ; aucun `UPDATE` (la ligne d'un saut ne
 * se modifie pas).
 *
 * - **Coupure** : calculée par l'appelant avec `consumerFailurePurgeCutoff` (domaine), jamais plus récente que la
 *   fenêtre `communication.consumer_failure_window_hours` : supprimer une ligne de la fenêtre fermerait l'alerte
 *   `CONSUMER_FAILED` d'un consommateur toujours en échec. Comparaison stricte (`failed_at` = coupure : conservé).
 * - **Deux temps** (`deleteBatchByKeys`) : lecture des identifiants sans verrou, puis suppression par clé primaire.
 *   Un `DELETE ... WHERE failed_at < ? LIMIT n` poserait, sous `REPEATABLE READ`, un verrou de clé suivante sur la
 *   fin de l'index `ix_platform_event_consumer_failures_failed` quand rien n'est postérieur à la coupure, et
 *   bloquerait l'insertion d'un saut (`event-consumer-runner.ts`) jusqu'à la fin de la tâche.
 *
 * Plafond : 40 lots de 5 000 par exécution (200 000 sauts par jour) ; au-delà, le reste est repris le lendemain et
 * l'appelant consigne l'étape tronquée (un consommateur empoisonné qui échoue sur chaque événement d'un grand flux
 * fait croître la table plus vite que la purge : l'avertissement le dit).
 */
import { deleteBatchByKeys, deleteByBatches, type BatchPurgeResult } from '../purge-batches.js';
import type { UnitOfWork } from '../unit-of-work.js';

/** Sauts supprimés par lot. */
export const CONSUMER_FAILURE_PURGE_BATCH = 5_000;
/** Lots au plus par exécution : borne la durée de la transaction unique de la tâche quotidienne. */
export const CONSUMER_FAILURE_PURGE_MAX_BATCHES = 40;

export async function purgeConsumerFailures(
  uow: UnitOfWork,
  input: { readonly before: Date; readonly batch?: number; readonly maxBatches?: number },
): Promise<BatchPurgeResult> {
  return deleteByBatches(
    (limit) =>
      deleteBatchByKeys(
        limit,
        async (size) => {
          const rows = await uow
            .selectFrom('platform_event_consumer_failures')
            .select('id')
            .where('failed_at', '<', input.before)
            .limit(size)
            .execute();
          return rows.map((row) => row.id);
        },
        async (ids) =>
          Number(
            (
              await uow
                .deleteFrom('platform_event_consumer_failures')
                .where('id', 'in', [...ids])
                .executeTakeFirst()
            ).numDeletedRows,
          ),
      ),
    {
      batch: input.batch ?? CONSUMER_FAILURE_PURGE_BATCH,
      maxBatches: input.maxBatches ?? CONSUMER_FAILURE_PURGE_MAX_BATCHES,
    },
  );
}

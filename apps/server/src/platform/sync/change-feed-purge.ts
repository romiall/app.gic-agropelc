/**
 * Compaction du flux de changements `sync_change_feed` (BR-SYN-015 « PURGE_TECHNIQUE au-delà de 60 jours » ; AV-520).
 *
 * Le flux ne copie pas les données : une ligne désigne une entité et le serveur projette son état **courant** à la
 * lecture. Un chargement initial lit le flux depuis le curseur 0 (il n'y a pas d'instantané séparé, 02-synchronisation
 * §5.4) : supprimer la dernière ligne d'une entité qui n'a plus changé depuis 60 jours la ferait disparaître des
 * appareils neufs. On ne purge donc que les lignes **remplacées** :
 *
 * - une ligne n'est supprimée que si elle a plus de `before` (comparaison stricte : d'âge exact, conservée) **et**
 *   qu'une ligne plus récente existe pour la même clé (jeu, type d'entité, entité, portée) ;
 * - la dernière ligne de chaque clé reste, `UPSERT`, `DELETE` ou `SCOPE_EXIT` : un appareil dont le curseur est plus
 *   ancien que toute purge reçoit exactement les mêmes états qu'avant, puisque le tirage ne sert déjà, par page, que
 *   la dernière ligne de chaque clé (`sync-pull.service.ts`, dédoublonnage) et projette l'état courant ;
 * - la croissance du flux est ainsi bornée par le nombre d'entités (plus leurs sorties de portée), non par
 *   l'historique des modifications.
 *
 * Index `ix_sync_change_feed_entity (entity_id, seq)` (migration 20261203090000) : sans lui, chercher « une ligne plus
 * récente » de chaque candidate parcourrait le jeu entier. Deux temps (`deleteBatchByKeys`) : lecture des numéros sans
 * verrou, puis suppression par clé primaire ; `DELETE` est accordé à l'application sur cette table depuis P0-09 (et le
 * déclencheur d'immuabilité ne refuse que les `UPDATE`).
 */
import { sql } from 'kysely';
import { deleteBatchByKeys, deleteByBatches, type BatchPurgeResult } from '../purge-batches.js';
import type { UnitOfWork } from '../unit-of-work.js';

/** Lignes supprimées par lot. */
export const CHANGE_FEED_PURGE_BATCH = 5_000;
/** Lots au plus par exécution : borne la durée de la transaction unique de la tâche quotidienne. */
export const CHANGE_FEED_PURGE_MAX_BATCHES = 10;

export async function purgeSupersededChangeFeed(
  uow: UnitOfWork,
  input: { readonly before: Date; readonly batch?: number; readonly maxBatches?: number },
): Promise<BatchPurgeResult> {
  return deleteByBatches(
    (limit) =>
      deleteBatchByKeys(
        limit,
        async (size) => {
          const result = await sql<{ seq: string }>`
            SELECT f.seq
              FROM sync_change_feed f
             WHERE f.recorded_at < ${input.before}
               AND EXISTS (
                 SELECT 1 FROM sync_change_feed n
                  WHERE n.entity_id = f.entity_id
                    AND n.seq > f.seq
                    AND n.dataset = f.dataset
                    AND n.entity_type = f.entity_type
                    AND n.scope_type = f.scope_type
                    AND n.scope_id <=> f.scope_id)
             ORDER BY f.seq
             LIMIT ${size}`.execute(uow);
          return result.rows.map((row) => Number(row.seq));
        },
        async (seqs) =>
          Number(
            (
              await uow
                .deleteFrom('sync_change_feed')
                .where('seq', 'in', [...seqs])
                .executeTakeFirst()
            ).numDeletedRows,
          ),
      ),
    {
      batch: input.batch ?? CHANGE_FEED_PURGE_BATCH,
      maxBatches: input.maxBatches ?? CHANGE_FEED_PURGE_MAX_BATCHES,
    },
  );
}

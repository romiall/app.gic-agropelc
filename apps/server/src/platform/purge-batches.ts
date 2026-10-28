/**
 * Utilitaires communs des purges par lots plafonnés (P9-25, PF-1 et PF-7 ; ADR-068 §8). Même idiome que la boucle de
 * lots de `modules/analytics/application/maintenance/purge.ts`, sans la répéter.
 *
 * - `deleteByBatches` : répète un lot jusqu'à ce qu'il soit incomplet (rien ne reste) ou que le plafond de lots
 *   soit atteint (le reste est repris à l'exécution suivante).
 * - `deleteBatchByKeys` : un lot en **deux temps**. Un `DELETE ... WHERE <prédicat> LIMIT n` sur une colonne sans
 *   index adapté verrouille, sous `REPEATABLE READ`, toutes les lignes parcourues (verrous de clé suivante, fin de
 *   table comprise) jusqu'à la fin de la transaction : il bloquerait les insertions concurrentes et attendrait les
 *   verrous des autres voies. Ici la lecture des clés est sans verrou et la suppression par clé primaire ne
 *   verrouille que les lignes supprimées.
 */

export interface BatchPurgeResult {
  readonly deleted: number;
  /** Vrai si le plafond de lots est atteint : il peut rester des lignes, reprises à l'exécution suivante. */
  readonly truncated: boolean;
}

export async function deleteByBatches(
  deleteBatch: (limit: number) => Promise<number>,
  options: { readonly batch: number; readonly maxBatches: number },
): Promise<BatchPurgeResult> {
  let deleted = 0;
  for (let index = 0; index < options.maxBatches; index += 1) {
    const count = await deleteBatch(options.batch);
    deleted += count;
    if (count < options.batch) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}

/**
 * Un lot en deux temps : `selectKeys(limit)` lit (sans verrou) au plus `limit` clés de lignes éligibles,
 * `deleteKeys(keys)` les supprime par clé primaire et rend le nombre de lignes réellement supprimées (une ligne
 * partie entre-temps ne compte pas). Aucune clé lue : rien n'est supprimé, le lot rend 0.
 */
export async function deleteBatchByKeys<K>(
  limit: number,
  selectKeys: (limit: number) => Promise<readonly K[]>,
  deleteKeys: (keys: readonly K[]) => Promise<number>,
): Promise<number> {
  const keys = await selectKeys(limit);
  if (keys.length === 0) return 0;
  return deleteKeys(keys);
}

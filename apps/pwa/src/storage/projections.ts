/**
 * Lecture typée des projections téléchargées (`projections`, clé `dataset:entity_type:entity_id`).
 * Les écrans ne lisent jamais la table directement : ils passent par ces fonctions ou par le crochet
 * `useProjected`, qui suit les changements appliqués par le moteur de synchronisation.
 *
 * Le type `T` décrit la forme servie par `apps/server/src/sync/entity-projections.ts` ; la PWA ne la
 * revalide pas (même choix que `useHome`, NFR-05) et chaque écran tolère une clé absente.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb, type GicDatabase } from './db.js';

export async function listProjected<T>(
  db: GicDatabase,
  dataset: string,
  entityType: string,
): Promise<T[]> {
  const rows = await db.projections
    .where('[dataset+entity_type]')
    .equals([dataset, entityType])
    .toArray();
  return rows.map((row) => row.data as T);
}

export async function getProjected<T>(
  db: GicDatabase,
  dataset: string,
  entityType: string,
  entityId: string,
): Promise<T | undefined> {
  const row = await db.projections.get(`${dataset}:${entityType}:${entityId}`);
  return row ? (row.data as T) : undefined;
}

/** Liste suivie en direct ; `undefined` pendant la première lecture. */
export function useProjected<T>(dataset: string, entityType: string): T[] | undefined {
  return useLiveQuery(() => listProjected<T>(getDb(), dataset, entityType), [dataset, entityType]);
}

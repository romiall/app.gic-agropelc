/**
 * Téléchargement incrémental depuis `GET /api/v1/sync/pull` (06-offline-sync/02-
 * synchronisation.md §5). Un appareil neuf appelle ce même point avec `cursor = 0` : pas de
 * code de chargement initial séparé (même remarque que `sync-pull.service.ts` côté serveur).
 *
 * Jeux de données : le serveur n'émet aujourd'hui que le repli générique
 * `aggregate_type.toLowerCase()` (commentaire de `command-pipeline.service.ts`, « portée/jeu
 * de données réels déterminés par chaque module ») — pas encore le catalogue `me`/`org`/
 * `catalog`/… de l'architecture cible (01-architecture-offline.md §3.1), qui arrivera avec
 * les modules qui le motivent. Cette liste est donc le miroir exact des `entity_type` que
 * `entity-projections.ts` sait projeter aujourd'hui, pas la liste finale.
 */
import type { Change, PullResponse } from '@gic/contracts';
import type { Clock } from '@gic/domain';
import type { GicDatabase } from '../storage/db.js';
import { authorizedRequest } from './api-client.js';

export const KNOWN_DATASETS = [
  'user',
  'device',
  'role_assignment',
  'zone',
  'site',
  'location',
  'team',
  'team_membership',
  'setting',
  'control_policy',
  'approval_request',
  'attachment',
] as const;

const PAGE_LIMIT = 500;

async function applyChange(db: GicDatabase, change: Change): Promise<void> {
  const key = `${change.dataset}:${change.entity_type}:${change.entity_id}`;
  if (change.change_type === 'DELETE' || change.change_type === 'SCOPE_EXIT') {
    await db.projections.delete(key);
    return;
  }
  if (!change.data) return; // UPSERT sans donnée projetée (ex. paramètre non client-visible)
  await db.projections.put({
    key,
    dataset: change.dataset,
    entity_type: change.entity_type,
    entity_id: change.entity_id,
    scope_type: change.scope_type,
    scope_id: change.scope_id,
    row_version: change.row_version,
    data: change.data,
    seq: change.seq,
  });
}

export type PullCycleResult =
  | { readonly outcome: 'SYNCED'; readonly changeCount: number }
  | { readonly outcome: 'OFFLINE' }
  | { readonly outcome: 'SESSION_INVALID' };

type PullDatasetResult =
  | { readonly ok: true; readonly changeCount: number }
  | { readonly ok: false; readonly reason: 'OFFLINE' | 'SESSION_INVALID' };

async function pullDataset(db: GicDatabase, dataset: string): Promise<PullDatasetResult> {
  let changeCount = 0;
  for (;;) {
    const cursorRow = await db.syncCursors.get(dataset);
    const cursor = cursorRow?.cursor ?? 0;
    const result = await authorizedRequest<PullResponse>(
      db,
      `/api/v1/sync/pull?dataset=${encodeURIComponent(dataset)}&cursor=${cursor}&limit=${PAGE_LIMIT}`,
      { method: 'GET' },
    );
    if (!result.ok) {
      // Seul un jeton de rafraîchissement invalide force la déconnexion locale (même choix
      // que `push.ts`) : une erreur HTTP du contrôleur est reportée comme `OFFLINE`.
      return {
        ok: false,
        reason: result.reason === 'SESSION_INVALID' ? 'SESSION_INVALID' : 'OFFLINE',
      };
    }

    for (const change of result.data.changes) await applyChange(db, change);
    changeCount += result.data.changes.length;
    await db.syncCursors.put({ dataset, cursor: result.data.next_cursor });
    if (!result.data.has_more) break;
  }
  return { ok: true, changeCount };
}

export async function runPullCycle(
  db: GicDatabase,
  deps: { readonly clock: Clock },
): Promise<PullCycleResult> {
  let total = 0;
  for (const dataset of KNOWN_DATASETS) {
    const result = await pullDataset(db, dataset);
    if (!result.ok) return { outcome: result.reason };
    total += result.changeCount;
  }
  await db.syncMeta.update('device', { last_sync_at: deps.clock.now().toISOString() });
  return { outcome: 'SYNCED', changeCount: total };
}

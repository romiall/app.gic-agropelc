/**
 * `GET /api/v1/sync/pull` (06-offline-sync/02-synchronisation.md §5). Couche transport
 * (comme `commands/`) : lit `sync_change_feed` par périmètre de l'appareil
 * (`device-scope.ts`), projette l'état courant de chaque entité (`entity-projections.ts` —
 * « le flux ne stocke pas de copie des données »).
 *
 * Chargement initial (§5.4) : pas de code séparé — un appareil neuf appelle ce même point
 * avec `cursor = 0`, qui renvoie tout l'historique du flux dans son périmètre. Chaque ligne
 * projette l'état **courant** de son entité (jamais l'état historique au moment du
 * changement) : si une entité a changé plusieurs fois, l'appareil reçoit plusieurs lignes
 * identiques pour elle (upsert répété, sans effet, sans perte de correction) plutôt que
 * l'instantané dédupliqué que décrit le §5.4 — dédup déférée : le volume de P0 (quelques
 * centaines de lignes) ne le justifie pas encore. `next_cursor` avance néanmoins de manière
 * strictement croissante, jamais au-delà de ce qui a été effectivement lu (aucune perte).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { ExpressionBuilder } from 'kysely';
import type { Change, PullRequest, PullResponse } from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';
import { computeDeviceScope, type DeviceScopeEntry } from './device-scope.js';
import { resolveEntityProjection } from './entity-projections.js';

export interface SyncPullContext {
  readonly authenticatedUserId: string;
  readonly authenticatedDeviceId: string;
  readonly now: Date;
}

@Injectable()
export class SyncPullService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async pull(request: PullRequest, ctx: SyncPullContext): Promise<PullResponse> {
    const scope = await computeDeviceScope(
      this.db,
      ctx.authenticatedUserId,
      ctx.authenticatedDeviceId,
      ctx.now,
    );

    const rows = await this.db
      .selectFrom('sync_change_feed')
      .selectAll()
      .where('seq', '>', request.cursor)
      .where('dataset', '=', request.dataset)
      .where((eb) => eb.or(scopeConditions(eb, scope)))
      .orderBy('seq', 'asc')
      .limit(request.limit + 1)
      .execute();

    const hasMore = rows.length > request.limit;
    const page = hasMore ? rows.slice(0, request.limit) : rows;

    const changes: Change[] = [];
    for (const row of page) {
      const base = {
        seq: Number(row.seq),
        dataset: row.dataset,
        entity_type: row.entity_type,
        entity_id: fromBin(row.entity_id),
        change_type: row.change_type as Change['change_type'],
        scope_type: row.scope_type as Change['scope_type'],
        scope_id: fromBinOrNull(row.scope_id),
        row_version: row.row_version,
      };
      if (row.change_type !== 'UPSERT') {
        changes.push(base); // DELETE/SCOPE_EXIT : rien à projeter (§5.3)
        continue;
      }
      const reader = resolveEntityProjection(row.entity_type);
      const data = reader ? await reader(this.db, fromBin(row.entity_id)) : undefined;
      if (data === undefined) continue; // entité disparue, ou hors offre (ex. paramètre non client-visible)
      changes.push({ ...base, data });
    }

    const nextCursor = page.length > 0 ? Number(page[page.length - 1]!.seq) : request.cursor;
    return { changes, next_cursor: nextCursor, has_more: hasMore };
  }
}

function scopeConditions(
  eb: ExpressionBuilder<DB, 'sync_change_feed'>,
  scope: readonly DeviceScopeEntry[],
) {
  const conditions = [eb('scope_type', '=', 'GLOBAL')];
  const byType = new Map<DeviceScopeEntry['scopeType'], string[]>();
  for (const entry of scope) {
    const ids = byType.get(entry.scopeType) ?? [];
    ids.push(entry.scopeId);
    byType.set(entry.scopeType, ids);
  }
  for (const [scopeType, ids] of byType) {
    if (ids.length === 0) continue;
    conditions.push(
      eb.and([
        eb('scope_type', '=', scopeType),
        eb(
          'scope_id',
          'in',
          ids.map((id) => toBin(id)),
        ),
      ]),
    );
  }
  return conditions;
}

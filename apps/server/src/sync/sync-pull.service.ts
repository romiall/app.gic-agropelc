/**
 * `GET /api/v1/sync/pull` (06-offline-sync/02-synchronisation.md §5). Couche transport
 * (comme `commands/`) : lit `sync_change_feed` par périmètre de l'appareil
 * (`device-scope.ts`), projette l'état courant de chaque entité (`entity-projections.ts` —
 * « le flux ne stocke pas de copie des données »).
 *
 * Chargement initial (§5.4) : pas de code séparé — un appareil neuf appelle ce même point
 * avec `cursor = 0`, qui renvoie tout l'historique du flux dans son périmètre. Chaque ligne
 * projette l'état **courant** de son entité (jamais l'état historique au moment du
 * changement). **Dédoublonnage par page** (P5-18, RISK-23) : dans une page, seule la dernière
 * ligne de chaque (type d'entité, entité, portée) est servie — les précédentes projetteraient le même
 * état courant (un `UPSERT`) ou seraient annulées par elle (un `SCOPE_EXIT` ou un `DELETE` plus
 * récent) ; un quota consommé quarante fois n'occupe ainsi qu'une ligne. Entre deux pages, une
 * entité peut encore revenir (sans effet). `next_cursor` avance de manière strictement croissante,
 * jusqu'au dernier numéro lu. **Limite connue (AV-198, préexistante, à corriger en P5-23)** : `seq`
 * est attribué à l'insertion, pas à la validation ; une ligne d'une transaction encore ouverte,
 * validée après une ligne de numéro supérieur déjà servie, est sautée par ce curseur — une sortie
 * terminale (quota révoqué, session validée, remise reçue) peut alors manquer à l'appareil.
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
      request.dataset,
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

    // Dernière ligne de chaque (type, entité, portée) dans la page (dédoublonnage, voir l'en-tête).
    const lastSeqOf = new Map<string, number>();
    const keyOf = (row: (typeof page)[number]) =>
      `${row.entity_type}|${fromBin(row.entity_id)}|${row.scope_type}|${fromBinOrNull(row.scope_id) ?? ''}`;
    for (const row of page) lastSeqOf.set(keyOf(row), Number(row.seq));

    const changes: Change[] = [];
    for (const row of page) {
      if (lastSeqOf.get(keyOf(row)) !== Number(row.seq)) continue;
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
      const data = reader
        ? await reader(this.db, fromBin(row.entity_id), {
            scopeType: row.scope_type,
            scopeId: fromBinOrNull(row.scope_id),
          })
        : undefined;
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

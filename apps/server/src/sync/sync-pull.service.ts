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
 * entité peut encore revenir (sans effet). **Curseur retenu (P5-23, AV-198)** : `seq` est attribué à
 * l'insertion, pas à la validation ; une ligne d'une transaction encore ouverte, validée après une ligne
 * de numéro supérieur, serait sautée par un curseur posé sur le dernier numéro lu. `next_cursor` ne
 * dépasse donc jamais un trou récent de la numérotation (`settledSequenceBound`, fenêtre
 * `sync.pull_settle_seconds`) : la page est servie entière, ses lignes au-delà du curseur le seront de
 * nouveau au pull suivant (sans effet : état courant), et `has_more` est faux tant que le curseur est
 * retenu (l'appareil ne boucle pas ; il retire au prochain cycle).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type ExpressionBuilder } from 'kysely';
import type { Change, PullRequest, PullResponse } from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';
import { computeDeviceScope, type DeviceScopeEntry } from './device-scope.js';
import { authorDataset, DEVICE_DATASET } from './sync-push.service.js';
import { resolveEntityProjection } from './entity-projections.js';
import { settledSequenceBound } from '../platform/kysely/settled-sequence.js';
import { currentSettingValue } from '../modules/organization/application/public/index.js';

/** Fenêtre de stabilisation de la numérotation du flux (AV-198) : valeur semée si le paramètre manque. */
export const PULL_SETTLE_DEFAULT_SECONDS = 120;
export const SYNC_PULL_OPTIONS = Symbol('SYNC_PULL_OPTIONS');
export interface SyncPullOptions {
  /** Remplace le paramètre (tests de la mécanique du curseur : 0 = aucune retenue). */
  readonly settleSeconds?: number;
}

export interface SyncPullContext {
  readonly authenticatedUserId: string;
  readonly authenticatedDeviceId: string;
  readonly now: Date;
}

@Injectable()
export class SyncPullService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() @Inject(SYNC_PULL_OPTIONS) private readonly options?: SyncPullOptions,
  ) {}

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

    const lastRead = page.length > 0 ? Number(page[page.length - 1]!.seq) : request.cursor;
    const nextCursor = await settledSequenceBound(
      this.db,
      'sync_change_feed',
      { from: request.cursor, upTo: lastRead },
      await this.settleSeconds(ctx.now),
    );
    await this.recordPull(ctx);
    return { changes, next_cursor: nextCursor, has_more: hasMore && nextCursor === lastRead };
  }

  private async settleSeconds(now: Date): Promise<number> {
    if (this.options?.settleSeconds !== undefined) return this.options.settleSeconds;
    const value = await currentSettingValue(this.db, {
      key: 'sync.pull_settle_seconds',
      scopeType: 'GLOBAL',
      scopeId: null,
      at: now,
    });
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : PULL_SETTLE_DEFAULT_SECONDS;
  }

  /**
   * Dernier pull de l'appareil (ligne `_device`) et de l'auteur (`_a:<utilisateur>`) : `last_pull_at`
   * (dictionnaire `sync.device_sync_state`), base de la fraîcheur d'un appareil (P5-19, AV-202) — une
   * tablette en ligne mais sans rien à envoyer tire le flux sans jamais pousser. Écrit pour un appareil
   * connu seulement (`INSERT … SELECT`) ; aucune autre colonne n'est touchée (BR-DIS-014 lit
   * `last_push_at`).
   */
  private async recordPull(ctx: SyncPullContext): Promise<void> {
    const deviceId = toBin(ctx.authenticatedDeviceId);
    for (const dataset of [DEVICE_DATASET, authorDataset(ctx.authenticatedUserId)]) {
      await sql`
        INSERT INTO sync_device_sync_state (device_id, dataset, last_pull_at)
        SELECT d.id, ${dataset}, ${ctx.now} FROM identity_devices d WHERE d.id = ${deviceId}
        ON DUPLICATE KEY UPDATE last_pull_at = GREATEST(COALESCE(last_pull_at, ${ctx.now}), ${ctx.now})
      `.execute(this.db);
    }
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

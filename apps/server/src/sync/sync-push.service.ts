/**
 * `POST /api/v1/sync/push` (06-offline-sync/02-synchronisation.md §3, §9). Couche transport
 * (comme `commands/`) : orchestre un **lot** de commandes autour du même
 * {@link CommandPipelineService} que `/commands` (P0-06) — un push n'est rien d'autre que
 * plusieurs commandes `SYNC_PUSH`, traitées dans l'ordre de `device_seq`, chacune gardant sa
 * propre transaction (INV-SYN-05 : le rejet d'une commande ne touche jamais les autres).
 *
 * Verrou consultatif par appareil (INV-SYN-04, « traite séquentiellement... sous verrou
 * consultatif ») : approximé ici par l'attente séquentielle (jamais deux commandes du même
 * lot en vol à la fois — toujours vrai, un seul appareil par requête) plutôt qu'un verrou
 * SQL retenu across plusieurs transactions indépendantes (`command_id` PK + `(device_id,
 * device_seq)` UQ, INV-SYN-01/03, empêchent déjà toute double application entre deux
 * requêtes concurrentes du même appareil — un chevauchement produit un rejet `RETRY_LATER`
 * sur la commande en trop, jamais une corruption). Un vrai verrou inter-requêtes (verrou
 * nommé MySQL sur une connexion dédiée, hors du pool Kysely) reste un raffinement possible,
 * non nécessaire à la correction — DÉDUIT, paramétrable plus tard (règle CLAUDE.md #2).
 *
 * Tablette partagée (P5-07, AV-007, BR-SYN-014) : un appareil a **un seul** compteur `device_seq`
 * mais plusieurs auteurs, et chacun pousse sa part de la file avec sa propre session (le pipeline
 * rejette définitivement un auteur différent de la session authentifiée). Les lots de deux auteurs
 * s'entrecroisent donc dans la suite des `device_seq` : l'ordre garanti est celui de chaque couple
 * (appareil, auteur) — INV-SYN-04 reformulé —, jamais celui de l'arrivée entre auteurs, dont
 * rien ne doit dépendre (session de caisse et quota s'attribuent par `occurred_at`, ADR-032 et
 * ADR-033). `last_device_seq` est le **maximum** reçu, pas le dernier d'un lot ; et l'appareil
 * déclare ce qu'il lui reste à envoyer, par auteur (`pending_by_author`) : c'est ce que lit la
 * règle « l'ancien appareil a tout synchronisé » (BR-DIS-014).
 */
import { Inject, Injectable } from '@nestjs/common';
import { isClockSkewSuspect, type Clock } from '@gic/domain';
import type { CommandResult, PushRequest, PushResponse } from '@gic/contracts';
import { sql } from 'kysely';
import { CommandPipelineService } from '../commands/command-pipeline.service.js';
import { CLOCK } from '../platform/clock.provider.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { toBin } from '../platform/kysely/uuid-columns.js';

export interface SyncPushContext {
  readonly authenticatedUserId: string;
  readonly authenticatedDeviceId: string;
  /** Un par lot (P0-16, 09-non-functional/02-observabilite.md §1), partagé par toutes les
   * commandes de ce `/sync/push` — jamais un par commande à l'intérieur du lot. */
  readonly correlationId?: string | undefined;
}

@Injectable()
export class SyncPushService {
  constructor(
    @Inject(CommandPipelineService) private readonly pipeline: CommandPipelineService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async push(request: PushRequest, ctx: SyncPushContext): Promise<PushResponse> {
    const receivedAt = this.clock.now();
    const deviceSentAt = new Date(request.device_sent_at);
    const clockSkewMs = receivedAt.getTime() - deviceSentAt.getTime();
    const clockSuspect = isClockSkewSuspect(clockSkewMs);

    // Ordre croissant de device_seq (§3.1) : le lot peut arriver dans le désordre du
    // transport (HTTP ne le garantit pas), le serveur l'impose lui-même.
    const ordered = [...request.commands].sort((a, b) => a.device_seq - b.device_seq);

    const results: CommandResult[] = [];
    let highestDeviceSeq: number | null = null;
    for (const raw of ordered) {
      const result = await this.pipeline.handle(raw, {
        authenticatedUserId: ctx.authenticatedUserId,
        authenticatedDeviceId: ctx.authenticatedDeviceId,
        transport: 'SYNC_PUSH',
        deviceSentAt,
        batchId: request.batch_id,
        clockSkewMs,
        correlationId: ctx.correlationId,
      });
      results.push(clockSuspect ? withClockSuspectWarning(result) : result);
      highestDeviceSeq = Math.max(highestDeviceSeq ?? raw.device_seq, raw.device_seq);
    }

    await this.recordDeviceSyncState(ctx, {
      lastPushAt: this.clock.now(),
      highestDeviceSeq,
      lastClockSkewMs: clockSkewMs,
      pendingByAuthor: request.pending_by_author,
    });

    return {
      results,
      server_time: this.clock.now().toISOString(),
      clock_skew_ms: clockSkewMs,
    };
  }

  /**
   * État technique de synchronisation de l'appareil (dictionnaire sync.device_sync_state) :
   * - ligne `_device` : dernier envoi, plus grand `device_seq` reçu, décalage d'horloge et total des
   *   opérations restantes déclaré (`NULL` = non déclaré : le serveur ne suppose rien) ;
   * - une ligne `_a:<utilisateur>` par auteur (tablette partagée) : son dernier envoi, son plus grand
   *   `device_seq` et ses opérations restantes. Quand l'appareil déclare ses restes, un auteur déjà
   *   connu et absent de la déclaration n'a plus rien en attente.
   */
  private async recordDeviceSyncState(
    ctx: SyncPushContext,
    fields: {
      readonly lastPushAt: Date;
      readonly highestDeviceSeq: number | null;
      readonly lastClockSkewMs: number;
      readonly pendingByAuthor: Readonly<Record<string, number>> | undefined;
    },
  ): Promise<void> {
    const deviceId = toBin(ctx.authenticatedDeviceId);
    const declared = fields.pendingByAuthor;
    const total =
      declared === undefined ? null : Object.values(declared).reduce((a, b) => a + b, 0);
    const maxSeq = (seq: number | null) =>
      seq === null
        ? sql<number>`last_device_seq`
        : sql<number>`GREATEST(COALESCE(last_device_seq, 0), ${seq})`;

    await this.db
      .insertInto('sync_device_sync_state')
      .values({
        device_id: deviceId,
        dataset: DEVICE_DATASET,
        last_push_at: fields.lastPushAt,
        last_device_seq: fields.highestDeviceSeq,
        last_clock_skew_ms: fields.lastClockSkewMs,
        pending_reported: total,
      })
      .onDuplicateKeyUpdate({
        last_push_at: fields.lastPushAt,
        last_device_seq: maxSeq(fields.highestDeviceSeq),
        last_clock_skew_ms: fields.lastClockSkewMs,
        pending_reported: total,
      })
      .execute();

    await this.db
      .insertInto('sync_device_sync_state')
      .values({
        device_id: deviceId,
        dataset: authorDataset(ctx.authenticatedUserId),
        last_push_at: fields.lastPushAt,
        last_device_seq: fields.highestDeviceSeq,
        last_clock_skew_ms: fields.lastClockSkewMs,
        pending_reported: declared?.[ctx.authenticatedUserId] ?? null,
      })
      .onDuplicateKeyUpdate({
        last_push_at: fields.lastPushAt,
        last_device_seq: maxSeq(fields.highestDeviceSeq),
        last_clock_skew_ms: fields.lastClockSkewMs,
        pending_reported: declared?.[ctx.authenticatedUserId] ?? null,
      })
      .execute();

    if (declared === undefined) return;
    const others = Object.entries(declared).filter(
      ([userId]) => userId !== ctx.authenticatedUserId,
    );
    for (const [userId, pending] of others) {
      await this.db
        .insertInto('sync_device_sync_state')
        .values({ device_id: deviceId, dataset: authorDataset(userId), pending_reported: pending })
        .onDuplicateKeyUpdate({ pending_reported: pending })
        .execute();
    }
    // Un auteur connu et absent de la déclaration n'a plus rien en attente.
    const declaredDatasets = Object.keys(declared).map(authorDataset);
    let cleared = this.db
      .updateTable('sync_device_sync_state')
      .set({ pending_reported: 0 })
      .where('device_id', '=', deviceId)
      .where('dataset', 'like', AUTHOR_DATASET_LIKE);
    if (declaredDatasets.length > 0) cleared = cleared.where('dataset', 'not in', declaredDatasets);
    await cleared.execute();
  }
}

/** Ligne technique par appareil (`dataset = '_device'`, dictionnaire sync.device_sync_state). */
export const DEVICE_DATASET = '_device';
/** Ligne technique par couple (appareil, auteur) : `_a:` suivi des 32 caractères hexadécimaux de l'utilisateur. */
export const AUTHOR_DATASET_PREFIX = '_a:';
/** Motif `LIKE` des lignes par auteur (le `_` est un joker de `LIKE` : échappé). */
const AUTHOR_DATASET_LIKE = String.raw`\_a:%`;

export function authorDataset(userId: string): string {
  return `${AUTHOR_DATASET_PREFIX}${userId.replace(/-/g, '')}`;
}

function withClockSuspectWarning(result: CommandResult): CommandResult {
  const existing = 'warnings' in result && result.warnings ? result.warnings : [];
  if (existing.includes('CLOCK_SUSPECT')) return result;
  return { ...result, warnings: [...existing, 'CLOCK_SUSPECT'] };
}

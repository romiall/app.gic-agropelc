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
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@gic/domain';
import type { CommandResult, PushRequest, PushResponse } from '@gic/contracts';
import { CommandPipelineService } from '../commands/command-pipeline.service.js';
import { CLOCK } from '../platform/clock.provider.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { toBin } from '../platform/kysely/uuid-columns.js';

/** |écart| > 5 min (§9) : jeton `CLOCK_SUSPECT` sur chaque résultat du lot. */
const CLOCK_SKEW_SUSPECT_MS = 5 * 60 * 1000;

export interface SyncPushContext {
  readonly authenticatedUserId: string;
  readonly authenticatedDeviceId: string;
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
    const clockSuspect = Math.abs(clockSkewMs) > CLOCK_SKEW_SUSPECT_MS;

    // Ordre croissant de device_seq (§3.1) : le lot peut arriver dans le désordre du
    // transport (HTTP ne le garantit pas), le serveur l'impose lui-même.
    const ordered = [...request.commands].sort((a, b) => a.device_seq - b.device_seq);

    const results: CommandResult[] = [];
    let lastDeviceSeq: number | null = null;
    for (const raw of ordered) {
      const result = await this.pipeline.handle(raw, {
        authenticatedUserId: ctx.authenticatedUserId,
        authenticatedDeviceId: ctx.authenticatedDeviceId,
        transport: 'SYNC_PUSH',
        deviceSentAt,
        batchId: request.batch_id,
        clockSkewMs,
      });
      results.push(clockSuspect ? withClockSuspectWarning(result) : result);
      lastDeviceSeq = raw.device_seq;
    }

    await this.touchDeviceSyncState(ctx.authenticatedDeviceId, {
      lastPushAt: this.clock.now(),
      lastDeviceSeq,
      lastClockSkewMs: clockSkewMs,
      pendingReported: request.commands.length,
    });

    return {
      results,
      server_time: this.clock.now().toISOString(),
      clock_skew_ms: clockSkewMs,
    };
  }

  /** Ligne technique par appareil (`dataset = '_device'`, dictionnaire sync.device_sync_state). */
  private async touchDeviceSyncState(
    deviceId: string,
    fields: {
      readonly lastPushAt: Date;
      readonly lastDeviceSeq: number | null;
      readonly lastClockSkewMs: number;
      readonly pendingReported: number;
    },
  ): Promise<void> {
    await this.db
      .insertInto('sync_device_sync_state')
      .values({
        device_id: toBin(deviceId),
        dataset: '_device',
        last_push_at: fields.lastPushAt,
        last_device_seq: fields.lastDeviceSeq,
        last_clock_skew_ms: fields.lastClockSkewMs,
        pending_reported: fields.pendingReported,
      })
      .onDuplicateKeyUpdate({
        last_push_at: fields.lastPushAt,
        last_device_seq: fields.lastDeviceSeq,
        last_clock_skew_ms: fields.lastClockSkewMs,
        pending_reported: fields.pendingReported,
      })
      .execute();
  }
}

function withClockSuspectWarning(result: CommandResult): CommandResult {
  const existing = 'warnings' in result && result.warnings ? result.warnings : [];
  if (existing.includes('CLOCK_SUSPECT')) return result;
  return { ...result, warnings: [...existing, 'CLOCK_SUSPECT'] };
}

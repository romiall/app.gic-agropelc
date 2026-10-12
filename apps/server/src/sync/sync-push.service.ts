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
 * SQL retenu across plusieurs transactions indépendantes. Entre deux requêtes concurrentes du
 * même appareil (renvoi pendant qu'un envoi précédent tourne encore), la double application est
 * empêchée commande par commande : `command_id` PK et `(device_id, device_seq)` UQ (INV-SYN-01/03),
 * et la réclamation par tentative du pipeline (P5-21, revue adverse : toute conclusion de l'inbox
 * est conditionnée au numéro de tentative, la transaction métier verrouille d'abord la ligne
 * d'inbox) — la commande en trop reçoit `RETRY_LATER`. Un vrai verrou inter-requêtes (verrou
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
import { Inject, Injectable, Optional } from '@nestjs/common';
import { isClockSkewSuspect, type Clock } from '@gic/domain';
import type { CommandResult, PushRequest, PushResponse } from '@gic/contracts';
import { sql } from 'kysely';
import { CommandPipelineService } from '../commands/command-pipeline.service.js';
import { CLOCK } from '../platform/clock.provider.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { toBin } from '../platform/kysely/uuid-columns.js';

/**
 * Délai maximal de traitement d'un lot (02-synchronisation.md §3.1) : au-delà, les commandes restantes
 * ne sont ni traitées ni enregistrées et reçoivent `RETRY_LATER` (`SERVER_BUSY`). Valeur du protocole,
 * pas un seuil métier ; réglable pour les tests.
 */
export const SYNC_BATCH_DEADLINE_MS = 25_000;
export const SYNC_PUSH_OPTIONS = Symbol('SYNC_PUSH_OPTIONS');
export interface SyncPushOptions {
  readonly batchDeadlineMs?: number;
}

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
    @Optional() @Inject(SYNC_PUSH_OPTIONS) private readonly options?: SyncPushOptions,
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
    // INV-SYN-04 (P5-21, AV-210) : le lot n'a qu'un auteur ; dès qu'une commande doit être renvoyée
    // (`RETRY_LATER` : dépendance pas encore reçue, erreur transitoire), les suivantes ne sont pas
    // traitées — sinon une libération de quota ou une clôture passerait avant la vente qu'elle suit.
    // Elles ne sont pas enregistrées (rien n'est « reçu ») et l'appareil les renvoie dans l'ordre.
    // Exception (AV-217) : une commande bloquée depuis plus de `sync.retry_hold_minutes`
    // (`COMMAND_STALLED`) ne retient plus la suite ; elle reste à renvoyer et elle est signalée.
    let held = false;
    let overdue = false;
    const startedAt = performance.now();
    const deadlineMs = this.options?.batchDeadlineMs ?? SYNC_BATCH_DEADLINE_MS;
    for (const raw of ordered) {
      if (held) {
        results.push(heldResult(raw));
        continue;
      }
      // §3.1 : délai du lot dépassé — la suite n'est ni traitée ni enregistrée, dans l'ordre.
      if (overdue || performance.now() - startedAt > deadlineMs) {
        overdue = true;
        results.push(overdueResult(raw));
        continue;
      }
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
      if (result.status === 'RETRY_LATER' && result.error?.code !== 'COMMAND_STALLED') held = true;
    }

    // BR-DIS-014 : ce qui reste à envoyer comprend ce que ce lot n'a pas réglé (`RETRY_LATER` : à
    // renvoyer, suspendu, hors délai), que l'appareil comptait comme parti (revue de P5-21).
    const unsettled = results.filter((result) => result.status === 'RETRY_LATER').length;
    await this.recordDeviceSyncState(ctx, {
      lastPushAt: this.clock.now(),
      highestDeviceSeq,
      lastClockSkewMs: clockSkewMs,
      pendingByAuthor: request.pending_by_author,
      unsettled,
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
      /** Commandes de ce lot que le serveur n'a pas réglées (`RETRY_LATER`), de l'auteur du lot. */
      readonly unsettled: number;
    },
  ): Promise<void> {
    const deviceId = toBin(ctx.authenticatedDeviceId);
    const declared = fields.pendingByAuthor;
    // Sans déclaration, rien n'est supposé — sauf ce que le serveur sait encore à renvoyer.
    const known = (count: number | null) =>
      count === null && fields.unsettled === 0 ? null : (count ?? 0) + fields.unsettled;
    const total = known(
      declared === undefined ? null : Object.values(declared).reduce((a, b) => a + b, 0),
    );
    const authorPending = known(
      declared === undefined ? null : (declared[ctx.authenticatedUserId] ?? 0),
    );
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
        pending_reported: authorPending,
      })
      .onDuplicateKeyUpdate({
        last_push_at: fields.lastPushAt,
        last_device_seq: maxSeq(fields.highestDeviceSeq),
        last_clock_skew_ms: fields.lastClockSkewMs,
        pending_reported: authorPending,
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
    // Un auteur connu et absent de la déclaration n'a plus rien en attente (sauf l'auteur du lot, écrit
    // ci-dessus avec ce que le serveur n'a pas réglé).
    const declaredDatasets = [...Object.keys(declared), ctx.authenticatedUserId].map(authorDataset);
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

/** Commande d'un lot suspendu derrière une commande à renvoyer : ni traitée, ni enregistrée. */
function heldResult(raw: PushRequest['commands'][number]): CommandResult {
  return {
    command_id: raw.command_id,
    status: 'RETRY_LATER',
    error: {
      code: 'PRECEDING_COMMAND_PENDING',
      message_fr: 'Une commande précédente de la file doit d’abord être renvoyée.',
    },
  };
}

/** Commande d'un lot dont le délai de traitement est dépassé : ni traitée, ni enregistrée (§3.1). */
function overdueResult(raw: PushRequest['commands'][number]): CommandResult {
  return {
    command_id: raw.command_id,
    status: 'RETRY_LATER',
    error: {
      code: 'SERVER_BUSY',
      message_fr: 'Délai de traitement du lot dépassé : commande non traitée, à renvoyer.',
    },
  };
}

function withClockSuspectWarning(result: CommandResult): CommandResult {
  const existing = 'warnings' in result && result.warnings ? result.warnings : [];
  if (existing.includes('CLOCK_SUSPECT')) return result;
  return { ...result, warnings: [...existing, 'CLOCK_SUSPECT'] };
}

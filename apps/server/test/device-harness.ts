/**
 * Harnais multi-appareils (P5-07 ; 09-non-functional/03-plan-de-tests.md §3, AV-007) : un appareil
 * virtuel **générique**, au-delà de `VirtualDevice` (P0-15), qui ne sait construire qu'une commande
 * (`organization.setting.set`) et dont le compteur de séquence est propre à l'instance. Celui-ci
 * reproduit ce que fait un appareil réel de bout en bout, contre les vrais services de
 * synchronisation du serveur (`SyncPushService`, `SyncPullService`) :
 *
 * - une **file d'attente** unique (outbox) et **un seul compteur `device_seq`** par appareil, quel
 *   que soit l'auteur : sur une tablette partagée (AV-007) plusieurs utilisateurs y ajoutent des
 *   commandes, chacun les pousse ensuite avec **sa propre session** (BR-SYN-014) ;
 * - des **lots par auteur**, de 50 commandes au plus, en ordre de `device_seq`, qui déclarent ce
 *   qu'il reste dans la file après le lot, par auteur (`pending_by_author`) ;
 * - la **coupure réseau** (rien ne part), la **perte de réponse** (le serveur a traité le lot mais
 *   l'appareil ne le sait pas : la file est renvoyée à l'identique, sans nouveau `command_id`) ;
 * - la **projection locale** par jeu de données, comme `VirtualDevice`.
 *
 * Une commande n'est retirée de la file que lorsque sa réponse a été reçue et n'est pas
 * `RETRY_LATER` ; la révocation de l'appareil en cours de journée se pilote côté test, avec la
 * commande d'administration voulue sur le même pipeline (c'est le serveur qui décide, selon
 * l'`occurred_at` de chaque commande, RC-02).
 */
import type { Clock } from '@gic/domain';
import type { CommandResult, PushRequest, RawCommandEnvelope } from '@gic/contracts';
import type { SyncPullService } from '../src/sync/sync-pull.service.js';
import type { SyncPushService } from '../src/sync/sync-push.service.js';
import { freshUuid } from './helpers.js';

export interface CommandSpec {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId?: string;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly dependsOn?: readonly string[];
  readonly baseVersion?: number | null;
  /** Vrai par défaut : la commande a été saisie hors ligne. */
  readonly capturedOffline?: boolean;
  readonly backdatedReason?: string | null;
}

export interface QueuedCommand {
  readonly envelope: RawCommandEnvelope;
  readonly author: string;
  /** Dernière réponse reçue ; une réponse `RETRY_LATER` laisse la commande dans la file. */
  result?: CommandResult;
  settled: boolean;
}

/** L'envoi n'a pas abouti (coupure, ou réponse perdue après traitement par le serveur). */
export class NetworkDownError extends Error {
  constructor(readonly reason: 'OFFLINE' | 'RESPONSE_LOST') {
    super(reason === 'OFFLINE' ? 'Appareil hors réseau.' : 'Réponse du serveur perdue.');
  }
}

export interface DeviceServices {
  readonly push: SyncPushService;
  readonly pull: SyncPullService;
}

export class OfflineDevice {
  private seq = 0;
  private lostResponses = 0;
  private networkUp = true;
  private readonly queue: QueuedCommand[] = [];
  private readonly cursors = new Map<string, number>();
  readonly localProjection = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly services: DeviceServices,
    readonly deviceId: string,
    private readonly clock: Clock,
  ) {}

  // --- File d'attente ---------------------------------------------------------------------------

  /** `device_seq` suivant : un seul compteur par appareil, partagé par tous ses auteurs. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Une commande de `author`, mise dans la file avec le prochain `device_seq` de l'appareil. */
  enqueue(author: string, spec: CommandSpec): RawCommandEnvelope {
    const envelope: RawCommandEnvelope = {
      command_id: freshUuid(),
      device_seq: this.nextSeq(),
      command_type: spec.type,
      command_version: 1,
      author_user_id: author,
      aggregate_type: spec.aggregateType,
      aggregate_id: spec.aggregateId ?? freshUuid(),
      base_version: spec.baseVersion ?? null,
      depends_on: [...(spec.dependsOn ?? [])],
      occurred_at: spec.occurredAt,
      client_created_at: spec.occurredAt,
      captured_offline: spec.capturedOffline ?? true,
      backdated_reason: spec.backdatedReason ?? null,
      attachment_ids: [],
      payload: spec.payload,
    };
    this.queue.push({ envelope, author, settled: false });
    return envelope;
  }

  /** Commandes qui restent à envoyer pour `author` (toute la file si omis). */
  pending(author?: string): number {
    return this.queue.filter((q) => !q.settled && (author === undefined || q.author === author))
      .length;
  }

  pendingByAuthor(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const q of this.queue) {
      counts[q.author] ??= 0;
      if (!q.settled) counts[q.author] = (counts[q.author] ?? 0) + 1;
    }
    return counts;
  }

  /** Dernière réponse reçue pour une commande, `undefined` tant qu'elle n'en a pas eu. */
  resultOf(commandId: string): CommandResult | undefined {
    return this.queue.find((q) => q.envelope.command_id === commandId)?.result;
  }

  // --- Réseau -----------------------------------------------------------------------------------

  goOffline(): void {
    this.networkUp = false;
  }

  goOnline(): void {
    this.networkUp = true;
  }

  /** Les `count` prochains envois seront traités par le serveur, mais leur réponse n'arrivera pas. */
  loseNextResponses(count = 1): void {
    this.lostResponses = count;
  }

  // --- Envoi ------------------------------------------------------------------------------------

  /**
   * Envoie la part de la file de `author`, par lots de `batchSize` au plus, jusqu'à ce qu'il n'y ait
   * plus rien à envoyer pour lui, qu'un envoi échoue (levée de {@link NetworkDownError}) ou que
   * `maxBatches` soit atteint. Renvoie les réponses reçues dans l'ordre des envois.
   */
  async sync(
    author: string,
    options: { readonly batchSize?: number; readonly maxBatches?: number } = {},
  ): Promise<CommandResult[]> {
    const batchSize = Math.min(options.batchSize ?? 50, 50);
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const received: CommandResult[] = [];
    for (let batches = 0; batches < maxBatches; batches++) {
      if (!this.networkUp) throw new NetworkDownError('OFFLINE');
      const batch = this.queue
        .filter((q) => !q.settled && q.author === author)
        .sort((a, b) => a.envelope.device_seq - b.envelope.device_seq)
        .slice(0, batchSize);
      if (batch.length === 0) break;

      const response = await this.services.push.push(this.pushRequest(batch), {
        authenticatedUserId: author,
        authenticatedDeviceId: this.deviceId,
      });
      if (this.lostResponses > 0) {
        this.lostResponses -= 1;
        throw new NetworkDownError('RESPONSE_LOST');
      }
      let retry = false;
      for (const result of response.results) {
        const queued = batch.find((q) => q.envelope.command_id === result.command_id);
        if (!queued) continue;
        queued.result = result;
        if (result.status === 'RETRY_LATER') retry = true;
        else queued.settled = true;
        received.push(result);
      }
      // Une réponse « réessayer plus tard » n'est pas renvoyée en boucle serrée : au prochain cycle.
      if (retry) break;
    }
    return received;
  }

  /** Chaque auteur ayant quelque chose à envoyer pousse sa part, dans l'ordre de sa première commande. */
  async syncAll(options: { readonly batchSize?: number } = {}): Promise<CommandResult[]> {
    const authors = [
      ...new Set(
        this.queue
          .filter((q) => !q.settled)
          .sort((a, b) => a.envelope.device_seq - b.envelope.device_seq)
          .map((q) => q.author),
      ),
    ];
    const received: CommandResult[] = [];
    for (const author of authors) {
      received.push(...(await this.sync(author, options)));
    }
    return received;
  }

  /** Lot tel que l'appareil le déclare : ce qui restera dans la file après lui, par auteur. */
  private pushRequest(batch: readonly QueuedCommand[]): PushRequest {
    const inBatch = new Set(batch.map((q) => q.envelope.command_id));
    const remaining: Record<string, number> = {};
    for (const q of this.queue) {
      remaining[q.author] ??= 0;
      if (!q.settled && !inBatch.has(q.envelope.command_id)) {
        remaining[q.author] = (remaining[q.author] ?? 0) + 1;
      }
    }
    return {
      device_id: this.deviceId,
      batch_id: freshUuid(),
      device_sent_at: this.clock.now().toISOString(),
      commands: batch.map((q) => q.envelope),
      pending_by_author: remaining,
    };
  }

  // --- Téléchargement ---------------------------------------------------------------------------

  /** Vide un jeu de données jusqu'à `has_more = false` pour `author`, met à jour la projection locale. */
  async pullAll(dataset: string, author: string, now: Date): Promise<void> {
    for (;;) {
      const cursor = this.cursors.get(dataset) ?? 0;
      const response = await this.services.pull.pull(
        { dataset, cursor, limit: 500 },
        { authenticatedUserId: author, authenticatedDeviceId: this.deviceId, now },
      );
      for (const change of response.changes) {
        const key = `${change.dataset}:${change.entity_type}:${change.entity_id}`;
        if (change.change_type === 'UPSERT' && change.data) {
          this.localProjection.set(key, change.data);
        } else {
          this.localProjection.delete(key);
        }
      }
      this.cursors.set(dataset, response.next_cursor);
      if (!response.has_more) break;
    }
  }
}

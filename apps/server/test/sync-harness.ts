/**
 * Harnais de synchronisation (P0-15 ; 09-non-functional/03-plan-de-tests.md §3) : « N
 * appareils virtuels (clients de la bibliothèque de synchronisation réelle, stockage en
 * mémoire) contre un serveur de test », pilotant coupures, rejeux, désordre et horloges
 * décalées, puis vérifiant l'égalité de l'état local de chaque appareil avec le serveur
 * après un pull complet.
 *
 * « Bibliothèque de synchronisation réelle » est pris ici au sens du **protocole**
 * (`@gic/contracts`, les mêmes `SyncPushService`/`SyncPullService` que `/sync/push`,
 * `/sync/pull`) : `apps/pwa` a sa propre implémentation du client (Dexie, IndexedDB), non
 * réutilisable côté serveur (frontières d'application, K1) ; `VirtualDevice` ci-dessous
 * reproduit la même forme d'état côté appareil (`device_seq` croissant, curseur par jeu de
 * données, projection locale par clé) que `apps/pwa/src/sync/`, sans en partager le code.
 *
 * Commande de démonstration : `organization.setting.set`, la même que désigne le plan de
 * développement (§3, « Une commande de démonstration (organization.setting.set) … traverse
 * tout le pipeline ») — pas une commande `test.*` inventée pour l'occasion.
 */
import type { Clock, IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import type { Database } from '../src/platform/kysely/database.provider.js';
import type { PushResponse, RawCommandEnvelope } from '@gic/contracts';
import { freshUuid } from './helpers.js';

export const SETTING_DATASET = 'setting';
export const SETTING_PERMISSION = 'org.settings.manage';

/** Registre minimal mais réel : le gestionnaire de production, pas une reconstitution. */
export function buildHarnessRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registerSettingCommands(registry);
  return registry;
}

export function buildHarnessServices(
  db: Database,
  clock: Clock,
  idGenerator: IdGenerator,
): { readonly push: SyncPushService; readonly pull: SyncPullService } {
  const pipeline = new CommandPipelineService(db, buildHarnessRegistry(), clock, idGenerator);
  return { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };
}

export interface VirtualDeviceContext {
  readonly authenticatedUserId: string;
  readonly authenticatedDeviceId: string;
}

/**
 * Un appareil virtuel : compteur `device_seq` propre, curseurs de pull par jeu de données,
 * projection locale (dernière donnée connue par clé `dataset:entity_type:entity_id`) — la
 * même forme d'état qu'un appareil réel, en mémoire, pour un test.
 */
export class VirtualDevice {
  private seq = 0;
  private readonly cursors = new Map<string, number>();
  readonly localProjection = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly services: { readonly push: SyncPushService; readonly pull: SyncPullService },
    readonly ctx: VirtualDeviceContext,
    private readonly clock: Clock,
  ) {}

  /** `device_seq` suivant, strictement croissant (comme `sync/outbox.ts` côté PWA). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  buildSettingCommand(overrides: {
    readonly key: string;
    readonly value?: unknown;
    readonly scopeType?: 'GLOBAL' | 'SITE' | 'ZONE' | 'ROLE';
    readonly scopeId?: string;
    readonly deviceSeq?: number;
    readonly occurredAt?: string;
    readonly aggregateId?: string;
  }): RawCommandEnvelope {
    const occurredAt = overrides.occurredAt ?? '2026-09-25T09:00:00.000Z';
    return {
      command_id: freshUuid(),
      device_seq: overrides.deviceSeq ?? this.nextSeq(),
      command_type: 'organization.setting.set',
      command_version: 1,
      author_user_id: this.ctx.authenticatedUserId,
      aggregate_type: 'SETTING',
      aggregate_id: overrides.aggregateId ?? freshUuid(),
      base_version: null,
      depends_on: [],
      occurred_at: occurredAt,
      client_created_at: occurredAt,
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: {
        key: overrides.key,
        value: overrides.value ?? true,
        scopeType: overrides.scopeType ?? 'GLOBAL',
        ...(overrides.scopeId !== undefined ? { scopeId: overrides.scopeId } : {}),
        isClientVisible: true,
      },
    };
  }

  /** Un envoi = un lot (comme `sync/push.ts` côté PWA : un appel HTTP par cycle). */
  async push(
    commands: readonly RawCommandEnvelope[],
    options: { readonly deviceSentAt?: string } = {},
  ): Promise<PushResponse> {
    return this.services.push.push(
      {
        device_id: this.ctx.authenticatedDeviceId,
        batch_id: freshUuid(),
        device_sent_at: options.deviceSentAt ?? this.clock.now().toISOString(),
        commands,
      },
      this.ctx,
    );
  }

  /**
   * Renvoie le même lot tant qu'au moins un résultat est `RETRY_LATER` (réponse perdue, ou
   * erreur transitoire réelle du serveur — §4 « reprise ») : ce qu'un appareil réel fait,
   * sans jamais fabriquer de nouveau `command_id` pour une commande déjà tentée.
   */
  async pushUntilSettled(
    commands: readonly RawCommandEnvelope[],
    options: { readonly deviceSentAt?: string; readonly maxAttempts?: number } = {},
  ): Promise<PushResponse> {
    const maxAttempts = options.maxAttempts ?? 10;
    let response = await this.push(commands, options);
    for (
      let attempt = 1;
      attempt < maxAttempts && response.results.some((r) => r.status === 'RETRY_LATER');
      attempt++
    ) {
      response = await this.push(commands, options);
    }
    return response;
  }

  /** Vide le jeu de données jusqu'à `has_more = false`, met à jour la projection locale. */
  async pullAll(dataset: string, now: Date): Promise<void> {
    for (;;) {
      const cursor = this.cursors.get(dataset) ?? 0;
      const response = await this.services.pull.pull(
        { dataset, cursor, limit: 500 },
        { ...this.ctx, now },
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

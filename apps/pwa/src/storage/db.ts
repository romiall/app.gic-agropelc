/**
 * Base locale Dexie (IndexedDB) — squelette P0-14 (06-offline-sync/01-architecture-
 * offline.md §2). Cinq magasins, alignés sur le tableau du §2 :
 *
 * - `outbox`      : commandes en attente (§5, structure conceptuelle de l'outbox) ;
 * - `projections` : état téléchargé par pull (`ref_*`/`scope_*` du §2, fusionnés ici en un
 *                   magasin générique — la spécialisation par jeu de données arrive avec les
 *                   modules qui la motivent, comme `sync_change_feed.dataset` côté serveur,
 *                   commentaire de `command-pipeline.service.ts`) ;
 * - `sync_state`  : curseurs par jeu, `device_seq`, écart d'horloge (non chiffré, §2) ;
 * - `session`     : jetons **chiffrés** par la clé dérivée du PIN (`storage/crypto.ts`) ;
 * - `pin_lock`    : sel PBKDF2 et compteur d'échecs du PIN, par utilisateur (BR-ADM-024) —
 *                   distinct de `session` car lisible avant déverrouillage (déterminer quel
 *                   écran afficher n'exige pas de posséder déjà la clé dérivée).
 *
 * Migrations versionnées (Dexie `version()`) dès la première version, comme l'exige la
 * stack (05-stack.md §2.2) même si une seule version existe pour l'instant.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { DeviceSyncState } from '@gic/contracts';

export const OUTBOX_STATUSES = [
  'LOCAL_ONLY',
  'PENDING_SYNC',
  'SYNCING',
  'SYNCED',
  'SYNCED_WITH_WARNING',
  'CONFLICT',
  'REJECTED',
] as const satisfies readonly DeviceSyncState[];

export interface OutboxCommand {
  readonly command_id: string;
  readonly device_seq: number;
  readonly command_type: string;
  readonly command_version: number;
  readonly author_user_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly base_version: number | null;
  readonly depends_on: readonly string[];
  readonly occurred_at: string;
  readonly client_created_at: string;
  readonly captured_offline: boolean;
  readonly backdated_reason: string | null;
  readonly attachment_ids: readonly string[];
  readonly payload: unknown;
  status: DeviceSyncState;
  attempts: number;
  next_attempt_at: string | null;
  last_error: { readonly code: string; readonly message_fr: string } | null;
  server_refs: Record<string, string> | null;
}

/** Une ligne par `(dataset, entity_type, entity_id)` : projection de l'état courant reçu. */
export interface Projection {
  readonly key: string; // `${dataset}:${entity_type}:${entity_id}`
  readonly dataset: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly scope_type: string;
  readonly scope_id: string | null;
  readonly row_version: number;
  readonly data: Record<string, unknown>;
  readonly seq: number;
}

export interface SyncCursor {
  readonly dataset: string; // clé primaire
  readonly cursor: number;
}

export interface SyncMeta {
  readonly key: 'device'; // singleton
  device_id: string;
  clock_skew_ms: number | null;
  last_sync_at: string | null;
}

export interface SessionRecord {
  readonly key: 'current'; // singleton
  user_id: string;
  device_status: 'PENDING' | 'ACTIVE';
  /** `refresh_token` chiffré (AES-GCM, clé dérivée du PIN) ; jamais en clair au repos. */
  encrypted_refresh_token: string;
  iv: string;
}

export interface PinLock {
  readonly user_id: string; // clé primaire : un PIN par utilisateur sur cet appareil
  salt: string;
  iterations: number;
  failed_attempts: number;
}

export class GicDatabase extends Dexie {
  outbox!: EntityTable<OutboxCommand, 'command_id'>;
  projections!: EntityTable<Projection, 'key'>;
  syncCursors!: EntityTable<SyncCursor, 'dataset'>;
  syncMeta!: EntityTable<SyncMeta, 'key'>;
  session!: EntityTable<SessionRecord, 'key'>;
  pinLocks!: EntityTable<PinLock, 'user_id'>;

  constructor(name = 'gic-agropelc') {
    super(name);
    this.version(1).stores({
      outbox: 'command_id, device_seq, status',
      projections: 'key, dataset, [dataset+entity_type]',
      syncCursors: 'dataset',
      syncMeta: 'key',
      session: 'key',
      pinLocks: 'user_id',
    });
  }
}

let instance: GicDatabase | undefined;

/** Instance partagée (composition root) : une seule ouverture Dexie par onglet. */
export function getDb(): GicDatabase {
  instance ??= new GicDatabase();
  return instance;
}

/** Réservé aux tests : force une base isolée nommée, sans passer par le singleton. */
export function createTestDb(name: string): GicDatabase {
  return new GicDatabase(name);
}

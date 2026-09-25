/**
 * Outbox locale (06-offline-sync/01-architecture-offline.md §5) : chaque écriture, en ligne
 * ou hors ligne, passe par ici (principe O1 « un seul chemin d'écriture »). FIFO par
 * appareil : `device_seq` croît strictement (compteur tenu dans `sync_state`, jamais dérivé
 * du nombre de lignes de l'outbox — une commande `SYNCED` peut être purgée sans réutiliser sa
 * séquence).
 */
import type { GicDatabase, OutboxCommand } from '../storage/db.js';
import type { Clock, IdGenerator } from '@gic/domain';

export interface EnqueueInput {
  readonly authorUserId: string;
  readonly commandType: string;
  readonly commandVersion: number;
  readonly aggregateType: string;
  /** Omis pour une création : un nouvel UUIDv7 est alors généré (l'appareil choisit l'id). */
  readonly aggregateId?: string;
  readonly baseVersion?: number | null;
  readonly dependsOn?: readonly string[];
  readonly payload: unknown;
  readonly capturedOffline: boolean;
  readonly backdatedReason?: string | null;
  readonly attachmentIds?: readonly string[];
}

async function nextDeviceSeq(db: GicDatabase): Promise<number> {
  // Transaction Dexie englobante (voir enqueueCommand) : lecture-puis-écriture atomique,
  // pas de compteur séparé — la plus grande séquence déjà écrite en outbox suffit tant que
  // les lignes `SYNCED` ne sont purgées qu'après confirmation par le serveur (§5).
  const last = await db.outbox.orderBy('device_seq').last();
  return (last?.device_seq ?? 0) + 1;
}

export async function enqueueCommand(
  db: GicDatabase,
  deps: { readonly clock: Clock; readonly idGenerator: IdGenerator },
  input: EnqueueInput,
): Promise<OutboxCommand> {
  return db.transaction('rw', db.outbox, async () => {
    const now = deps.clock.now().toISOString();
    const deviceSeq = await nextDeviceSeq(db);
    const command: OutboxCommand = {
      command_id: deps.idGenerator.newId(),
      device_seq: deviceSeq,
      command_type: input.commandType,
      command_version: input.commandVersion,
      author_user_id: input.authorUserId,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId ?? deps.idGenerator.newId(),
      base_version: input.baseVersion ?? null,
      depends_on: input.dependsOn ?? [],
      occurred_at: now,
      client_created_at: now,
      captured_offline: input.capturedOffline,
      backdated_reason: input.backdatedReason ?? null,
      attachment_ids: input.attachmentIds ?? [],
      payload: input.payload,
      status: 'LOCAL_ONLY',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    };
    await db.outbox.put(command);
    return command;
  });
}

/** File d'attente à pousser : tout ce qui n'est pas encore confirmé, dans l'ordre FIFO. */
export async function pendingOutbox(db: GicDatabase, limit = 50): Promise<OutboxCommand[]> {
  return db.outbox
    .where('status')
    .anyOf(['LOCAL_ONLY', 'PENDING_SYNC'])
    .sortBy('device_seq')
    .then((rows) => rows.slice(0, limit));
}

export async function countPending(db: GicDatabase): Promise<number> {
  return db.outbox.where('status').anyOf(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING']).count();
}

export async function countAttention(db: GicDatabase): Promise<number> {
  return db.outbox.where('status').anyOf(['CONFLICT', 'REJECTED']).count();
}

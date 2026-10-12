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
  /** Indices locaux (hors enveloppe, jamais envoyés), voir `OutboxCommand.local_flags`. */
  readonly localFlags?: readonly string[];
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
      ...(input.localFlags && input.localFlags.length > 0
        ? { local_flags: [...input.localFlags] }
        : {}),
    };
    await db.outbox.put(command);
    return command;
  });
}

/** Statuts d'une commande qui n'a pas encore reçu de réponse définitive du serveur. */
const UNSETTLED: ReadonlySet<string> = new Set(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING']);

/**
 * File d'attente à pousser : tout ce qui n'est pas encore confirmé, dans l'ordre FIFO ; seulement les
 * commandes de `authorUserId` s'il est donné (le serveur n'accepte que celles de l'utilisateur
 * authentifié).
 *
 * Une commande dont une dépendance (`depends_on`) attend encore sa réponse sur l'appareil reste en
 * file : elle part au lot suivant, une fois la dépendance appliquée. Le serveur accepte aujourd'hui
 * une dépendance seulement reçue ou en échec passager, et la commande dépendante serait alors
 * refusée définitivement (S-17). Une dépendance refusée ou en conflit n'arrête pas l'envoi : le
 * serveur refuse alors la dépendante normalement (`DEPENDENCY_REJECTED`).
 */
export async function pendingOutbox(
  db: GicDatabase,
  limit = 50,
  authorUserId?: string,
): Promise<OutboxCommand[]> {
  const rows = await db.outbox
    .where('status')
    .anyOf(['LOCAL_ONLY', 'PENDING_SYNC'])
    .sortBy('device_seq');
  const candidates = rows.filter(
    (row) => authorUserId === undefined || row.author_user_id === authorUserId,
  );
  const dependencyIds = [...new Set(candidates.flatMap((row) => row.depends_on))];
  const dependencies =
    dependencyIds.length === 0
      ? []
      : await db.outbox.where('command_id').anyOf(dependencyIds).toArray();
  const unsettled = new Set(
    dependencies
      .filter((dependency) => UNSETTLED.has(dependency.status))
      .map((dependency) => dependency.command_id),
  );
  return candidates
    .filter((row) => row.depends_on.every((dependency) => !unsettled.has(dependency)))
    .slice(0, limit);
}

/**
 * Ce qui restera à envoyer **après** un lot, par auteur (tablette partagée, AV-007) : le serveur
 * en tire « cet appareil a tout synchronisé » (BR-DIS-014). Tout auteur présent dans la file ou
 * dans le lot figure dans le résultat, à zéro s'il ne lui reste rien.
 */
export async function pendingAfterBatch(
  db: GicDatabase,
  batch: readonly OutboxCommand[],
): Promise<Record<string, number>> {
  const inBatch = new Set(batch.map((c) => c.command_id));
  const remaining: Record<string, number> = {};
  for (const command of batch) remaining[command.author_user_id] = 0;
  const waiting = await db.outbox
    .where('status')
    .anyOf(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING'])
    .toArray();
  for (const command of waiting) {
    if (inBatch.has(command.command_id)) continue;
    remaining[command.author_user_id] = (remaining[command.author_user_id] ?? 0) + 1;
  }
  return remaining;
}

/**
 * Reprise après interruption : une commande restée `SYNCING` (onglet fermé ou appareil éteint pendant
 * l'envoi) n'a pas de réponse du serveur ; elle repart au prochain cycle. Le serveur est idempotent
 * (`command_id`) : un renvoi d'une commande déjà appliquée rend le même résultat.
 */
export async function resetInterruptedPushes(db: GicDatabase): Promise<number> {
  return db.outbox.where('status').equals('SYNCING').modify({ status: 'PENDING_SYNC' });
}

export async function countPending(db: GicDatabase): Promise<number> {
  return db.outbox.where('status').anyOf(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING']).count();
}

export async function countAttention(db: GicDatabase): Promise<number> {
  return db.outbox.where('status').anyOf(['CONFLICT', 'REJECTED']).count();
}

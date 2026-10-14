/**
 * Outbox locale (06-offline-sync/01-architecture-offline.md §5) : chaque écriture, en ligne
 * ou hors ligne, passe par ici (principe O1 « un seul chemin d'écriture »). FIFO par
 * appareil : `device_seq` croît strictement (compteur tenu dans `sync_state`, jamais dérivé
 * du nombre de lignes de l'outbox — une commande `SYNCED` peut être purgée sans réutiliser sa
 * séquence).
 */
import type { GicDatabase, OutboxCommand } from '../storage/db.js';
import type { Clock, IdGenerator } from '@gic/domain';
import { loadAutonomy, OfflineReadOnlyError } from '../features/sync/autonomy.js';

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

/**
 * Enregistre une opération dans l'outbox. Au-delà de l'autonomie hors connexion (AV-009, AV-242),
 * l'appareil est en lecture seule : l'opération est refusée (`OfflineReadOnlyError`) et rien n'est
 * enregistré, quel que soit l'écran qui l'enregistre ; les opérations déjà dans l'outbox partent.
 */
export async function enqueueCommand(
  db: GicDatabase,
  deps: { readonly clock: Clock; readonly idGenerator: IdGenerator },
  input: EnqueueInput,
): Promise<OutboxCommand> {
  // Hors de la transaction d'écriture : la mesure lit l'état de synchronisation et les paramètres.
  const autonomy = await loadAutonomy(db, deps.clock.now());
  if (autonomy.level === 'READ_ONLY') throw new OfflineReadOnlyError(autonomy.hours ?? 0);
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
 * Ordre strict par `device_seq`, dépendantes comprises (INV-SYN-04, AV-210, ADR-039) : le serveur
 * fait attendre une dépendance reçue mais pas encore réglée (`DEPENDENCY_PENDING`, S-17 levé) et
 * suspend la suite du lot après elle (`PRECEDING_COMMAND_PENDING`). Le lot s'arrête avant une
 * commande dont une dépendance **du même auteur** attend sans partir dans ce lot (commande bloquée
 * écartée de ce cycle), et avant toute commande plus récente qu'une commande de l'auteur encore en vol
 * (`SYNCING`). Une dépendance d'un autre utilisateur de la tablette n'arrête pas le lot (elle ne part
 * qu'à sa reconnexion : le lot attendrait sans fin) ; les écrans évitent de la créer. Une dépendance
 * refusée ou en conflit n'arrête pas l'envoi : le serveur refuse la dépendante
 * (`DEPENDENCY_REJECTED`). `skip` : commandes bloquées (`COMMAND_STALLED`) déjà renvoyées pendant ce
 * cycle, qui ne retiennent plus la suite (AV-217).
 */
export async function pendingOutbox(
  db: GicDatabase,
  limit = 50,
  authorUserId?: string,
  skip?: ReadonlySet<string>,
): Promise<OutboxCommand[]> {
  const rows = await db.outbox
    .where('status')
    .anyOf(['LOCAL_ONLY', 'PENDING_SYNC'])
    .sortBy('device_seq');
  const candidates = rows.filter(
    (row) =>
      (authorUserId === undefined || row.author_user_id === authorUserId) &&
      !skip?.has(row.command_id),
  );
  const dependencyIds = [...new Set(candidates.flatMap((row) => row.depends_on))];
  const dependencies =
    dependencyIds.length === 0
      ? []
      : await db.outbox.where('command_id').anyOf(dependencyIds).toArray();
  // Auteur de chaque dépendance encore sans réponse définitive sur l'appareil.
  const unsettled = new Map(
    dependencies
      .filter((dependency) => UNSETTLED.has(dependency.status))
      .map((dependency) => [dependency.command_id, dependency.author_user_id]),
  );
  // Commande de l'auteur encore en vol (lot d'un autre onglet, envoi interrompu) : rien de plus
  // récent ne part avant sa réponse, sinon le serveur l'appliquerait après une commande qui la suit.
  const inFlight = (await db.outbox.where('status').equals('SYNCING').toArray()).filter(
    (row) => authorUserId === undefined || row.author_user_id === authorUserId,
  );
  const firstInFlight = Math.min(...inFlight.map((row) => row.device_seq));
  const batch: OutboxCommand[] = [];
  const inBatch = new Set<string>();
  for (const row of candidates) {
    if (batch.length >= limit || row.device_seq > firstInFlight) break;
    // Dépendance de l'auteur écartée de ce lot (bloquée, déjà renvoyée) : la suite attend. Celle d'un
    // autre utilisateur de la tablette ne part qu'à sa reconnexion : la dépendante part quand même,
    // le serveur la fait attendre et suspend la suite au plus `sync.retry_hold_minutes`, puis la
    // déclare bloquée (`COMMAND_STALLED`, AV-217) et libère la file.
    const waitsOwn = row.depends_on.some(
      (dependency) => unsettled.get(dependency) === row.author_user_id && !inBatch.has(dependency),
    );
    if (waitsOwn) break;
    batch.push(row);
    inBatch.add(row.command_id);
  }
  return batch;
}

/**
 * Renvois consécutifs sans succès au-delà desquels une commande est signalée « en échec répété » :
 * elle reste réessayée, mais ne bloque plus l'écran qui l'a émise (`busy_retries`).
 */
export const REPEATED_FAILURE_ATTEMPTS = 3;

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
 * (`command_id`) : un renvoi d'une commande déjà appliquée rend le même résultat. `sentBefore` : seules
 * les commandes envoyées avant cette heure (ou sans heure d'envoi) sont reprises, celles d'un lot
 * encore en vol dans un autre onglet restent `SYNCING` (sans verrou entre onglets).
 */
export async function resetInterruptedPushes(
  db: GicDatabase,
  sentBefore?: string,
): Promise<number> {
  return db.outbox
    .where('status')
    .equals('SYNCING')
    .filter(
      (command) => sentBefore === undefined || !command.sent_at || command.sent_at < sentBefore,
    )
    .modify({ status: 'PENDING_SYNC' });
}

export async function countPending(db: GicDatabase): Promise<number> {
  return db.outbox.where('status').anyOf(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING']).count();
}

/**
 * Opération refusée ou en conflit que l'utilisateur a « classée » (MP-09, AV-283 ; BR-SYN-009 : visible
 * « jusqu'à ce que l'utilisateur en prenne connaissance » ; SM de la commande sur l'appareil :
 * `REJECTED → ACKNOWLEDGED`) : marquage local, jamais envoyé, la commande garde son statut et n'est pas
 * effacée (BR-SYN-013). `DISMISSED` et `REENTERED` sont posés par l'écran des transferts sur une
 * expédition refusée (ignorée ou ressaisie) : elle est aussi prise en compte.
 */
export const ACKNOWLEDGED_FLAG = 'ACKNOWLEDGED';
const SETTLED_FLAGS: readonly string[] = [ACKNOWLEDGED_FLAG, 'DISMISSED', 'REENTERED'];

/** Refusée ou en conflit, et pas encore prise en compte par l'utilisateur. */
export function needsAttention(command: OutboxCommand): boolean {
  if (command.status !== 'CONFLICT' && command.status !== 'REJECTED') return false;
  return !command.local_flags?.some((flag) => SETTLED_FLAGS.includes(flag));
}

/** Classe une opération refusée ou en conflit (marquage local seulement). */
export async function acknowledgeCommand(db: GicDatabase, commandId: string): Promise<boolean> {
  return db.transaction('rw', db.outbox, async () => {
    const command = await db.outbox.get(commandId);
    if (!command || !needsAttention(command)) return false;
    await db.outbox.update(commandId, {
      local_flags: [...(command.local_flags ?? []), ACKNOWLEDGED_FLAG],
    });
    return true;
  });
}

export async function countAttention(db: GicDatabase): Promise<number> {
  return db.outbox.where('status').anyOf(['CONFLICT', 'REJECTED']).filter(needsAttention).count();
}

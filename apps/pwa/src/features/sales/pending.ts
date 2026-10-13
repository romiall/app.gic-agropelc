/**
 * Opérations de l'appareil encore « en vol » pour un jeu téléchargé (ADR-037 §3) : en attente
 * d'envoi, ou acceptées par le serveur mais pas encore ramenées par un tirage complet du jeu qui porte
 * leur effet (01-architecture-offline.md §4 : « le delta est retiré quand le pull a ramené l'état
 * serveur qui l'inclut »). Logique pure, partagée par le disponible local (jeu `stock`), les
 * commandes et livraisons (jeu `orders`) et l'encours des clients (jeu `customers`).
 */
import type { OutboxCommand } from '../../storage/db.js';

export const WAITING_STATUSES: ReadonlySet<string> = new Set([
  'LOCAL_ONLY',
  'PENDING_SYNC',
  'SYNCING',
]);

export function isWaiting(command: Pick<OutboxCommand, 'status'>): boolean {
  return WAITING_STATUSES.has(command.status);
}

/**
 * Tablette partagée (AV-007) : vrai si l'une de ces commandes est celle d'un autre utilisateur et
 * attend encore son envoi. Elle ne part qu'à la reconnexion de son auteur (sa session envoie sa part
 * de la file) : une opération qui en dépendrait resterait suspendue au serveur, et la file de
 * l'utilisateur derrière elle (ADR-039). L'écran refuse de la créer.
 */
export function waitsForOtherUser(
  outbox: readonly Pick<OutboxCommand, 'command_id' | 'author_user_id' | 'status'>[],
  commandIds: readonly (string | null | undefined)[],
  userId: string | undefined,
): boolean {
  const ids = new Set(commandIds.filter((id): id is string => typeof id === 'string'));
  if (ids.size === 0) return false;
  return outbox.some(
    (command) =>
      ids.has(command.command_id) && command.author_user_id !== userId && isWaiting(command),
  );
}

/**
 * Commande en attente renvoyée par le serveur parce que l'appareil attend son approbation
 * (`RETRY_LATER` avec `DEVICE_PENDING`, AV-228) : elle s'appliquera après l'approbation ; au-delà de
 * `sync.retry_hold_minutes`, le serveur la déclare bloquée (`COMMAND_STALLED`).
 */
export function awaitsDeviceApproval(
  command: Pick<OutboxCommand, 'status' | 'last_error'>,
): boolean {
  return isWaiting(command) && command.last_error?.code === 'DEVICE_PENDING';
}

export function isAccepted(command: Pick<OutboxCommand, 'status'>): boolean {
  return command.status === 'SYNCED' || command.status === 'SYNCED_WITH_WARNING';
}

/** Vrai tant que l'effet de la commande n'est pas dans le jeu tiré à `pulledAt`. */
export function stillInFlight(
  command: Pick<OutboxCommand, 'status' | 'synced_at'>,
  pulledAt: string | undefined,
): boolean {
  if (isWaiting(command)) return true;
  if (!isAccepted(command) || !command.synced_at) return false;
  return pulledAt === undefined || pulledAt < command.synced_at;
}

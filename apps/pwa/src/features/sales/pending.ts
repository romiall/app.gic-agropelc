/**
 * Opérations de l'appareil encore « en vol » pour un jeu téléchargé (ADR-051 §3) : en attente
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

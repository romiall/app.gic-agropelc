/**
 * Commande à renvoyer qui ne se règle pas (P5-21, revue adverse ; AV-217) : au-delà de
 * `sync.retry_hold_minutes` depuis sa première réception, elle ne suspend plus la suite de son lot
 * (AV-210) — elle reste à renvoyer, jamais perdue (BR-SYN-007), et le signal `SYNC_COMMAND_STALLED`
 * est ouvert pour l'Admin. Sans version du paramètre à l'instant considéré : la valeur semée.
 */
export const RETRY_HOLD_DEFAULT_MINUTES = 30;

/** Durée lue dans `sync.retry_hold_minutes` ; une valeur absente ou invalide donne le défaut. */
export function retryHoldMinutesFrom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : RETRY_HOLD_DEFAULT_MINUTES;
}

/** Signal de la file des conflits (propriétaire Admin, sans effet métier). */
export const STALLED_CONFLICT_TYPE = 'SYNC_COMMAND_STALLED';
export const STALLED_ENTITY_TYPE = 'SYNC_COMMAND';

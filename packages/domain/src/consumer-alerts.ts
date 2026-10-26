/**
 * Règles pures de l'alerte `CONSUMER_FAILED` (P9-10 ; D13 §7.1, ADR-071 §12, ADR-078 §7, AV-412, AV-475) :
 * un consommateur d'événements en échec — un événement sauté après cinq essais, ou un retard de position
 * au-delà de `communication.consumer_lag_alert_seconds`. Sans entrée-sortie ; aucune fonction ne lève.
 */

/** Repli du retard toléré (ADR-078 §7 : volontairement au-dessus de la fenêtre de stabilisation de 120 s). */
export const DEFAULT_CONSUMER_LAG_ALERT_SECONDS = 300;
/** Plafond du retard toléré (dix ans, en secondes) : au-delà, l'alerte ne se lèverait jamais. */
export const MAX_CONSUMER_LAG_ALERT_SECONDS = 315_360_000;
/** Repli de la fenêtre des événements sautés (AV-475 : un jour). */
export const DEFAULT_CONSUMER_FAILURE_WINDOW_HOURS = 24;
/** Plafond de la fenêtre des événements sautés (dix ans) : au-delà, l'instant de coupure serait invalide. */
export const MAX_CONSUMER_FAILURE_WINDOW_HOURS = 87_600;

/** `communication.consumer_lag_alert_seconds` : un nombre fini strictement positif (plafonné), sinon 300. */
export function consumerLagAlertSecondsOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_CONSUMER_LAG_ALERT_SECONDS)
    : DEFAULT_CONSUMER_LAG_ALERT_SECONDS;
}

/** `communication.consumer_failure_window_hours` : un nombre fini strictement positif (plafonné), sinon 24. */
export function consumerFailureWindowHoursOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_CONSUMER_FAILURE_WINDOW_HOURS)
    : DEFAULT_CONSUMER_FAILURE_WINDOW_HOURS;
}

/**
 * Retard d'un consommateur, en secondes entières : l'âge (réception par la base) du plus ancien événement
 * qu'il n'a pas encore traité. `0` quand rien n'attend, ou quand cet événement est postérieur à l'instant de
 * mesure. Un consommateur au repos n'a pas de retard : l'inactivité ne se mesure pas.
 */
export function consumerLagSeconds(oldestPendingAt: Date | null, now: Date): number {
  if (oldestPendingAt === null) return 0;
  return Math.max(0, Math.floor((now.getTime() - oldestPendingAt.getTime()) / 1000));
}

export interface ConsumerAlarmInput {
  /** Événements sautés après échecs persistants dans la fenêtre glissante. */
  readonly failedEvents: number;
  readonly lagSeconds: number;
  /** `communication.consumer_lag_alert_seconds`. */
  readonly lagThresholdSeconds: number;
}

/**
 * Vrai si le consommateur est à signaler : au moins un événement sauté dans la fenêtre, **ou** un retard
 * strictement supérieur au seuil (un retard égal au seuil n'alerte pas : « au-delà de »).
 */
export function consumerInAlarm(input: ConsumerAlarmInput): boolean {
  return input.failedEvents >= 1 || input.lagSeconds > input.lagThresholdSeconds;
}

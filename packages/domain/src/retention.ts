/**
 * Règles pures des durées de conservation des purges techniques (P9-25, PF-1 et PF-7 ; ADR-068 §8,
 * 03-historisation-suppression.md §3 et §4 ; AV-470, AV-471). Sans entrée-sortie ; aucune fonction ne lève.
 *
 * Les durées sont des réglages de `organization.system_settings` (règle 8) : une valeur absente, non entière
 * ou non positive retombe sur le défaut documenté, jamais sur « conserver à jamais » ni sur « tout purger ».
 */

/** Un jour, en millisecondes (les instants de coupure se calculent en UTC : pas de changement d'heure). */
export const RETENTION_DAY_MS = 86_400_000;
/**
 * Plafond d'une durée de conservation (cent ans, en jours) : au-delà, l'instant de coupure sortirait de la plage
 * `DATETIME` de MySQL (à partir de l'an 1000) et la comparaison de date n'aurait plus de sens.
 */
export const MAX_RETENTION_DAYS = 36_500;
/** `communication.notification_retention_days` : notifications lues, 90 jours après la lecture (ADR-068 §8). */
export const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;
/** `communication.alert_retention_days` : alertes closes, deux ans (ADR-068 §8, AV-387, AV-470). */
export const DEFAULT_ALERT_RETENTION_DAYS = 730;
/**
 * Plancher de la conservation des alertes closes : le déclencheur `trg_communication_alerts_purge_guard`
 * (migration 20261201090100) refuse tout `DELETE` d'une alerte close depuis moins de 730 jours. Le réglage ne
 * peut donc que **allonger** cette durée ; la raccourcir demanderait une migration du déclencheur (AV-470).
 */
export const ALERT_RETENTION_FLOOR_DAYS = 730;
/** `platform.job_retention_days` : tâches terminées de la plateforme, 30 jours (PF-7, AV-472). */
export const DEFAULT_PLATFORM_JOB_RETENTION_DAYS = 30;
/** `platform.consumer_failure_retention_days` : événements sautés par un consommateur, 90 jours (PF-7, AV-472). */
export const DEFAULT_CONSUMER_FAILURE_RETENTION_DAYS = 90;

/** Durée en jours : un entier strictement positif (plafonné à `MAX_RETENTION_DAYS`), sinon `fallback`. */
export function retentionDaysOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_RETENTION_DAYS)
    : fallback;
}

/** `communication.alert_retention_days` : la durée valide, jamais en deçà du plancher du déclencheur (730 jours). */
export function alertRetentionDaysOrDefault(value: unknown): number {
  return Math.max(
    ALERT_RETENTION_FLOOR_DAYS,
    retentionDaysOrDefault(value, DEFAULT_ALERT_RETENTION_DAYS),
  );
}

/** Instant de coupure : ce qui est strictement antérieur est périmé (une ligne d'âge exact `days` est conservée). */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * RETENTION_DAY_MS);
}

/**
 * Coupure de la purge des événements sautés par un consommateur : jamais plus récente que la fenêtre de
 * l'alerte `CONSUMER_FAILED` (`communication.consumer_failure_window_hours`) — supprimer une ligne de la fenêtre
 * fermerait l'alerte d'un consommateur toujours en échec (PF-7).
 */
export function consumerFailurePurgeCutoff(
  now: Date,
  retentionDays: number,
  windowHours: number,
): Date {
  return new Date(
    Math.min(
      retentionCutoff(now, retentionDays).getTime(),
      now.getTime() - windowHours * 3_600_000,
    ),
  );
}

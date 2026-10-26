/**
 * Règles pures de l'alerte `ATTACHMENT_MISSING` (P9-07 pour les dépenses, P9-09 pour les réceptions ;
 * D13 §7.1, AV-357, AV-399, AV-417) : partagées par les tâches de `finance` (justificatifs de dépense) et de
 * `procurement` (photo du bon de livraison), sans entrée-sortie.
 *
 * Le délai se compte depuis la **réception par le serveur** du document (non la date du fait : un document
 * hors ligne ancien n'alerte pas dès sa synchronisation), borné par un horizon qui limite le balayage.
 */

/** Repli du délai de la pièce (D13 §7.1 : sept jours après la réception par le serveur). */
export const DEFAULT_ATTACHMENT_MISSING_ALERT_DAYS = 7;
/** Repli de l'horizon de revue (AV-399 : 90 jours). */
export const DEFAULT_ATTACHMENT_MISSING_HORIZON_DAYS = 90;
export const ATTACHMENT_DAY_MS = 86_400_000;
/** Plafond d'un délai ou d'un horizon (dix ans) : au-delà, la date de borne ne serait plus valide. */
export const MAX_ATTACHMENT_ALERT_DAYS = 3650;

/**
 * Entier positif ou nul lu d'un réglage, plafonné à dix ans ; une valeur absente ou invalide revient au
 * repli. **0 est une valeur** : pour le délai, il désactive l'alerte (les alertes ouvertes se ferment).
 */
export function wholeDaysOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_ATTACHMENT_ALERT_DAYS)
    : fallback;
}

/** `attachments.missing_alert_days` : 7 par défaut, 0 désactive. */
export function attachmentMissingAlertDaysOrDefault(value: unknown): number {
  return wholeDaysOrDefault(value, DEFAULT_ATTACHMENT_MISSING_ALERT_DAYS);
}

/**
 * Fenêtre de réception examinée : de `now − horizon` à `now − délai`. L'horizon (90 par défaut, une valeur
 * absente, nulle ou invalide revient au défaut) vaut au moins un jour de plus que le délai : une fenêtre
 * de largeur nulle ne détecterait plus rien et résoudrait toutes les alertes.
 */
export function attachmentScanWindow(
  now: Date,
  delayDays: number,
  horizonSetting: unknown,
): { readonly horizonDays: number; readonly newest: Date; readonly oldest: Date } {
  const horizonDays = Math.max(
    delayDays + 1,
    wholeDaysOrDefault(horizonSetting, DEFAULT_ATTACHMENT_MISSING_HORIZON_DAYS) ||
      DEFAULT_ATTACHMENT_MISSING_HORIZON_DAYS,
  );
  return {
    horizonDays,
    newest: new Date(now.getTime() - delayDays * ATTACHMENT_DAY_MS),
    oldest: new Date(now.getTime() - horizonDays * ATTACHMENT_DAY_MS),
  };
}

/** Jours entiers écoulés depuis la réception par le serveur (jamais négatifs). */
export function attachmentDaysMissing(receivedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - receivedAt.getTime()) / ATTACHMENT_DAY_MS));
}

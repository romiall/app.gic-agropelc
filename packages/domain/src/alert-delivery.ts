/**
 * Livraison des alertes : canaux par gravité, regroupement des push, escalade (P9 ; BR-NOT-004,
 * BR-NOT-005 ; D13 §14 ; ADR-062 §4, §6, §7 ; AV-364, AV-366, AV-367).
 *
 * Fonctions pures : le serveur fournit l'instant et les paramètres (`communication.push_group_minutes`,
 * `escalation_hours` de la règle).
 */
import type { AlertSeverity, AlertStatus } from './alerts.js';

export const NOTIFICATION_CHANNELS = ['IN_APP', 'WEB_PUSH'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Nature d'une notification : alerte, note de direction, notification directe d'un événement (AV-389), fin d'un export. */
export const NOTIFICATION_KINDS = ['ALERT', 'NOTE', 'DIRECT', 'EXPORT'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Délai d'escalade d'une alerte `CRITICAL` non prise en compte (BR-NOT-005). */
export const DEFAULT_ESCALATION_HOURS = 4;
/** Au plus un push par utilisateur et par type toutes les 15 minutes (D13 §14). */
export const DEFAULT_PUSH_GROUP_MINUTES = 15;

/**
 * Canaux d'une alerte selon sa gravité (BR-NOT-004) : `INFO` n'est visible que dans le centre
 * d'alertes (aucune notification), `WARNING` produit une notification in-app, `CRITICAL` aussi et un
 * push immédiat.
 */
export function notificationChannelsFor(severity: AlertSeverity): readonly NotificationChannel[] {
  switch (severity) {
    case 'INFO':
      return [];
    case 'WARNING':
      return ['IN_APP'];
    case 'CRITICAL':
      return ['IN_APP', 'WEB_PUSH'];
  }
}

export type PushGroupDecision =
  { readonly send: true } | { readonly send: false; readonly nextSlotAt: Date };

/**
 * Regroupement des push (D13 §14, AV-366) : le premier push d'un couple (utilisateur, type) part ; les
 * suivants, dans le créneau, restent en notification in-app et sont comptés au push du créneau suivant.
 * `lastPushAt` est l'instant du dernier push **envoyé** au couple.
 */
export function pushGroupDecision(input: {
  readonly lastPushAt: Date | null;
  readonly now: Date;
  readonly groupMinutes: number;
}): PushGroupDecision {
  const minutes =
    Number.isFinite(input.groupMinutes) && input.groupMinutes > 0
      ? input.groupMinutes
      : DEFAULT_PUSH_GROUP_MINUTES;
  if (input.lastPushAt === null) return { send: true };
  const nextSlot = new Date(input.lastPushAt.getTime() + minutes * 60_000);
  return input.now.getTime() >= nextSlot.getTime()
    ? { send: true }
    : { send: false, nextSlotAt: nextSlot };
}

/**
 * Échéance d'escalade : `critical_since` + `escalation_hours` (ADR-062 §7). `critical_since` est l'instant
 * où le serveur lève ou relève l'alerte en `CRITICAL`, non la date du fait (AV-466, NT-3).
 */
export function escalationDueAt(criticalSince: Date, escalationHours: number): Date {
  const hours =
    Number.isFinite(escalationHours) && escalationHours > 0
      ? escalationHours
      : DEFAULT_ESCALATION_HOURS;
  return new Date(criticalSince.getTime() + hours * 3_600_000);
}

export interface EscalationCandidate {
  readonly status: AlertStatus;
  readonly severity: AlertSeverity;
  /**
   * Instant où le serveur lève ou relève l'alerte en `CRITICAL`, non la date du fait (ADR-062 §7,
   * AV-466) : un fait en retard n'écoule pas d'avance le délai des destinataires.
   */
  readonly criticalSince: Date | null;
  readonly escalatedAt: Date | null;
}

/**
 * Une alerte est à escalader si elle est `CRITICAL`, encore `OPEN` (une prise en compte arrête
 * l'escalade, SM-ALERT), jamais escaladée (une seule fois) et que son échéance est passée.
 */
export function isEscalationDue(
  alert: EscalationCandidate,
  escalationHours: number,
  now: Date,
): boolean {
  return (
    alert.status === 'OPEN' &&
    alert.severity === 'CRITICAL' &&
    alert.escalatedAt === null &&
    alert.criticalSince !== null &&
    now.getTime() >= escalationDueAt(alert.criticalSince, escalationHours).getTime()
  );
}

/** Longueur maximale du corps d'une notification (colonne `communication_notifications.body`). */
export const NOTIFICATION_BODY_MAX = 1000;

/** Titre de la notification d'escalade : un autre message que celui de la levée, jamais regroupé (§7). */
export function escalationTitle(title: string): string {
  return `Escalade : ${title}`;
}

/**
 * Corps du push qui ouvre un nouveau créneau de regroupement : il compte les alertes du même type tues
 * dans le créneau précédent (D13 §14, AV-366). Borné à la longueur de la colonne.
 */
export function groupedPushBody(body: string, suppressed: number): string {
  if (!Number.isFinite(suppressed) || suppressed <= 0) return body;
  const count = Math.trunc(suppressed);
  const suffix = ` (+${count} autre${count > 1 ? 's' : ''} alerte${count > 1 ? 's' : ''} de ce type)`;
  return `${body.slice(0, NOTIFICATION_BODY_MAX - suffix.length)}${suffix}`;
}

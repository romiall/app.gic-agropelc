/**
 * Récurrence des tâches planifiées (P5-16 ; 05-architecture/01-architecture-logicielle.md
 * « Ordonnanceur… horaires en Africa/Douala » ; CLAUDE.md règle 7). Deux formes :
 *
 * - `INTERVAL` : créneaux d'un intervalle fixe, alignés sur l'origine des temps (une tâche horaire
 *   tombe à l'heure pile, quelle que soit l'heure de démarrage du worker) ;
 * - `DAILY` : une heure locale quotidienne `HH:MM` en Africa/Douala (UTC+1 fixe, sans heure d'été :
 *   un jour = 24 h, ADR-016), calculée sur le jour métier.
 *
 * Pur : l'ordonnanceur (platform) fournit l'instant présent et persiste le créneau suivant.
 */
import { businessDayOf, businessDayStartUtc, nextBusinessDay } from './business-day.js';
import { DomainError } from './errors.js';

export type RecurringSchedule =
  | { readonly kind: 'INTERVAL'; readonly intervalSeconds: number }
  | { readonly kind: 'DAILY'; readonly localTime: string };

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes depuis minuit d'une heure locale `HH:MM` ; lève si le format est invalide. */
export function localTimeMinutes(localTime: string): number {
  const match = LOCAL_TIME_RE.exec(localTime);
  if (!match) {
    throw new DomainError(
      `Heure locale invalide (attendu HH:MM) : ${localTime}`,
      'SCHEDULE_INVALID',
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Contrôle une récurrence (intervalle entier strictement positif, heure `HH:MM`) ; lève sinon. */
export function assertRecurringSchedule(schedule: RecurringSchedule): void {
  if (schedule.kind === 'INTERVAL') {
    if (!Number.isSafeInteger(schedule.intervalSeconds) || schedule.intervalSeconds <= 0) {
      throw new DomainError(
        `Intervalle invalide (secondes entières > 0) : ${schedule.intervalSeconds}`,
        'SCHEDULE_INVALID',
      );
    }
    return;
  }
  localTimeMinutes(schedule.localTime);
}

/**
 * Prochain créneau **strictement postérieur** à `now` : jamais le créneau courant, si bien qu'un
 * dépôt à l'instant exact d'un créneau ne le redépose pas. Après un arrêt prolongé, l'ordonnanceur
 * dépose une seule occurrence puis saute directement au créneau à venir (aucun rattrapage en rafale).
 */
export function nextRecurringRun(now: Date, schedule: RecurringSchedule): Date {
  assertRecurringSchedule(schedule);
  if (schedule.kind === 'INTERVAL') {
    const intervalMs = schedule.intervalSeconds * 1000;
    return new Date((Math.floor(now.getTime() / intervalMs) + 1) * intervalMs);
  }
  const offsetMs = localTimeMinutes(schedule.localTime) * 60_000;
  const today = businessDayOf(now);
  const todaySlot = businessDayStartUtc(today).getTime() + offsetMs;
  if (todaySlot > now.getTime()) return new Date(todaySlot);
  return new Date(businessDayStartUtc(nextBusinessDay(today)).getTime() + offsetMs);
}

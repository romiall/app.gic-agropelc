/**
 * Présence du personnel relevée sur la fiche papier PT (PP-E ; REQ-306, AV-313) : règles pures, identiques sur
 * l'appareil (contrôle avant l'envoi) et sur le serveur (contrôle à l'application de la commande).
 *
 * - **Semaine** : du lundi au dimanche, en jours métier de Douala (BR-ANA-002). La fiche PT couvre six jours
 *   (lundi à samedi) ; le dimanche reste admis pour qui travaille ce jour-là.
 * - **Un jour** s'écrit en heures (arrivée, départ) **ou** par un code d'absence, jamais les deux : le papier dit
 *   d'écrire le code « dans la case arrivée ». Un départ suppose une arrivée et la suit (heure de la journée,
 *   `HH:MM`) ; un travail de nuit à cheval sur minuit s'écrit sur deux jours.
 * - **Codes d'absence** : A absent, M maladie, C congé, R repos, MI mission hors zone.
 * - **Total d'heures** d'une personne : somme, par jour, de départ − arrivée ; un jour sans les deux heures ne
 *   compte pas (comme la colonne « Total heures » de la fiche).
 * Usage statistique et de suivi : ni paie ni discipline (AV-313).
 */
import {
  addBusinessDays,
  businessDayOf,
  isBusinessDay,
  isoWeekdayOfBusinessDay,
} from './business-day.js';

export const PRESENCE_ABSENCE_CODES = ['A', 'M', 'C', 'R', 'MI'] as const;
export type PresenceAbsenceCode = (typeof PRESENCE_ABSENCE_CODES)[number];

/** Libellés français des codes d'absence (légende de la fiche PT). */
export const PRESENCE_ABSENCE_LABELS: Readonly<Record<PresenceAbsenceCode, string>> = {
  A: 'Absent',
  M: 'Maladie',
  C: 'Congé',
  R: 'Repos',
  MI: 'Mission hors zone',
};

/** Personnes au plus par feuille reportée (la fiche papier en porte quatorze ; une feuille de plus est un autre report). */
export const PRESENCE_MAX_LINES = 50;

/** Jours d'une semaine de présence : lundi à dimanche. */
export const PRESENCE_WEEK_LENGTH = 7;

export function isPresenceAbsenceCode(value: unknown): value is PresenceAbsenceCode {
  return typeof value === 'string' && (PRESENCE_ABSENCE_CODES as readonly string[]).includes(value);
}

/** Vrai si `day` (`AAAA-MM-JJ`, jour métier valide) est un lundi. */
export function isMondayBusinessDay(day: string): boolean {
  return isBusinessDay(day) && isoWeekdayOfBusinessDay(day) === 1;
}

/** Lundi de la semaine du jour métier `day`. */
export function mondayOf(day: string): string {
  return addBusinessDays(day, 1 - isoWeekdayOfBusinessDay(day));
}

/**
 * Clé de comparaison du nom d'une personne sur une feuille : sans espaces aux bords, sans distinction de casse ni
 * d'accents (« Élise Ngô » et « elise ngo » sont la même personne : la fiche papier et le compte ne s'écrivent pas toujours
 * pareil). Une seule définition pour l'écran, le chargement par fichier et le serveur : une personne figure une fois par
 * feuille, et se rattache à un compte du même nom.
 */
export function personNameKey(name: string): string {
  return name.trim().normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
}

/**
 * Clé de comparaison du numéro d'une feuille papier (AV-514 (6)) : sans aucun espace, sans distinction de casse
 * (« pt 12 », « PT  12 » et « PT12 » sont la même feuille). Les autres signes comptent (« PT-12 » est un autre numéro).
 * `null` pour un numéro vide : une feuille sans numéro ne peut pas être reconnue comme une seconde saisie d'une autre.
 * Une seule définition pour l'écran et le serveur.
 */
export function paperRefKey(paperRef: string | null | undefined): string | null {
  const key = (paperRef ?? '').replace(/\s+/g, '').toLocaleUpperCase('fr');
  return key === '' ? null : key;
}

/**
 * Contrôle de la semaine d'une feuille reportée à l'instant `writtenAt` : un lundi, et pas après la semaine en cours
 * (une feuille se reporte pendant la semaine ou après, jamais avant). `null` si valable, sinon le motif en français.
 */
export function presenceWeekIssue(weekStart: string, writtenAt: Date): string | null {
  if (!isMondayBusinessDay(weekStart)) {
    return `La semaine d'une feuille de présence commence un lundi (${weekStart}).`;
  }
  if (weekStart > mondayOf(businessDayOf(writtenAt))) {
    return `La feuille de la semaine du ${weekStart} ne se reporte pas avant cette semaine.`;
  }
  return null;
}

/** Les sept jours métier de la semaine qui commence le lundi `weekStart`, du lundi au dimanche. */
export function weekDaysOf(weekStart: string): readonly string[] {
  return Array.from({ length: PRESENCE_WEEK_LENGTH }, (_, index) =>
    addBusinessDays(weekStart, index),
  );
}

/** Vrai si `day` tombe dans la semaine qui commence le lundi `weekStart`. */
export function isInWeek(weekStart: string, day: string): boolean {
  return isBusinessDay(day) && weekDaysOf(weekStart).includes(day);
}

/** Minutes écoulées depuis minuit pour une heure `HH:MM` (ou `HH:MM:SS`, secondes ignorées) ; `null` si invalide. */
export function clockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export interface PresenceDay {
  /** Jour métier `AAAA-MM-JJ`. */
  readonly date: string;
  /** Heure d'arrivée `HH:MM`. */
  readonly arrival?: string | null | undefined;
  /** Heure de départ `HH:MM`. */
  readonly departure?: string | null | undefined;
  readonly absenceCode?: PresenceAbsenceCode | null | undefined;
}

export type PresenceIssueCode =
  | 'PRESENCE_WEEK_NOT_MONDAY'
  | 'PRESENCE_DAY_OUT_OF_WEEK'
  | 'PRESENCE_DAY_DUPLICATE'
  | 'PRESENCE_TIME_INVALID'
  | 'PRESENCE_ABSENCE_WITH_TIMES'
  | 'PRESENCE_DEPARTURE_WITHOUT_ARRIVAL'
  | 'PRESENCE_DEPARTURE_NOT_AFTER_ARRIVAL'
  | 'PRESENCE_DAY_EMPTY';

export interface PresenceIssue {
  readonly code: PresenceIssueCode;
  readonly messageFr: string;
}

const issue = (code: PresenceIssueCode, messageFr: string): PresenceIssue => ({ code, messageFr });

/**
 * Contrôle d'un jour de présence : `null` si l'écriture est valable. Un jour sans heure ni code est refusé : il ne
 * dit rien (la fiche vide ne se reporte pas).
 */
export function presenceDayIssue(day: PresenceDay): PresenceIssue | null {
  const arrival = day.arrival ?? null;
  const departure = day.departure ?? null;
  const absence = day.absenceCode ?? null;
  if (arrival !== null && clockMinutes(arrival) === null) {
    return issue(
      'PRESENCE_TIME_INVALID',
      `Heure d'arrivée invalide le ${day.date} (HH:MM attendu).`,
    );
  }
  if (departure !== null && clockMinutes(departure) === null) {
    return issue(
      'PRESENCE_TIME_INVALID',
      `Heure de départ invalide le ${day.date} (HH:MM attendu).`,
    );
  }
  if (absence !== null && (arrival !== null || departure !== null)) {
    return issue(
      'PRESENCE_ABSENCE_WITH_TIMES',
      `Le ${day.date} : un code d'absence et des heures ne s'écrivent pas ensemble.`,
    );
  }
  if (departure !== null && arrival === null) {
    return issue(
      'PRESENCE_DEPARTURE_WITHOUT_ARRIVAL',
      `Le ${day.date} : un départ sans heure d'arrivée.`,
    );
  }
  if (
    arrival !== null &&
    departure !== null &&
    clockMinutes(departure)! <= clockMinutes(arrival)!
  ) {
    return issue(
      'PRESENCE_DEPARTURE_NOT_AFTER_ARRIVAL',
      `Le ${day.date} : le départ doit suivre l'arrivée (un travail de nuit s'écrit sur deux jours).`,
    );
  }
  if (arrival === null && departure === null && absence === null) {
    return issue('PRESENCE_DAY_EMPTY', `Le ${day.date} : ni heure ni code d'absence.`);
  }
  return null;
}

/** Contrôle des jours d'une personne dans la semaine `weekStart` : jours dans la semaine, sans doublon, chacun valable. */
export function presenceLineIssue(
  weekStart: string,
  days: readonly PresenceDay[],
): PresenceIssue | null {
  if (!isMondayBusinessDay(weekStart)) {
    return issue('PRESENCE_WEEK_NOT_MONDAY', `La semaine doit commencer un lundi (${weekStart}).`);
  }
  const seen = new Set<string>();
  for (const day of days) {
    if (!isInWeek(weekStart, day.date)) {
      return issue(
        'PRESENCE_DAY_OUT_OF_WEEK',
        `Le ${day.date} n'est pas dans la semaine du ${weekStart}.`,
      );
    }
    if (seen.has(day.date)) {
      return issue(
        'PRESENCE_DAY_DUPLICATE',
        `Le ${day.date} est écrit deux fois pour la même personne.`,
      );
    }
    seen.add(day.date);
    const problem = presenceDayIssue(day);
    if (problem) return problem;
  }
  return null;
}

/** Minutes travaillées un jour (départ − arrivée) ; `null` sans les deux heures ou en cas d'absence. */
export function workedMinutes(day: PresenceDay): number | null {
  if (day.absenceCode) return null;
  if (!day.arrival || !day.departure) return null;
  const from = clockMinutes(day.arrival);
  const to = clockMinutes(day.departure);
  return from === null || to === null || to <= from ? null : to - from;
}

/** Total d'une personne sur la semaine (colonne « Total heures »), en minutes. */
export function totalWorkedMinutes(days: readonly PresenceDay[]): number {
  return days.reduce((sum, day) => sum + (workedMinutes(day) ?? 0), 0);
}

/** Durée lisible : `7 h 45`, `8 h`, `0 h` (la fiche écrit « 07 h 45 »). */
export function formatWorkedMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`;
}

/** Heure `HH:MM` d'une valeur `TIME` de la base (`HH:MM:SS`) ; `null` reste `null`. */
export function clockHhmm(value: string | null): string | null {
  if (value === null) return null;
  const minutes = clockMinutes(value);
  if (minutes === null) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

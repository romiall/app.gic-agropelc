/**
 * ECR-TER-03 « Présence du personnel » (fiche PT ; PP-E, REQ-306, AV-313) : logique pure du formulaire de report d'une
 * feuille hebdomadaire. Les règles des jours (semaine, doublons, heures, codes d'absence) sont celles de `@gic/domain`,
 * que le serveur rejoue à l'application de la commande.
 *
 * Une feuille = un site, une semaine (lundi), le numéro de la feuille papier, le responsable et une ligne par personne
 * avec ses jours (arrivée et départ, ou code d'absence). Les lignes vides (ni nom ni jour) sont ignorées : la fiche
 * papier en a quatorze, on n'en remplit que quelques-unes.
 */
import {
  PRESENCE_MAX_LINES,
  PRESENCE_WEEK_LENGTH,
  isBusinessDay,
  isMondayBusinessDay,
  isPresenceAbsenceCode,
  mondayOf,
  personNameKey,
  presenceLineIssue,
  presenceWeekIssue,
  totalWorkedMinutes,
  weekDaysOf,
  type PresenceAbsenceCode,
  type PresenceDay,
} from '@gic/domain';

export const MAX_PAPER_REF = 30;
export const MAX_RESPONSIBLE = 120;
export const MAX_PERSON_NAME = 120;
export const MAX_PERSON_ROLE = 80;
export const MAX_MISSION = 80;

/** Un jour tel que saisi : heures `HH:MM` ou code d'absence, vides par défaut. */
export interface DayDraft {
  readonly arrival: string;
  readonly departure: string;
  readonly absence: PresenceAbsenceCode | '';
}

export interface LineDraft {
  /** Clé stable de la ligne dans la liste (jamais envoyée). */
  readonly key: string;
  readonly personName: string;
  readonly personRole: string;
  readonly missionLabel: string;
  /** Sept jours, du lundi au dimanche de la semaine de la feuille. */
  readonly days: readonly DayDraft[];
}

export interface SheetDraft {
  readonly siteId: string;
  /** Lundi de la semaine, `AAAA-MM-JJ`. */
  readonly weekStart: string;
  readonly paperRef: string;
  readonly responsibleName: string;
  readonly lines: readonly LineDraft[];
}

export const EMPTY_DAY: DayDraft = { arrival: '', departure: '', absence: '' };

export function emptyLine(key: string): LineDraft {
  return {
    key,
    personName: '',
    personRole: '',
    missionLabel: '',
    days: Array.from({ length: PRESENCE_WEEK_LENGTH }, () => EMPTY_DAY),
  };
}

export function emptySheet(weekStart: string, firstLineKey = 'l1'): SheetDraft {
  return {
    siteId: '',
    weekStart,
    paperRef: '',
    responsibleName: '',
    lines: [emptyLine(firstLineKey)],
  };
}

/**
 * Lundi de la semaine d'un jour saisi (une date au milieu de la semaine ramène à son lundi) ; `fallback` si la saisie n'est
 * pas (encore) une date plausible. Une année tapée au clavier passe par « 0002 », « 0020 », « 0202 » avant « 2026 » :
 * seules les années de 2020 à 2100 comptent, les autres saisies intermédiaires ne changent pas la semaine.
 */
export function weekStartOfInput(day: string, fallback: string): string {
  const year = Number(day.slice(0, 4));
  return isBusinessDay(day) && year >= 2020 && year <= 2100 ? mondayOf(day) : fallback;
}

const isBlankDay = (day: DayDraft): boolean =>
  day.arrival.trim() === '' && day.departure.trim() === '' && day.absence === '';

/** Vrai pour une ligne sans nom ni jour : elle est ignorée à l'envoi. */
export function isBlankLine(line: LineDraft): boolean {
  return (
    line.personName.trim() === '' &&
    line.personRole.trim() === '' &&
    line.missionLabel.trim() === '' &&
    line.days.every(isBlankDay)
  );
}

/** Jours renseignés d'une ligne, avec leur date, dans la forme de `@gic/domain`. */
export function filledDays(line: LineDraft, weekStart: string): readonly PresenceDay[] {
  const dates = weekDaysOf(weekStart);
  return line.days.flatMap((day, index) =>
    isBlankDay(day)
      ? []
      : [
          {
            date: dates[index]!,
            arrival: day.arrival.trim() === '' ? null : day.arrival.trim(),
            departure: day.departure.trim() === '' ? null : day.departure.trim(),
            absenceCode: day.absence === '' ? null : day.absence,
          },
        ],
  );
}

/** Total d'heures d'une ligne sur la semaine, en minutes (colonne « Total heures » de la fiche). */
export function lineWorkedMinutes(line: LineDraft, weekStart: string): number {
  return totalWorkedMinutes(filledDays(line, weekStart));
}

export type SheetIssueCode =
  | 'SITE_REQUIRED'
  | 'WEEK_NOT_MONDAY'
  | 'WEEK_IN_FUTURE'
  | 'NO_LINE'
  | 'TOO_MANY_LINES'
  | 'NAME_REQUIRED'
  | 'NO_DAY'
  | 'NAME_DUPLICATE'
  | 'DAY_INVALID';

export interface SheetIssue {
  readonly code: SheetIssueCode;
  /** Numéro (à partir de 1) de la ligne concernée dans la liste saisie, s'il y en a une. */
  readonly line?: number;
  /** Message du domaine pour un jour invalide. */
  readonly detail?: string;
}

/**
 * Problèmes de la feuille ; liste vide : prête à partir. `now` (l'instant du report) permet de refuser une semaine qui
 * n'a pas commencé, comme le serveur.
 */
export function checkSheet(draft: SheetDraft, now?: Date): readonly SheetIssue[] {
  const issues: SheetIssue[] = [];
  if (draft.siteId === '') issues.push({ code: 'SITE_REQUIRED' });
  const weekIsMonday = isMondayBusinessDay(draft.weekStart);
  if (!weekIsMonday) issues.push({ code: 'WEEK_NOT_MONDAY' });
  else if (now !== undefined && presenceWeekIssue(draft.weekStart, now) !== null) {
    issues.push({ code: 'WEEK_IN_FUTURE' });
  }
  const named = new Set<string>();
  let used = 0;
  draft.lines.forEach((line, index) => {
    if (isBlankLine(line)) return;
    used += 1;
    const number = index + 1;
    if (line.personName.trim() === '') {
      issues.push({ code: 'NAME_REQUIRED', line: number });
    } else if (named.has(personNameKey(line.personName))) {
      issues.push({ code: 'NAME_DUPLICATE', line: number });
    } else {
      named.add(personNameKey(line.personName));
    }
    const days = filledDays(line, draft.weekStart);
    if (days.length === 0) {
      issues.push({ code: 'NO_DAY', line: number });
      return;
    }
    // Une semaine qui ne commence pas un lundi est déjà signalée : ses jours n'ont pas de date juste à juger.
    if (!weekIsMonday) return;
    const problem = presenceLineIssue(draft.weekStart, days);
    if (problem) issues.push({ code: 'DAY_INVALID', line: number, detail: problem.messageFr });
  });
  if (used === 0) issues.push({ code: 'NO_LINE' });
  if (used > PRESENCE_MAX_LINES) issues.push({ code: 'TOO_MANY_LINES' });
  return issues;
}

const optional = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Charge utile de `fieldwork.presence.record` (lignes vides ignorées, textes vides ramenés à `null`). */
export function recordPayload(draft: SheetDraft) {
  return {
    siteId: draft.siteId,
    weekStart: draft.weekStart,
    paperRef: optional(draft.paperRef),
    responsibleName: optional(draft.responsibleName),
    lines: draft.lines
      .filter((line) => !isBlankLine(line))
      .map((line) => ({
        personName: line.personName.trim(),
        personRole: optional(line.personRole),
        missionLabel: optional(line.missionLabel),
        days: filledDays(line, draft.weekStart).map((day) => ({
          date: day.date,
          arrival: day.arrival ?? null,
          departure: day.departure ?? null,
          absenceCode: day.absenceCode ?? null,
        })),
      })),
  };
}

/** Feuille reportée, telle que la rend `GET /staff-presence`. */
export interface ServerPresenceSheet {
  readonly id: string;
  readonly siteId: string;
  readonly weekStart: string;
  readonly paperRef: string | null;
  readonly responsibleName: string | null;
  readonly status: 'RECORDED' | 'CANCELLED';
  readonly recordedAt: string;
  readonly cancelledAt: string | null;
  readonly cancelComment: string | null;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly personName: string;
    readonly personRole: string | null;
    readonly missionLabel: string | null;
    readonly userId: string | null;
    readonly days: readonly {
      readonly date: string;
      readonly arrival: string | null;
      readonly departure: string | null;
      readonly absenceCode: string | null;
    }[];
  }[];
}

/** Jours d'une ligne reportée dans la forme de `@gic/domain` (code inconnu ignoré). */
export function serverLineDays(line: ServerPresenceSheet['lines'][number]): readonly PresenceDay[] {
  return line.days.map((day) => ({
    date: day.date,
    arrival: day.arrival,
    departure: day.departure,
    absenceCode: isPresenceAbsenceCode(day.absenceCode) ? day.absenceCode : null,
  }));
}

/** Total d'heures d'une ligne reportée, en minutes. */
export function serverLineMinutes(line: ServerPresenceSheet['lines'][number]): number {
  return totalWorkedMinutes(serverLineDays(line));
}

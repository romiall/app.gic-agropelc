import { describe, expect, it } from 'vitest';
import {
  PRESENCE_ABSENCE_CODES,
  PRESENCE_ABSENCE_LABELS,
  clockHhmm,
  clockMinutes,
  formatWorkedMinutes,
  isInWeek,
  isMondayBusinessDay,
  isPresenceAbsenceCode,
  mondayOf,
  paperRefKey,
  personNameKey,
  presenceDayIssue,
  presenceLineIssue,
  presenceWeekIssue,
  totalWorkedMinutes,
  weekDaysOf,
  workedMinutes,
} from './staff-presence.js';

// 2026-11-02 est un lundi.
const MONDAY = '2026-11-02';

describe('semaine de présence', () => {
  it('reconnaît un lundi et refuse les autres jours et les dates invalides', () => {
    expect(isMondayBusinessDay(MONDAY)).toBe(true);
    expect(isMondayBusinessDay('2026-11-03')).toBe(false);
    expect(isMondayBusinessDay('2026-11-08')).toBe(false);
    expect(isMondayBusinessDay('2026-02-30')).toBe(false);
    expect(isMondayBusinessDay('lundi')).toBe(false);
  });

  it('ramène un jour quelconque au lundi de sa semaine', () => {
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-04')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
  });

  it('énumère sept jours du lundi au dimanche, à cheval sur un changement de mois', () => {
    expect(weekDaysOf('2026-10-26')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('place un jour dans sa semaine', () => {
    expect(isInWeek(MONDAY, '2026-11-08')).toBe(true);
    expect(isInWeek(MONDAY, '2026-11-09')).toBe(false);
    expect(isInWeek(MONDAY, '2026-11-01')).toBe(false);
    expect(isInWeek(MONDAY, '2026-13-01')).toBe(false);
  });

  it('accepte la semaine en cours ou passée, refuse celle à venir et celle qui ne commence pas un lundi', () => {
    // Jeudi 05/11/2026, 10 h à Douala : la semaine en cours commence le lundi 02/11.
    const thursday = new Date('2026-11-05T09:00:00.000Z');
    expect(presenceWeekIssue('2026-11-02', thursday)).toBeNull();
    expect(presenceWeekIssue('2026-10-26', thursday)).toBeNull();
    expect(presenceWeekIssue('2026-11-09', thursday)).toMatch(/pas avant cette semaine/);
    expect(presenceWeekIssue('2027-01-04', thursday)).toMatch(/pas avant cette semaine/);
    expect(presenceWeekIssue('2026-11-03', thursday)).toMatch(/commence un lundi/);
    expect(presenceWeekIssue('2026-02-30', thursday)).toMatch(/commence un lundi/);
  });

  it('juge la semaine au jour métier de Douala, pas à celui de Greenwich', () => {
    // Dimanche 08/11/2026, 23 h 30 UTC = lundi 09/11/2026, 0 h 30 à Douala : la semaine du 09/11 a commencé.
    const aroundMidnight = new Date('2026-11-08T23:30:00.000Z');
    expect(presenceWeekIssue('2026-11-09', aroundMidnight)).toBeNull();
    expect(presenceWeekIssue('2026-11-16', aroundMidnight)).not.toBeNull();
  });
});

describe('nom d’une personne sur une feuille', () => {
  it('compare sans tenir compte des espaces de bord ni de la casse', () => {
    expect(personNameKey('  Paul ESSOMBA ')).toBe(personNameKey('paul essomba'));
    expect(personNameKey('Éric')).toBe(personNameKey('éric'));
    expect(personNameKey('Paul Essomba')).not.toBe(personNameKey('Paul Essomba II'));
  });
});

describe('numéro d’une feuille papier (AV-514)', () => {
  it('compare sans tenir compte de la casse ni des espaces', () => {
    expect(paperRefKey(' pt  12 ')).toBe(paperRefKey('PT 12'));
    expect(paperRefKey('PT12')).toBe(paperRefKey('PT 12'));
    expect(paperRefKey('p t 1 2')).toBe(paperRefKey('PT12'));
    expect(paperRefKey('PT 12')).not.toBe(paperRefKey('PT 13'));
    expect(paperRefKey('PT-12')).not.toBe(paperRefKey('PT 12'));
  });

  it('ne reconnaît aucune feuille sans numéro', () => {
    expect(paperRefKey(null)).toBeNull();
    expect(paperRefKey(undefined)).toBeNull();
    expect(paperRefKey('   ')).toBeNull();
  });
});

describe('heures et codes', () => {
  it('lit une heure HH:MM ou HH:MM:SS et refuse le reste', () => {
    expect(clockMinutes('07:45')).toBe(465);
    expect(clockMinutes('07:45:30')).toBe(465);
    expect(clockMinutes('00:00')).toBe(0);
    expect(clockMinutes('23:59')).toBe(1439);
    expect(clockMinutes('24:00')).toBeNull();
    expect(clockMinutes('7:45')).toBeNull();
    expect(clockMinutes('07h45')).toBeNull();
    expect(clockMinutes('')).toBeNull();
  });

  it('rend l’heure d’une colonne TIME sans les secondes', () => {
    expect(clockHhmm('07:45:00')).toBe('07:45');
    expect(clockHhmm(null)).toBeNull();
    expect(clockHhmm('n’importe quoi')).toBeNull();
  });

  it('connaît les cinq codes d’absence de la fiche, chacun avec son libellé', () => {
    expect(PRESENCE_ABSENCE_CODES).toEqual(['A', 'M', 'C', 'R', 'MI']);
    for (const code of PRESENCE_ABSENCE_CODES) {
      expect(isPresenceAbsenceCode(code)).toBe(true);
      expect(PRESENCE_ABSENCE_LABELS[code]).not.toBe('');
    }
    expect(isPresenceAbsenceCode('X')).toBe(false);
    expect(isPresenceAbsenceCode(null)).toBe(false);
  });
});

describe('un jour de présence', () => {
  it('accepte des heures dans l’ordre', () => {
    expect(presenceDayIssue({ date: MONDAY, arrival: '07:45', departure: '16:30' })).toBeNull();
  });

  it('accepte une arrivée sans départ (la journée n’est pas finie) et un code d’absence seul', () => {
    expect(presenceDayIssue({ date: MONDAY, arrival: '07:45' })).toBeNull();
    expect(presenceDayIssue({ date: MONDAY, absenceCode: 'M' })).toBeNull();
  });

  it('refuse un code d’absence avec des heures', () => {
    expect(presenceDayIssue({ date: MONDAY, arrival: '07:45', absenceCode: 'A' })?.code).toBe(
      'PRESENCE_ABSENCE_WITH_TIMES',
    );
  });

  it('refuse un départ sans arrivée, ou qui ne la suit pas', () => {
    expect(presenceDayIssue({ date: MONDAY, departure: '16:30' })?.code).toBe(
      'PRESENCE_DEPARTURE_WITHOUT_ARRIVAL',
    );
    expect(presenceDayIssue({ date: MONDAY, arrival: '16:30', departure: '07:45' })?.code).toBe(
      'PRESENCE_DEPARTURE_NOT_AFTER_ARRIVAL',
    );
    expect(presenceDayIssue({ date: MONDAY, arrival: '08:00', departure: '08:00' })?.code).toBe(
      'PRESENCE_DEPARTURE_NOT_AFTER_ARRIVAL',
    );
  });

  it('refuse une heure invalide et un jour qui ne dit rien', () => {
    expect(presenceDayIssue({ date: MONDAY, arrival: '25:00' })?.code).toBe(
      'PRESENCE_TIME_INVALID',
    );
    expect(presenceDayIssue({ date: MONDAY, arrival: '07:45', departure: 'tard' })?.code).toBe(
      'PRESENCE_TIME_INVALID',
    );
    expect(presenceDayIssue({ date: MONDAY })?.code).toBe('PRESENCE_DAY_EMPTY');
    expect(
      presenceDayIssue({ date: MONDAY, arrival: null, departure: null, absenceCode: null })?.code,
    ).toBe('PRESENCE_DAY_EMPTY');
  });
});

describe('les jours d’une personne sur une semaine', () => {
  it('accepte des jours distincts de la semaine', () => {
    expect(
      presenceLineIssue(MONDAY, [
        { date: '2026-11-02', arrival: '07:45', departure: '16:30' },
        { date: '2026-11-03', absenceCode: 'C' },
        { date: '2026-11-07', arrival: '08:00', departure: '12:00' },
      ]),
    ).toBeNull();
  });

  it('refuse une semaine qui ne commence pas un lundi', () => {
    expect(presenceLineIssue('2026-11-03', [{ date: '2026-11-03', absenceCode: 'R' }])?.code).toBe(
      'PRESENCE_WEEK_NOT_MONDAY',
    );
  });

  it('refuse un jour hors de la semaine et un jour écrit deux fois', () => {
    expect(presenceLineIssue(MONDAY, [{ date: '2026-11-09', absenceCode: 'R' }])?.code).toBe(
      'PRESENCE_DAY_OUT_OF_WEEK',
    );
    expect(
      presenceLineIssue(MONDAY, [
        { date: '2026-11-02', absenceCode: 'R' },
        { date: '2026-11-02', arrival: '08:00' },
      ])?.code,
    ).toBe('PRESENCE_DAY_DUPLICATE');
  });

  it('remonte le premier jour invalide', () => {
    expect(
      presenceLineIssue(MONDAY, [
        { date: '2026-11-02', arrival: '07:45', departure: '16:30' },
        { date: '2026-11-03', arrival: '16:30', departure: '07:45' },
      ])?.code,
    ).toBe('PRESENCE_DEPARTURE_NOT_AFTER_ARRIVAL');
  });
});

describe('total d’heures', () => {
  it('compte départ − arrivée par jour et ignore les jours incomplets ou en absence', () => {
    expect(workedMinutes({ date: MONDAY, arrival: '07:45', departure: '16:30' })).toBe(525);
    expect(workedMinutes({ date: MONDAY, arrival: '07:45' })).toBeNull();
    expect(workedMinutes({ date: MONDAY, absenceCode: 'MI' })).toBeNull();
    expect(
      totalWorkedMinutes([
        { date: '2026-11-02', arrival: '07:45', departure: '16:30' },
        { date: '2026-11-03', arrival: '08:00', departure: '12:00' },
        { date: '2026-11-04', absenceCode: 'M' },
        { date: '2026-11-05', arrival: '08:00' },
      ]),
    ).toBe(525 + 240);
  });

  it('écrit la durée comme la fiche', () => {
    expect(formatWorkedMinutes(465)).toBe('7 h 45');
    expect(formatWorkedMinutes(480)).toBe('8 h');
    expect(formatWorkedMinutes(65)).toBe('1 h 05');
    expect(formatWorkedMinutes(0)).toBe('0 h');
    expect(formatWorkedMinutes(-3)).toBe('0 h');
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  addBusinessDays,
  businessMonthDays,
  periodOfBusinessDay,
  isWithinBusinessDay,
  nextBusinessDay,
  businessPeriodDays,
  businessPeriodOf,
  isoWeekdayOfBusinessDay,
} from './business-day.js';
import { DomainError } from './errors.js';

describe("businessDayOf (Africa/Douala, UTC+1, sans heure d'été)", () => {
  it('23:30 UTC le 24 septembre est déjà le 25 septembre à Douala (00:30)', () => {
    expect(businessDayOf(new Date('2026-09-24T23:30:00.000Z'))).toBe('2026-09-25');
  });

  it('22:30 UTC le 24 septembre est encore le 24 septembre à Douala (23:30)', () => {
    expect(businessDayOf(new Date('2026-09-24T22:30:00.000Z'))).toBe('2026-09-24');
  });

  it('midi UTC tombe sans ambiguïté dans le même jour civil à Douala', () => {
    expect(businessDayOf(new Date('2026-01-15T12:00:00.000Z'))).toBe('2026-01-15');
  });

  it("aucune heure d'été : le décalage est constant toute l'année (contrôle à 6 mois d'écart)", () => {
    // Si une heure d'été était appliquée par erreur, ces deux instants (23:15 UTC, veille
    // de bascules DST typiques dans l'hémisphère nord) ne donneraient pas le même jour
    // métier relatif à leur propre date.
    expect(businessDayOf(new Date('2026-03-28T23:15:00.000Z'))).toBe('2026-03-29');
    expect(businessDayOf(new Date('2026-10-24T23:15:00.000Z'))).toBe('2026-10-25');
  });
});

describe('businessDayStartUtc / businessDayEndUtc', () => {
  it("la fin d'un jour est exactement le début du suivant", () => {
    expect(businessDayEndUtc('2026-09-24').getTime()).toBe(
      businessDayStartUtc('2026-09-25').getTime(),
    );
  });

  it("un jour métier dure exactement 24 h (pas d'heure d'été à Douala)", () => {
    const durationMs =
      businessDayEndUtc('2026-09-24').getTime() - businessDayStartUtc('2026-09-24').getTime();
    expect(durationMs).toBe(24 * 60 * 60 * 1000);
  });

  it('businessDayOf(businessDayStartUtc(d)) === d, pour tout jour métier', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2020-01-01'), max: new Date('2035-12-31') }), (d) => {
        const day = businessDayOf(d);
        expect(businessDayOf(businessDayStartUtc(day))).toBe(day);
      }),
    );
  });

  it('rejette un format de jour métier invalide', () => {
    expect(() => businessDayStartUtc('24-09-2026')).toThrow();
  });

  it('rejette une date inexistante au calendrier (sans report au mois suivant)', () => {
    expect(() => businessDayStartUtc('2026-02-30')).toThrow(/date inexistante/);
    expect(() => businessDayEndUtc('2026-13-01')).toThrow(/date inexistante/);
    expect(businessDayStartUtc('2028-02-29').toISOString()).toBe('2028-02-28T23:00:00.000Z');
  });
});

describe('isWithinBusinessDay', () => {
  it('la borne de début est incluse, la borne de fin est exclue', () => {
    expect(isWithinBusinessDay(businessDayStartUtc('2026-09-24'), '2026-09-24')).toBe(true);
    expect(isWithinBusinessDay(businessDayEndUtc('2026-09-24'), '2026-09-24')).toBe(false);
  });
});

describe('nextBusinessDay (BR-TER-008 : clôture automatique à 23:59, heure de Douala)', () => {
  it('donne le jour civil suivant', () => {
    expect(nextBusinessDay('2026-09-24')).toBe('2026-09-25');
  });

  it('franchit correctement une fin de mois', () => {
    expect(nextBusinessDay('2026-09-30')).toBe('2026-10-01');
  });
});

describe('addBusinessDays', () => {
  it('décale un jour métier, à travers mois et années, dans les deux sens', () => {
    expect(addBusinessDays('2026-10-21', 28)).toBe('2026-11-18');
    expect(addBusinessDays('2026-12-20', 21)).toBe('2027-01-10');
    expect(addBusinessDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addBusinessDays('2026-10-21', 0)).toBe('2026-10-21');
  });

  it('refuse un jour inexistant ou un décalage non entier', () => {
    expect(() => addBusinessDays('2026-02-30', 1)).toThrow(/INVALID_BUSINESS_DAY|inexistante/);
    expect(() => addBusinessDays('2026-10-21', 1.5)).toThrow(/entier/);
  });
});

describe('businessMonthDays', () => {
  it('jours d’un mois, bornés au jour donné, années bissextiles comprises', () => {
    expect(businessMonthDays('2026-02')).toHaveLength(28);
    expect(businessMonthDays('2028-02')).toHaveLength(29);
    expect(businessMonthDays('2026-10', '2026-10-03')).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(businessMonthDays('2026-10', '2026-09-30')).toEqual([]);
    expect(businessMonthDays('2026-10', '2026-11-15')).toHaveLength(31);
    expect(periodOfBusinessDay('2026-10-21')).toBe('2026-10');
    expect(() => businessMonthDays('2026-13')).toThrow(/PERIOD_INVALID|invalide/);
  });
});

describe('périodes nommées des tableaux de bord (BR-ANA-002, P5-20)', () => {
  it('aujourd’hui et hier', () => {
    expect(businessPeriodOf('TODAY', '2026-10-11')).toEqual({
      fromDay: '2026-10-11',
      toDay: '2026-10-11',
    });
    expect(businessPeriodOf('YESTERDAY', '2026-03-01')).toEqual({
      fromDay: '2026-02-28',
      toDay: '2026-02-28',
    });
  });

  it('cette semaine : du lundi au dimanche, dimanche compris', () => {
    // 2026-10-11 est un dimanche ; 2026-10-05 un lundi.
    expect(businessPeriodOf('WEEK', '2026-10-11')).toEqual({
      fromDay: '2026-10-05',
      toDay: '2026-10-11',
    });
    expect(businessPeriodOf('WEEK', '2026-10-05')).toEqual({
      fromDay: '2026-10-05',
      toDay: '2026-10-11',
    });
    expect(businessPeriodOf('WEEK', '2026-12-31')).toEqual({
      fromDay: '2026-12-28',
      toDay: '2027-01-03',
    });
  });

  it('ce mois et cette année, années bissextiles comprises', () => {
    expect(businessPeriodOf('MONTH', '2028-02-10')).toEqual({
      fromDay: '2028-02-01',
      toDay: '2028-02-29',
    });
    expect(businessPeriodOf('MONTH', '2026-12-31')).toEqual({
      fromDay: '2026-12-01',
      toDay: '2026-12-31',
    });
    expect(businessPeriodOf('YEAR', '2026-01-01')).toEqual({
      fromDay: '2026-01-01',
      toDay: '2026-12-31',
    });
    expect(() => businessPeriodOf('TODAY', '2026-02-30')).toThrow(DomainError);
  });

  it('nombre de jours, bornes incluses ; période inversée refusée', () => {
    expect(businessPeriodDays({ fromDay: '2026-10-11', toDay: '2026-10-11' })).toBe(1);
    expect(businessPeriodDays({ fromDay: '2026-01-01', toDay: '2026-12-31' })).toBe(365);
    expect(businessPeriodDays({ fromDay: '2028-01-01', toDay: '2028-12-31' })).toBe(366);
    expect(() => businessPeriodDays({ fromDay: '2026-10-12', toDay: '2026-10-11' })).toThrow(
      DomainError,
    );
  });
});

describe('jour de la semaine ISO d’un jour métier', () => {
  it('lundi vaut 1, dimanche vaut 7', () => {
    expect(isoWeekdayOfBusinessDay('2026-10-19')).toBe(1); // lundi
    expect(isoWeekdayOfBusinessDay('2026-10-20')).toBe(2);
    expect(isoWeekdayOfBusinessDay('2026-10-24')).toBe(6); // samedi
    expect(isoWeekdayOfBusinessDay('2026-10-25')).toBe(7); // dimanche
    expect(isoWeekdayOfBusinessDay('2027-01-01')).toBe(5); // vendredi
  });

  it('refuse un jour qui n’existe pas', () => {
    expect(() => isoWeekdayOfBusinessDay('2026-02-30')).toThrow();
    expect(() => isoWeekdayOfBusinessDay('26-10-20')).toThrow();
  });
});

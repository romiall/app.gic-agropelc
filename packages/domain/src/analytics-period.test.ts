import { describe, expect, it } from 'vitest';
import {
  BUSINESS_PERIOD_CODES,
  businessDayEndUtc,
  businessDayStartUtc,
  businessPeriodOf,
} from './business-day.js';
import {
  ANALYTICS_PERIOD_CODES,
  isAnalyticsPeriodCode,
  resolveAnalyticsPeriod,
} from './analytics-period.js';

// Mercredi 14 octobre 2026.
const TODAY = '2026-10-14';

describe('resolveAnalyticsPeriod (BR-ANA-002, ADR-065 §3)', () => {
  it('étend les périodes nommées de business-day.ts sans les réécrire', () => {
    for (const code of BUSINESS_PERIOD_CODES) {
      const period = resolveAnalyticsPeriod({ code, today: TODAY });
      const base = businessPeriodOf(code, TODAY);
      expect(period.fromDay).toBe(base.fromDay);
      expect(period.toDay).toBe(base.toDay);
      expect(period.startUtc).toEqual(businessDayStartUtc(base.fromDay));
      expect(period.endUtc).toEqual(businessDayEndUtc(base.toDay));
    }
    expect(ANALYTICS_PERIOD_CODES).toEqual([...BUSINESS_PERIOD_CODES, 'CUSTOM']);
  });

  it('semaine du lundi au dimanche ; période précédente = semaine civile précédente complète', () => {
    const week = resolveAnalyticsPeriod({ code: 'WEEK', today: TODAY });
    expect(week).toMatchObject({ fromDay: '2026-10-12', toDay: '2026-10-18', days: 7 });
    expect(week.previous).toMatchObject({ fromDay: '2026-10-05', toDay: '2026-10-11', days: 7 });
  });

  it('aujourd’hui et hier : la veille', () => {
    expect(resolveAnalyticsPeriod({ code: 'TODAY', today: TODAY }).previous).toMatchObject({
      fromDay: '2026-10-13',
      toDay: '2026-10-13',
    });
    const yesterday = resolveAnalyticsPeriod({ code: 'YESTERDAY', today: TODAY });
    expect(yesterday.fromDay).toBe('2026-10-13');
    expect(yesterday.previous.fromDay).toBe('2026-10-12');
  });

  it('mois en cours : mois civil précédent complet, mois court, bissextile, changement d’année', () => {
    expect(resolveAnalyticsPeriod({ code: 'MONTH', today: TODAY }).previous).toMatchObject({
      fromDay: '2026-09-01',
      toDay: '2026-09-30',
      days: 30,
    });
    expect(resolveAnalyticsPeriod({ code: 'MONTH', today: '2026-03-10' }).previous).toMatchObject({
      fromDay: '2026-02-01',
      toDay: '2026-02-28',
      days: 28,
    });
    expect(resolveAnalyticsPeriod({ code: 'MONTH', today: '2024-03-10' }).previous).toMatchObject({
      toDay: '2024-02-29',
      days: 29,
    });
    expect(resolveAnalyticsPeriod({ code: 'MONTH', today: '2026-01-05' }).previous).toMatchObject({
      fromDay: '2025-12-01',
      toDay: '2025-12-31',
    });
  });

  it('année : année civile précédente', () => {
    const year = resolveAnalyticsPeriod({ code: 'YEAR', today: TODAY });
    expect(year).toMatchObject({ fromDay: '2026-01-01', toDay: '2026-12-31', days: 365 });
    expect(year.previous).toMatchObject({ fromDay: '2025-01-01', toDay: '2025-12-31', days: 365 });
    expect(resolveAnalyticsPeriod({ code: 'YEAR', today: '2025-06-01' }).previous.days).toBe(366);
  });

  it('plage personnalisée : bornes incluses, précédente de même durée', () => {
    const custom = resolveAnalyticsPeriod({
      code: 'CUSTOM',
      today: TODAY,
      fromDay: '2026-10-01',
      toDay: '2026-10-10',
    });
    expect(custom.days).toBe(10);
    expect(custom.previous).toMatchObject({ fromDay: '2026-09-21', toDay: '2026-09-30', days: 10 });
    // Fin exclue : minuit suivant à Douala (UTC+1) = 23:00 UTC le jour même.
    expect(custom.endUtc.toISOString()).toBe('2026-10-10T23:00:00.000Z');
    expect(custom.startUtc.toISOString()).toBe('2026-09-30T23:00:00.000Z');
  });

  it('plage personnalisée incomplète ou inversée : PERIOD_INVALID', () => {
    expect(() =>
      resolveAnalyticsPeriod({ code: 'CUSTOM', today: TODAY, fromDay: '2026-10-01' }),
    ).toThrow(expect.objectContaining({ code: 'PERIOD_INVALID' }));
    expect(() =>
      resolveAnalyticsPeriod({
        code: 'CUSTOM',
        today: TODAY,
        fromDay: '2026-10-10',
        toDay: '2026-10-01',
      }),
    ).toThrow(expect.objectContaining({ code: 'PERIOD_INVALID' }));
  });

  it('plafond de durée : PERIOD_TOO_LONG au-delà, accepté à la limite exacte', () => {
    const base = {
      code: 'CUSTOM' as const,
      today: TODAY,
      fromDay: '2026-01-01',
      toDay: '2026-12-31',
    };
    expect(resolveAnalyticsPeriod({ ...base, maxDays: 365 }).days).toBe(365);
    expect(() => resolveAnalyticsPeriod({ ...base, maxDays: 364 })).toThrow(
      expect.objectContaining({ code: 'PERIOD_TOO_LONG' }),
    );
  });

  it('reconnaît les codes de période', () => {
    expect(isAnalyticsPeriodCode('CUSTOM')).toBe(true);
    expect(isAnalyticsPeriodCode('WEEK')).toBe(true);
    expect(isAnalyticsPeriodCode('QUARTER')).toBe(false);
    expect(isAnalyticsPeriodCode(1)).toBe(false);
  });
});

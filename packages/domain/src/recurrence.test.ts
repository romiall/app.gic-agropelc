import { describe, expect, it } from 'vitest';
import { assertRecurringSchedule, localTimeMinutes, nextRecurringRun } from './recurrence.js';

const at = (iso: string) => new Date(iso);

describe('récurrence des tâches planifiées (P5-16)', () => {
  it('INTERVAL : créneau suivant aligné sur l’origine des temps, borne exacte exclue', () => {
    const hourly = { kind: 'INTERVAL', intervalSeconds: 3600 } as const;
    expect(nextRecurringRun(at('2026-10-09T10:17:45.123Z'), hourly)).toEqual(
      at('2026-10-09T11:00:00.000Z'),
    );
    // À l'instant exact du créneau : le suivant, jamais le créneau courant.
    expect(nextRecurringRun(at('2026-10-09T11:00:00.000Z'), hourly)).toEqual(
      at('2026-10-09T12:00:00.000Z'),
    );
    expect(
      nextRecurringRun(at('2026-10-09T11:00:00.000Z'), { kind: 'INTERVAL', intervalSeconds: 900 }),
    ).toEqual(at('2026-10-09T11:15:00.000Z'));
  });

  it('DAILY : heure locale de Douala (UTC+1), aujourd’hui si elle est à venir, sinon demain', () => {
    const at0200 = { kind: 'DAILY', localTime: '02:00' } as const;
    // 2026-10-09 00:30 Douala = 2026-10-08T23:30Z : 02:00 Douala du 09 = 01:00Z du 09.
    expect(nextRecurringRun(at('2026-10-08T23:30:00.000Z'), at0200)).toEqual(
      at('2026-10-09T01:00:00.000Z'),
    );
    // Juste après le créneau : le lendemain.
    expect(nextRecurringRun(at('2026-10-09T01:00:00.000Z'), at0200)).toEqual(
      at('2026-10-10T01:00:00.000Z'),
    );
  });

  it('DAILY : passage de minuit à Douala (23:30Z est déjà le lendemain à Douala)', () => {
    const at0005 = { kind: 'DAILY', localTime: '00:05' } as const;
    // 2026-10-09T22:50Z = 23:50 Douala le 09 → 00:05 Douala du 10 = 2026-10-09T23:05Z.
    expect(nextRecurringRun(at('2026-10-09T22:50:00.000Z'), at0005)).toEqual(
      at('2026-10-09T23:05:00.000Z'),
    );
    // 2026-10-09T23:10Z = 00:10 Douala le 10 → 00:05 Douala du 11.
    expect(nextRecurringRun(at('2026-10-09T23:10:00.000Z'), at0005)).toEqual(
      at('2026-10-10T23:05:00.000Z'),
    );
  });

  it('formes invalides refusées', () => {
    expect(localTimeMinutes('23:59')).toBe(1439);
    for (const bad of ['24:00', '7:00', '12:60', 'midi']) {
      expect(() => localTimeMinutes(bad)).toThrow(/HH:MM/);
    }
    expect(() => assertRecurringSchedule({ kind: 'INTERVAL', intervalSeconds: 0 })).toThrow(
      /Intervalle invalide/,
    );
    expect(() => assertRecurringSchedule({ kind: 'INTERVAL', intervalSeconds: 1.5 })).toThrow(
      /Intervalle invalide/,
    );
    expect(() =>
      nextRecurringRun(at('2026-10-09T10:00:00Z'), { kind: 'DAILY', localTime: '25:00' }),
    ).toThrow(/HH:MM/);
  });
});

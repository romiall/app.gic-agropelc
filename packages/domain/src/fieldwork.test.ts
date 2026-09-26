import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  canRequestOverride,
  detectCheckinSuspicion,
  evaluateCheckin,
  evaluateVisit,
  haversineDistanceM,
  resolveSessionEnd,
  sessionAutoCloseAt,
} from './fieldwork.js';

// Douala, carrefour Ndokoti (point de référence arbitraire des tests).
const CENTER = { lat: 4.0511, lng: 9.7679 };
const GEOFENCE = { ...CENTER, radiusM: 500 };
/** Point à `meters` au nord du centre (1° de latitude ≈ 111 195 m). */
const north = (meters: number) => ({ lat: CENTER.lat + meters / 111_195, lng: CENTER.lng });

describe('haversineDistanceM — BR-TER-003', () => {
  it('distance nulle sur le même point, symétrique, arrondie au décimètre', () => {
    expect(haversineDistanceM(CENTER, CENTER)).toBe(0);
    const d = haversineDistanceM(CENTER, north(180));
    expect(d).toBeCloseTo(180, 0);
    expect(haversineDistanceM(north(180), CENTER)).toBe(d);
    expect(Math.round(d * 10) / 10).toBe(d);
  });

  it('Douala → Yaoundé ≈ 200 km', () => {
    const yaounde = { lat: 3.848, lng: 11.5021 };
    expect(haversineDistanceM(CENTER, yaounde) / 1000).toBeGreaterThan(190);
    expect(haversineDistanceM(CENTER, yaounde) / 1000).toBeLessThan(215);
  });
});

describe('evaluateCheckin — BR-TER-002 (AT-014)', () => {
  const evaluate = (position: { lat: number; lng: number } | null, accuracyM: number | null) =>
    evaluateCheckin({ position, accuracyM, geofence: GEOFENCE, maxAccuracyM: 150 });

  it('à 180 m, précision 20 m : ACCEPTED', () => {
    const { result, distanceM } = evaluate(north(180), 20);
    expect(result).toBe('ACCEPTED');
    expect(distanceM).toBeCloseTo(180, 0);
  });

  it('à 1,8 km : REJECTED_OUT_OF_ZONE, distance conservée pour l’audit', () => {
    const { result, distanceM } = evaluate(north(1800), 20);
    expect(result).toBe('REJECTED_OUT_OF_ZONE');
    expect(distanceM).toBeCloseTo(1800, 0);
  });

  it('précision au-delà du maximum, ou inconnue : REJECTED_LOW_ACCURACY', () => {
    expect(evaluate(north(10), 300).result).toBe('REJECTED_LOW_ACCURACY');
    expect(evaluate(north(10), null).result).toBe('REJECTED_LOW_ACCURACY');
  });

  it('sans position : NO_POSITION', () => {
    expect(evaluate(null, null)).toEqual({ result: 'NO_POSITION', distanceM: null });
  });

  it('coordonnées hors limites : GEO_INVALID', () => {
    expect(() => evaluate({ lat: 95, lng: 9 }, 10)).toThrow(DomainError);
  });
});

describe('canRequestOverride — BR-TER-005', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 8, minutes));
  it('3 refus étalés sur 2 minutes au moins : autorisé', () => {
    expect(canRequestOverride([at(0), at(1), at(2)], 3, 2)).toBe(true);
  });
  it('moins de 3 refus, ou refus trop rapprochés : refusé', () => {
    expect(canRequestOverride([at(0), at(5)], 3, 2)).toBe(false);
    expect(canRequestOverride([at(0), at(0), at(1)], 3, 2)).toBe(false);
  });
});

describe('sessionAutoCloseAt / resolveSessionEnd — BR-TER-008, BR-TER-009 (SM-WORK-SESSION)', () => {
  const at = (iso: string) => new Date(iso);

  it('23:59 heure de Douala du jour métier de début ; dernière minute : l’heure de début', () => {
    expect(sessionAutoCloseAt(at('2026-10-05T07:00:00Z')).toISOString()).toBe(
      '2026-10-05T22:59:00.000Z',
    );
    // 23:30 à Douala (22:30 UTC) : même jour métier.
    expect(sessionAutoCloseAt(at('2026-10-05T22:30:00Z')).toISOString()).toBe(
      '2026-10-05T22:59:00.000Z',
    );
    // 00:30 à Douala le 6 (23:30 UTC le 5) : jour métier suivant.
    expect(sessionAutoCloseAt(at('2026-10-05T23:30:00Z')).toISOString()).toBe(
      '2026-10-06T22:59:00.000Z',
    );
    expect(sessionAutoCloseAt(at('2026-10-05T22:59:30Z')).toISOString()).toBe(
      '2026-10-05T22:59:30.000Z',
    );
  });

  it('reste ouverte tant que 23:59 n’est pas passé et qu’aucune prise ne la remplace', () => {
    expect(
      resolveSessionEnd({
        startedAt: at('2026-10-05T07:00:00Z'),
        supersededAt: null,
        now: at('2026-10-05T20:00:00Z'),
      }),
    ).toBeNull();
  });

  it('remplacée le même jour : SUPERSEDED à l’heure de la nouvelle prise', () => {
    expect(
      resolveSessionEnd({
        startedAt: at('2026-10-05T07:00:00Z'),
        supersededAt: at('2026-10-05T13:00:00Z'),
        now: at('2026-10-05T13:00:05Z'),
      }),
    ).toEqual({ endedAt: at('2026-10-05T13:00:00Z'), cause: 'SUPERSEDED' });
  });

  it('jour révolu : AUTO_2359, sauf remplacement antérieur à 23:59 (l’heure la plus ancienne l’emporte)', () => {
    const startedAt = at('2026-10-05T07:00:00Z');
    const now = at('2026-10-06T09:00:00Z');
    expect(resolveSessionEnd({ startedAt, supersededAt: null, now })).toEqual({
      endedAt: at('2026-10-05T22:59:00Z'),
      cause: 'AUTO_2359',
    });
    expect(resolveSessionEnd({ startedAt, supersededAt: at('2026-10-06T07:00:00Z'), now })).toEqual(
      {
        endedAt: at('2026-10-05T22:59:00Z'),
        cause: 'AUTO_2359',
      },
    );
    expect(resolveSessionEnd({ startedAt, supersededAt: at('2026-10-05T16:00:00Z'), now })).toEqual(
      {
        endedAt: at('2026-10-05T16:00:00Z'),
        cause: 'SUPERSEDED',
      },
    );
  });

  it('un remplacement antérieur au début (horloge incohérente) est ignoré', () => {
    expect(
      resolveSessionEnd({
        startedAt: at('2026-10-05T07:00:00Z'),
        supersededAt: at('2026-10-05T06:00:00Z'),
        now: at('2026-10-05T08:00:00Z'),
      }),
    ).toBeNull();
  });
});

describe('detectCheckinSuspicion — BR-TER-010', () => {
  const base = {
    accuracyM: 12,
    occurredAt: new Date('2026-10-01T09:00:00Z'),
    previous: null,
    otherDayPositions: [],
    previousAccuracies: [],
    maxSpeedKmh: 150,
    repeatedAccuracyCount: 5,
  };

  it('aucun signal sur un pointage ordinaire', () => {
    expect(detectCheckinSuspicion({ ...base, position: CENTER })).toEqual([]);
  });

  it('vitesse implicite > 150 km/h depuis la position précédente', () => {
    const flags = detectCheckinSuspicion({
      ...base,
      position: north(30_000), // 30 km en 10 minutes = 180 km/h
      previous: { position: CENTER, occurredAt: new Date('2026-10-01T08:50:00Z') },
    });
    expect(flags).toContain('SPEED_IMPLAUSIBLE');
  });

  it('précision nulle ; coordonnées répétées au mètre près un autre jour', () => {
    const flags = detectCheckinSuspicion({
      ...base,
      position: CENTER,
      accuracyM: 0,
      otherDayPositions: [north(0.4)],
    });
    expect(flags).toEqual(['ACCURACY_ZERO', 'COORDINATES_REPEATED']);
  });

  it('même précision sur plus de 5 pointages consécutifs', () => {
    expect(
      detectCheckinSuspicion({ ...base, position: CENTER, previousAccuracies: [12, 12, 12, 12] }),
    ).toEqual([]);
    expect(
      detectCheckinSuspicion({
        ...base,
        position: CENTER,
        previousAccuracies: [12, 12, 12, 12, 12],
      }),
    ).toEqual(['ACCURACY_REPEATED']);
  });
});

describe('evaluateVisit — BR-CRM-013, BR-CRM-015 (AT-051)', () => {
  it('visite à 800 m sans session : FAR_FROM_CUSTOMER et OUT_OF_SESSION', () => {
    const { distanceToCustomerM, flags } = evaluateVisit({
      visitPosition: north(800),
      customerPosition: CENTER,
      maxDistanceM: 500,
      session: 'NONE',
    });
    expect(distanceToCustomerM).toBeCloseTo(800, 0);
    expect(flags).toEqual(['OUT_OF_SESSION', 'FAR_FROM_CUSTOMER']);
  });

  it('compte non géolocalisé : pas de distance ; session rejetée signalée', () => {
    expect(
      evaluateVisit({
        visitPosition: CENTER,
        customerPosition: null,
        maxDistanceM: 500,
        session: 'OPEN_REJECTED',
      }),
    ).toEqual({ distanceToCustomerM: null, flags: ['SESSION_REJECTED'] });
  });
});

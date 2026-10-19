import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSUMER_FAILURE_WINDOW_HOURS,
  DEFAULT_CONSUMER_LAG_ALERT_SECONDS,
  MAX_CONSUMER_FAILURE_WINDOW_HOURS,
  MAX_CONSUMER_LAG_ALERT_SECONDS,
  consumerFailureWindowHoursOrDefault,
  consumerInAlarm,
  consumerLagAlertSecondsOrDefault,
  consumerLagSeconds,
} from './consumer-alerts.js';

describe('réglages de l’alerte de consommateur en échec : défauts et bornes', () => {
  it('consumer_lag_alert_seconds : nombre strictement positif, plafonné, sinon 300', () => {
    expect(consumerLagAlertSecondsOrDefault(600)).toBe(600);
    expect(consumerLagAlertSecondsOrDefault(0.5)).toBe(0.5);
    expect(consumerLagAlertSecondsOrDefault(1e12)).toBe(MAX_CONSUMER_LAG_ALERT_SECONDS);
    for (const invalid of [0, -5, NaN, Infinity, -Infinity, '300', null, undefined, {}, []]) {
      expect(consumerLagAlertSecondsOrDefault(invalid)).toBe(DEFAULT_CONSUMER_LAG_ALERT_SECONDS);
    }
    expect(DEFAULT_CONSUMER_LAG_ALERT_SECONDS).toBe(300);
  });

  it('consumer_failure_window_hours : nombre strictement positif, plafonné, sinon 24', () => {
    expect(consumerFailureWindowHoursOrDefault(6)).toBe(6);
    expect(consumerFailureWindowHoursOrDefault(0.25)).toBe(0.25);
    expect(consumerFailureWindowHoursOrDefault(1e9)).toBe(MAX_CONSUMER_FAILURE_WINDOW_HOURS);
    for (const invalid of [0, -1, NaN, Infinity, '24', null, undefined, {}]) {
      expect(consumerFailureWindowHoursOrDefault(invalid)).toBe(
        DEFAULT_CONSUMER_FAILURE_WINDOW_HOURS,
      );
    }
    expect(DEFAULT_CONSUMER_FAILURE_WINDOW_HOURS).toBe(24);
  });
});

describe('consumerLagSeconds — âge du plus ancien événement en attente', () => {
  const now = new Date('2026-10-18T10:00:00.000Z');

  it('rien en attente : aucun retard', () => {
    expect(consumerLagSeconds(null, now)).toBe(0);
  });

  it('secondes entières, arrondies vers le bas', () => {
    expect(consumerLagSeconds(new Date('2026-10-18T09:55:00.000Z'), now)).toBe(300);
    expect(consumerLagSeconds(new Date('2026-10-18T09:54:59.001Z'), now)).toBe(300);
    expect(consumerLagSeconds(new Date('2026-10-18T09:54:59.000Z'), now)).toBe(301);
    expect(consumerLagSeconds(new Date('2026-10-18T09:59:59.999Z'), now)).toBe(0);
    expect(consumerLagSeconds(now, now)).toBe(0);
  });

  it('un événement postérieur à l’instant de mesure ne donne jamais un retard négatif', () => {
    expect(consumerLagSeconds(new Date('2026-10-18T10:00:30.000Z'), now)).toBe(0);
    expect(consumerLagSeconds(new Date('2027-01-01T00:00:00.000Z'), now)).toBe(0);
  });
});

describe('consumerInAlarm — événement sauté ou retard au-delà du seuil', () => {
  const base = { failedEvents: 0, lagSeconds: 0, lagThresholdSeconds: 300 };

  it('ni saut ni retard : pas d’alerte', () => {
    expect(consumerInAlarm(base)).toBe(false);
  });

  it('un seul événement sauté suffit, même sans retard', () => {
    expect(consumerInAlarm({ ...base, failedEvents: 1 })).toBe(true);
    expect(consumerInAlarm({ ...base, failedEvents: 250 })).toBe(true);
  });

  it('le retard alerte strictement au-delà du seuil', () => {
    expect(consumerInAlarm({ ...base, lagSeconds: 300 })).toBe(false);
    expect(consumerInAlarm({ ...base, lagSeconds: 301 })).toBe(true);
    expect(consumerInAlarm({ ...base, lagSeconds: 120, lagThresholdSeconds: 60 })).toBe(true);
    expect(consumerInAlarm({ ...base, lagSeconds: 60, lagThresholdSeconds: 60 })).toBe(false);
  });

  it('les deux conditions à la fois', () => {
    expect(consumerInAlarm({ failedEvents: 2, lagSeconds: 900, lagThresholdSeconds: 300 })).toBe(
      true,
    );
  });
});

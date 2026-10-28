import { describe, expect, it } from 'vitest';
import {
  ALERT_RETENTION_FLOOR_DAYS,
  DEFAULT_ALERT_RETENTION_DAYS,
  DEFAULT_CONSUMER_FAILURE_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_RETENTION_DAYS,
  DEFAULT_PLATFORM_JOB_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  RETENTION_DAY_MS,
  alertRetentionDaysOrDefault,
  consumerFailurePurgeCutoff,
  retentionCutoff,
  retentionDaysOrDefault,
} from './retention.js';

const INVALID = [0, -1, 1.5, '90', NaN, Infinity, -Infinity, null, undefined, {}, []];

describe('durées de conservation : défauts et bornes', () => {
  it('les défauts documentés (ADR-068 §8)', () => {
    expect(DEFAULT_NOTIFICATION_RETENTION_DAYS).toBe(90);
    expect(DEFAULT_ALERT_RETENTION_DAYS).toBe(730);
    expect(ALERT_RETENTION_FLOOR_DAYS).toBe(730);
    expect(DEFAULT_PLATFORM_JOB_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_CONSUMER_FAILURE_RETENTION_DAYS).toBe(90);
    expect(RETENTION_DAY_MS).toBe(24 * 3_600_000);
  });

  it('retentionDaysOrDefault : entier strictement positif, plafonné, sinon le repli', () => {
    expect(retentionDaysOrDefault(90, 7)).toBe(90);
    expect(retentionDaysOrDefault(1, 7)).toBe(1);
    expect(retentionDaysOrDefault(1e9, 7)).toBe(MAX_RETENTION_DAYS);
    for (const invalid of INVALID) expect(retentionDaysOrDefault(invalid, 7)).toBe(7);
  });

  it('alertRetentionDaysOrDefault : jamais en deçà du plancher du déclencheur', () => {
    expect(alertRetentionDaysOrDefault(730)).toBe(730);
    expect(alertRetentionDaysOrDefault(1000)).toBe(1000);
    expect(alertRetentionDaysOrDefault(365)).toBe(ALERT_RETENTION_FLOOR_DAYS);
    expect(alertRetentionDaysOrDefault(1e9)).toBe(MAX_RETENTION_DAYS);
    for (const invalid of INVALID) {
      expect(alertRetentionDaysOrDefault(invalid)).toBe(DEFAULT_ALERT_RETENTION_DAYS);
    }
  });
});

describe('instants de coupure', () => {
  const NOW = new Date('2026-11-02T10:00:00.000Z');

  it('retentionCutoff : maintenant moins la durée, en jours entiers', () => {
    expect(retentionCutoff(NOW, 90).toISOString()).toBe('2026-08-04T10:00:00.000Z');
    expect(retentionCutoff(NOW, 730).toISOString()).toBe('2024-11-02T10:00:00.000Z');
  });

  it('consumerFailurePurgeCutoff : la plus ancienne de la rétention et de la fenêtre', () => {
    // Fenêtre de 24 h, rétention de 90 j : la rétention décide.
    expect(consumerFailurePurgeCutoff(NOW, 90, 24).toISOString()).toBe(
      retentionCutoff(NOW, 90).toISOString(),
    );
    // Fenêtre de 100 j : la fenêtre décide (jamais une ligne de la fenêtre de CONSUMER_FAILED).
    expect(consumerFailurePurgeCutoff(NOW, 90, 2_400).toISOString()).toBe(
      retentionCutoff(NOW, 100).toISOString(),
    );
    // Fenêtre maximale (87 600 h = 3 650 j).
    expect(consumerFailurePurgeCutoff(NOW, 90, 87_600).toISOString()).toBe(
      retentionCutoff(NOW, 3_650).toISOString(),
    );
  });

  it('consumerFailurePurgeCutoff : jamais plus récente que la fenêtre, quelle que soit la rétention', () => {
    for (const [days, hours] of [
      [1, 24],
      [1, 72],
      [30, 2_400],
      [3_650, 1],
    ] as const) {
      const cutoff = consumerFailurePurgeCutoff(NOW, days, hours);
      expect(cutoff.getTime()).toBeLessThanOrEqual(NOW.getTime() - hours * 3_600_000);
      expect(cutoff.getTime()).toBeLessThanOrEqual(retentionCutoff(NOW, days).getTime());
    }
  });
});

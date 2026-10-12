/**
 * Connexions MySQL du serveur en UTC, quel que soit le fuseau de l'hôte (ADR-016, ADR-023 :
 * `DATETIME(6)` toujours écrit et lu en UTC). Sur un poste réglé sur l'Afrique de l'Ouest (UTC+1), le
 * pilote écrivait l'heure locale : les horodatages étaient stockés décalés d'une heure et le jour
 * métier (`business_date`, colonne générée par `convert_tz(occurred_at, '+00:00', '+01:00')`) passait
 * au lendemain dès 23:00 UTC (révélé par AT-036, P5-21).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeTestDb, db } from './helpers.js';

afterAll(closeTestDb);

describe('connexions MySQL en UTC (ADR-016, ADR-023)', () => {
  it('session et pilote en UTC : une date s’écrit en heure UTC et se relit à l’identique', async () => {
    const instant = new Date('2026-10-05T22:30:00.000Z');
    const { rows } = await sql<{ tz: string; wall: string; day: string; back: Date }>`
      SELECT @@session.time_zone AS tz,
             DATE_FORMAT(CAST(${instant} AS DATETIME(6)), '%Y-%m-%d %H:%i:%s') AS wall,
             DATE_FORMAT(CONVERT_TZ(CAST(${instant} AS DATETIME(6)), '+00:00', '+01:00'), '%Y-%m-%d') AS day,
             CAST(${instant} AS DATETIME(6)) AS back`.execute(db);
    const [row] = rows;
    expect(row!.tz).toBe('+00:00');
    expect(row!.wall).toBe('2026-10-05 22:30:00');
    // 22:30 UTC = 23:30 à Douala : encore le jour métier du 5.
    expect(row!.day).toBe('2026-10-05');
    expect(row!.back.toISOString()).toBe(instant.toISOString());
  });

  it('les horodatages calculés par MySQL (`CURRENT_TIMESTAMP`, `NOW()`) sont en UTC', async () => {
    const { rows } = await sql<{ drift: number }>`
      SELECT ABS(TIMESTAMPDIFF(SECOND, NOW(6), UTC_TIMESTAMP(6))) AS drift`.execute(db);
    expect(Number(rows[0]!.drift)).toBe(0);
  });
});

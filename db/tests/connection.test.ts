// Connexions MySQL du paquet `db` (seeds, tests) en UTC, quel que soit le fuseau de l'hôte (ADR-016,
// ADR-023) : session `+00:00` et pilote en UTC, pour la connexion seule comme pour le pool.
import { describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { connectUtc } from '../seeds/connection.js';
import { withRollback } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL!;

describe('connexions du paquet db en UTC', () => {
  const instant = new Date('2026-10-05T22:30:00.000Z');
  const QUERY = `SELECT @@session.time_zone AS tz,
                        DATE_FORMAT(CAST(? AS DATETIME(6)), '%Y-%m-%d %H:%i:%s') AS wall,
                        ABS(TIMESTAMPDIFF(SECOND, NOW(6), UTC_TIMESTAMP(6))) AS drift`;

  it('connectUtc : session et pilote en UTC', async () => {
    const conn = await connectUtc(DATABASE_URL);
    try {
      const [rows] = await conn.query<RowDataPacket[]>(QUERY, [instant]);
      expect(rows[0]).toMatchObject({ tz: '+00:00', wall: '2026-10-05 22:30:00' });
      expect(Number(rows[0]!['drift'])).toBe(0);
    } finally {
      await conn.end();
    }
  });

  it('pool des tests : session et pilote en UTC', async () => {
    await withRollback(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(QUERY, [instant]);
      expect(rows[0]).toMatchObject({ tz: '+00:00', wall: '2026-10-05 22:30:00' });
    });
  });
});

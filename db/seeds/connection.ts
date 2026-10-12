/**
 * Connexions MySQL du paquet `db` (seeds, tests) **en UTC**, quel que soit le fuseau de l'hôte
 * (ADR-016, ADR-023 : `DATETIME(6)` toujours écrit et lu en UTC) : le pilote convertit les `Date` en
 * UTC (`timezone: 'Z'`, sinon il écrit l'heure locale de la machine) et la session MySQL aussi
 * (`time_zone = '+00:00'` : `CURRENT_TIMESTAMP`, `NOW()`, `UTC_TIMESTAMP()` cohérents avec les
 * horodatages écrits par l'application). Même réglage que `apps/server/src/platform/kysely/database.ts`.
 */
import mysql from 'mysql2/promise';

export const UTC_SESSION = "SET time_zone = '+00:00'";

export async function connectUtc(uri: string): Promise<mysql.Connection> {
  const conn = await mysql.createConnection({ uri, timezone: 'Z' });
  await conn.query(UTC_SESSION);
  return conn;
}

export function poolUtc(uri: string): mysql.Pool {
  const pool = mysql.createPool({ uri, timezone: 'Z' });
  // Chaque nouvelle connexion du pool passe sa session en UTC avant toute requête (file du pilote).
  pool.on('connection', (connection) => {
    connection.query(UTC_SESSION);
  });
  return pool;
}

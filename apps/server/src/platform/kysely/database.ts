/**
 * Connexion Kysely (constructeur de requêtes SQL typé, 05-stack.md §2.3) + pilote mysql2.
 * Types générés depuis le schéma réel par `pnpm run db:codegen` (kysely-codegen) :
 * `schema.generated.ts` est committé (comme `db/schema.sql`) pour que le typage fonctionne
 * sans base vivante ; à régénérer et committer dans le même commit que toute migration qui
 * change une colonne touchée par le code du serveur (règle R8, CLAUDE.md).
 */
import { Kysely, MysqlDialect } from 'kysely';
import { createPool, type Pool } from 'mysql2';
import type { DB } from './schema.generated.js';

export type { DB } from './schema.generated.js';
export type Database = Kysely<DB>;

/** Session MySQL en UTC (`CURRENT_TIMESTAMP`, `NOW()`, `UTC_TIMESTAMP()`), quel que soit l'hôte. */
const UTC_SESSION = "SET time_zone = '+00:00'";

/**
 * Pool **en UTC** (ADR-016, ADR-023 : `DATETIME(6)` toujours écrit et lu en UTC) : sans `timezone: 'Z'`,
 * mysql2 écrit et lit les `Date` dans le fuseau local de la machine (une heure de décalage sur un poste
 * réglé sur l'Afrique de l'Ouest, d'où un `business_date` faux entre 22:00 et 23:00 UTC) ; la session passe aussi
 * en UTC pour les valeurs par défaut `CURRENT_TIMESTAMP` et les comparaisons à `NOW()` (P5-21).
 */
export function createDatabase(connectionUri: string): { db: Database; pool: Pool } {
  const pool = createPool({ uri: connectionUri, timezone: 'Z' });
  pool.on('connection', (connection) => {
    connection.query(UTC_SESSION);
  });
  const db = new Kysely<DB>({ dialect: new MysqlDialect({ pool }) });
  return { db, pool };
}

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

export function createDatabase(connectionUri: string): { db: Database; pool: Pool } {
  const pool = createPool(connectionUri);
  const db = new Kysely<DB>({ dialect: new MysqlDialect({ pool }) });
  return { db, pool };
}

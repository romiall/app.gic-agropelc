/**
 * Écriture d'une colonne `JSON` via Kysely + mysql2 : `mysql2` n'encode pas
 * automatiquement une valeur JS pour ce type de colonne (db/README.md §5, déjà observé
 * dans `db/seeds/run.ts`) — `CAST(? AS JSON)` avec un paramètre `JSON.stringify`-é est le
 * point unique pour toute écriture JSON du serveur. Ne pas utiliser pour une colonne
 * nullable dont la valeur est absente : passer `null` directement (pas de CAST nécessaire).
 */
import { sql, type RawBuilder } from 'kysely';

/** Typé `string` : c'est le type d'insertion Kysely pour une colonne `Json` générée (voir schema.generated.ts). */
export function jsonValue(value: unknown): RawBuilder<string> {
  return sql<string>`CAST(${JSON.stringify(value)} AS JSON)`;
}

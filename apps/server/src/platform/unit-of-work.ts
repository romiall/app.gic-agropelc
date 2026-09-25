/**
 * Unité de travail (01-architecture-logicielle.md §3, règle 2 ; §4) : un gestionnaire de
 * commande ouvre une transaction unique, passée explicitement aux API internes des modules
 * qu'il appelle. `platform` n'a aucune dépendance (graphe N0) : ce fichier ne connaît aucun
 * module métier.
 */
import type { Transaction } from 'kysely';
import type { DB, Database } from './kysely/database.js';

export type UnitOfWork = Transaction<DB>;

export function withUnitOfWork<T>(db: Database, fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}

/**
 * Périmètre de lecture d'un indicateur (accueil par rôle, ADR-030) : sites lus et/ou personnes dont
 * l'activité est lue. Aucun champ : toute l'entreprise (portée `ALL`). Un tableau vide est un
 * périmètre vide (rien à lire), jamais « tout » : une affectation absente ne doit pas élargir la
 * lecture. Les modules traduisent ce périmètre en condition SQL sur leurs propres tables.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { toBin } from './kysely/uuid-columns.js';

export interface ReadScope {
  /** Sites lus (site de la vente, de l'emplacement…) ; absent : tous les sites. */
  readonly siteIds?: readonly string[];
  /** Utilisateurs dont l'activité est lue (vendeur, commercial, auteur) ; absent : tous. */
  readonly userIds?: readonly string[];
}

export const ALL_SCOPE: ReadScope = {};

export function isEmptyScope(scope: ReadScope): boolean {
  return scope.siteIds?.length === 0 || scope.userIds?.length === 0;
}

/**
 * Condition SQL de périmètre : `site` désigne la colonne de site (qualifiée, ex. `sales_sales.site_id`),
 * `users` les colonnes de personne (une personne peut être vendeur *ou* commercial : l'une ou
 * l'autre suffit). Les deux conditions s'ajoutent quand le périmètre porte sur les deux.
 */
export function scopeSql(
  scope: ReadScope,
  columns: { readonly site?: string; readonly users?: readonly string[] },
): RawBuilder<SqlBool> {
  if (isEmptyScope(scope)) return sql<SqlBool>`1 = 0`;
  const parts: RawBuilder<SqlBool>[] = [];
  if (scope.siteIds !== undefined && columns.site !== undefined) {
    const ids = scope.siteIds.map((id) => toBin(id));
    parts.push(sql<SqlBool>`${sql.ref(columns.site)} in (${sql.join(ids)})`);
  }
  if (scope.userIds !== undefined && columns.users !== undefined && columns.users.length > 0) {
    const ids = scope.userIds.map((id) => toBin(id));
    const either = columns.users.map(
      (column) => sql<SqlBool>`${sql.ref(column)} in (${sql.join(ids)})`,
    );
    parts.push(sql<SqlBool>`(${sql.join(either, sql` or `)})`);
  }
  return parts.length === 0 ? sql<SqlBool>`1 = 1` : sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
}

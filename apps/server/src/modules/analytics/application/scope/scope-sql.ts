/**
 * Compilation de l'étendue exacte en clause `WHERE` sur la vue d'un jeu de faits (P9-14 ; ADR-074 §4 et §5).
 *
 * Les colonnes de portée viennent du catalogue (`DatasetDefinition.scope`), jamais d'un texte de l'utilisateur ;
 * les identifiants sont des paramètres. Une ligne est lisible si **l'une** des colonnes d'un type de portée
 * convient (un mouvement de stock se lit par l'un de ses deux sites). **Règle fermée** : un jeu qui n'a aucune
 * colonne pour exprimer une clause ne rend, pour cette clause, aucune ligne.
 *
 * Plusieurs permissions de lecture sont exigées (`f_prospecting` : comptes **et** visites) : le jeu est lu par
 * l'intersection de leurs étendues, soit un `AND` de leurs clauses (`scopeConditions`).
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type { DatasetDefinition } from '@gic/domain';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { ExactScope, ScopeClause } from './exact-scope.js';

export type ScopedDataset = Pick<DatasetDefinition, 'scope'>;

const FALSE = sql<SqlBool>`1 = 0`;

function anyOf(
  columns: readonly string[],
  make: (column: string) => RawBuilder<SqlBool>,
): RawBuilder<SqlBool> | undefined {
  if (columns.length === 0) return undefined;
  const parts = columns.map(make);
  return parts.length === 1 ? parts[0] : sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
}

const inList = (column: string, ids: readonly string[]): RawBuilder<SqlBool> =>
  sql<SqlBool>`${sql.ref(column)} IN (${sql.join(ids.map((id) => toBin(id)))})`;

const notNull = (column: string): RawBuilder<SqlBool> =>
  sql<SqlBool>`${sql.ref(column)} IS NOT NULL`;

/** Une des conditions présentes ; `undefined` : aucune. */
function either(
  ...parts: ReadonlyArray<RawBuilder<SqlBool> | undefined>
): RawBuilder<SqlBool> | undefined {
  const present = parts.filter((part): part is RawBuilder<SqlBool> => part !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : sql<SqlBool>`(${sql.join(present, sql` OR `)})`;
}

/** Les deux conditions ; `undefined` si l'une manque (le jeu n'a pas la colonne : règle fermée). */
function both(
  left: RawBuilder<SqlBool> | undefined,
  right: RawBuilder<SqlBool> | undefined,
): RawBuilder<SqlBool> | undefined {
  return left && right ? sql<SqlBool>`(${left} AND ${right})` : undefined;
}

/**
 * Sites à lire pour leur zone : un jeu qui porte la zone propre de la ligne les lit par cette zone (clause `ZONES`),
 * non par le site, dont la zone peut différer ; un jeu sans colonne de zone les lit par le site.
 */
const siteIdsOf = (
  dataset: ScopedDataset,
  ids: readonly string[],
  viaZoneIds: readonly string[],
) => ((dataset.scope.ZONE ?? []).length > 0 ? ids : [...ids, ...viaZoneIds]);

function clauseCondition(
  dataset: ScopedDataset,
  clause: ScopeClause,
): RawBuilder<SqlBool> | undefined {
  const site = dataset.scope.SITE ?? [];
  const zone = dataset.scope.ZONE ?? [];
  const person = dataset.scope.PERSON ?? [];
  switch (clause.type) {
    case 'ANY_SITE':
      return anyOf(site, notNull);
    case 'ANY_ZONE':
      return anyOf(zone, notNull);
    case 'SITES': {
      const ids = siteIdsOf(dataset, clause.ids, clause.viaZoneIds);
      return ids.length > 0 ? anyOf(site, (column) => inList(column, ids)) : undefined;
    }
    case 'ZONES':
      return either(
        clause.ids.length > 0 ? anyOf(zone, (column) => inList(column, clause.ids)) : undefined,
        clause.withSiteIds.length > 0
          ? both(
              anyOf(site, notNull),
              anyOf(zone, (column) => inList(column, clause.withSiteIds)),
            )
          : undefined,
      );
    case 'PERSONS':
      return anyOf(person, (column) => inList(column, clause.ids));
    case 'ANY_SITE_AND_PERSONS':
    case 'ANY_ZONE_AND_PERSONS': {
      return both(
        anyOf(clause.type === 'ANY_SITE_AND_PERSONS' ? site : zone, notNull),
        anyOf(person, (column) => inList(column, clause.ids)),
      );
    }
    case 'SITES_AND_SELF':
    case 'ZONES_AND_SELF': {
      const ids =
        clause.type === 'SITES_AND_SELF'
          ? siteIdsOf(dataset, clause.ids, clause.viaZoneIds)
          : clause.ids;
      const scoped =
        ids.length > 0
          ? anyOf(clause.type === 'SITES_AND_SELF' ? site : zone, (column) => inList(column, ids))
          : undefined;
      return both(
        scoped,
        anyOf(person, (column) => inList(column, [clause.userId])),
      );
    }
  }
}

/** Condition d'une étendue ; `undefined` : aucune restriction (étendue `ALL`). */
export function scopeCondition(
  dataset: ScopedDataset,
  scope: ExactScope,
): RawBuilder<SqlBool> | undefined {
  if (scope.kind === 'ALL') return undefined;
  const parts = scope.clauses
    .map((clause) => clauseCondition(dataset, clause))
    .filter((part): part is RawBuilder<SqlBool> => part !== undefined);
  if (parts.length === 0) return FALSE;
  return parts.length === 1 ? parts[0] : sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
}

/** Conditions de plusieurs étendues (une par permission exigée), à lier par `AND` ; vide : aucune restriction. */
export function scopeConditions(
  dataset: ScopedDataset,
  scopes: readonly ExactScope[],
): readonly RawBuilder<SqlBool>[] {
  return scopes
    .map((scope) => scopeCondition(dataset, scope))
    .filter((part): part is RawBuilder<SqlBool> => part !== undefined);
}

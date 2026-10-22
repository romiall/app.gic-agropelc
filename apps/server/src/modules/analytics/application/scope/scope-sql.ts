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

function clauseCondition(
  dataset: ScopedDataset,
  clause: ScopeClause,
): RawBuilder<SqlBool> | undefined {
  const site = dataset.scope.SITE ?? [];
  const zone = dataset.scope.ZONE ?? [];
  const person = dataset.scope.PERSON ?? [];
  switch (clause.type) {
    case 'ANY_SITE':
      return anyOf(site, (column) => sql<SqlBool>`${sql.ref(column)} IS NOT NULL`);
    case 'ANY_ZONE':
      return anyOf(zone, (column) => sql<SqlBool>`${sql.ref(column)} IS NOT NULL`);
    case 'SITES':
      return anyOf(site, (column) => inList(column, clause.ids));
    case 'ZONES':
      return anyOf(zone, (column) => inList(column, clause.ids));
    case 'PERSONS':
      return anyOf(person, (column) => inList(column, clause.ids));
    case 'ANY_SITE_AND_PERSONS':
    case 'ANY_ZONE_AND_PERSONS': {
      const present = anyOf(
        clause.type === 'ANY_SITE_AND_PERSONS' ? site : zone,
        (column) => sql<SqlBool>`${sql.ref(column)} IS NOT NULL`,
      );
      const members = anyOf(person, (column) => inList(column, clause.ids));
      return present && members ? sql<SqlBool>`(${present} AND ${members})` : undefined;
    }
    case 'SITES_AND_SELF':
    case 'ZONES_AND_SELF': {
      const scoped = anyOf(clause.type === 'SITES_AND_SELF' ? site : zone, (column) =>
        inList(column, clause.ids),
      );
      const self = anyOf(person, (column) => inList(column, [clause.userId]));
      return scoped && self ? sql<SqlBool>`(${scoped} AND ${self})` : undefined;
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

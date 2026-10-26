/**
 * Compilateur de l'explorateur (P9-14 ; BR-ANA-006, ADR-064 §5, §6 et §8) : transforme un plan d'exploration
 * **déjà validé** par le domaine (`validateExploration`) en SQL sur la vue `analytics_f_*` du jeu.
 *
 * - **Aucun texte de l'utilisateur dans le SQL** : les noms de colonne, de vue et d'agrégat viennent du catalogue,
 *   les valeurs sont des paramètres, la direction d'un tri est l'une de deux constantes. Les alias (`d0…`, `m0…`)
 *   sont ceux du compilateur.
 * - **Période** sur la seule colonne de date commune aux mesures (`plan.periodDimension`) ; **étendue** des lignes
 *   en `AND` par permission (`scope-sql.ts`) ; **filtres** en `AND`. `NE` garde les lignes à dimension vide
 *   (`IS NULL OR`) : la logique à trois valeurs les perdrait. `CONTAINS` échappe `%`, `_` et le caractère
 *   d'échappement.
 * - **Mesures** : `SUM` vaut 0 sur un groupe sans fait (`COALESCE`), `COUNT` aussi ; une moyenne ou un maximum
 *   vide reste `NULL`. Les jours sortent en `AAAA-MM-JJ` (`DATE_FORMAT`), jamais en `Date` JavaScript.
 * - **Ordre déterministe** : le tri demandé, puis les dimensions dans l'ordre (le dépassement par `LIMIT + 1` ne
 *   dépend pas de l'ordre d'arrivée des lignes).
 * - **Total** : requête séparée, sans `GROUP BY`, seulement si toutes les mesures sont additives ; sans dimension,
 *   l'unique ligne est le total.
 * - **Durée** : indice d'optimiseur `MAX_EXECUTION_TIME`.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type {
  DimensionDefinition,
  DimensionType,
  ExplorationPlan,
  MeasureDefinition,
  MeasureUnit,
  ResolvedFilter,
} from '@gic/domain';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { ExactScope } from '../scope/exact-scope.js';
import { scopeConditions } from '../scope/scope-sql.js';

export interface CompiledColumn {
  readonly name: string;
  readonly label: string;
  readonly kind: 'dimension' | 'measure';
  readonly alias: string;
  readonly unit?: MeasureUnit;
  readonly dimensionType?: DimensionType;
}

export interface CompiledExploration {
  readonly columns: readonly CompiledColumn[];
  /** Les lignes, `rowLimit + 1` au plus. */
  readonly rows: RawBuilder<Record<string, unknown>>;
  /** Le total, par une requête séparée ; `null` s'il se lit dans la ligne unique ou n'existe pas. */
  readonly totals: RawBuilder<Record<string, unknown>> | null;
  /** Sans dimension, la ligne unique est le total (si toutes les mesures sont additives). */
  readonly totalsFromRow: boolean;
  readonly rowLimit: number;
}

export interface CompileOptions {
  /** Durée d'exécution maximale, en millisecondes (entier positif). */
  readonly maxExecutionMs: number;
}

/** Caractère d'échappement de `LIKE` : ni la barre oblique inverse (échappée par MySQL), ni un caractère courant. */
const LIKE_ESCAPE = '!';

export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

const columnOf = (dimension: DimensionDefinition): string => dimension.column ?? dimension.name;

function dimensionExpression(dimension: DimensionDefinition): RawBuilder<unknown> {
  const column = sql.ref(columnOf(dimension));
  return dimension.type === 'date' ? sql`DATE_FORMAT(${column}, '%Y-%m-%d')` : column;
}

function measureExpression(measure: MeasureDefinition): RawBuilder<unknown> {
  const column = sql.ref(measure.column);
  switch (measure.aggregate) {
    case 'SUM':
      return sql`COALESCE(SUM(${column}), 0)`;
    case 'COUNT':
      return sql`COUNT(${column})`;
    case 'COUNT_DISTINCT':
      return sql`COUNT(DISTINCT ${column})`;
    case 'AVG':
      return sql`AVG(${column})`;
    case 'MAX':
      return sql`MAX(${column})`;
  }
}

/** Paramètre d'un filtre : un identifiant devient son binaire, un booléen 0 ou 1. */
function parameter(type: DimensionType, value: string | number | boolean): unknown {
  if (type === 'id') return toBin(String(value));
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function filterCondition(filter: ResolvedFilter): RawBuilder<SqlBool> {
  const column = sql.ref(columnOf(filter.dimension));
  const type = filter.dimension.type;
  const scalar = (value: unknown) =>
    parameter(type, value as string | number | boolean) as string | number;
  switch (filter.op) {
    case 'EQ':
      return sql<SqlBool>`${column} = ${scalar(filter.value)}`;
    case 'NE':
      return sql<SqlBool>`(${column} IS NULL OR ${column} <> ${scalar(filter.value)})`;
    case 'GTE':
      return sql<SqlBool>`${column} >= ${scalar(filter.value)}`;
    case 'LTE':
      return sql<SqlBool>`${column} <= ${scalar(filter.value)}`;
    case 'IN': {
      const values = filter.value as readonly (string | number)[];
      return sql<SqlBool>`${column} IN (${sql.join(values.map((value) => scalar(value)))})`;
    }
    case 'BETWEEN': {
      const [low, high] = filter.value as readonly [string | number, string | number];
      return sql<SqlBool>`${column} BETWEEN ${scalar(low)} AND ${scalar(high)}`;
    }
    case 'CONTAINS':
      return sql<SqlBool>`${column} LIKE ${`%${escapeLike(String(filter.value))}%`} ESCAPE '!'`;
  }
}

function whereClause(plan: ExplorationPlan, scopes: readonly ExactScope[]): RawBuilder<unknown> {
  const parts: RawBuilder<SqlBool>[] = [sql<SqlBool>`1 = 1`];
  if (plan.period !== null && plan.periodDimension !== null) {
    const dimension = plan.dataset.dimensions.find((d) => d.name === plan.periodDimension);
    const column = sql.ref(dimension === undefined ? plan.periodDimension : columnOf(dimension));
    parts.push(sql<SqlBool>`${column} BETWEEN ${plan.period.fromDay} AND ${plan.period.toDay}`);
  }
  for (const filter of plan.filters) parts.push(filterCondition(filter));
  parts.push(...scopeConditions(plan.dataset, scopes));
  return sql`WHERE ${sql.join(parts, sql` AND `)}`;
}

export function compileExploration(
  plan: ExplorationPlan,
  scopes: readonly ExactScope[],
  options: CompileOptions,
): CompiledExploration {
  if (!Number.isInteger(options.maxExecutionMs) || options.maxExecutionMs < 1) {
    throw new RangeError('La durée maximale d’exécution est un entier positif.');
  }
  const hint = sql.raw(`/*+ MAX_EXECUTION_TIME(${options.maxExecutionMs}) */`);
  const columns: CompiledColumn[] = [
    ...plan.dimensions.map((dimension, index): CompiledColumn => ({
      name: dimension.name,
      label: dimension.label,
      kind: 'dimension',
      alias: `d${index}`,
      dimensionType: dimension.type,
    })),
    ...plan.measures.map((measure, index): CompiledColumn => ({
      name: measure.name,
      label: measure.label,
      kind: 'measure',
      alias: `m${index}`,
      unit: measure.unit,
    })),
  ];
  const aliasOf = new Map(columns.map((column) => [column.name, column.alias]));

  const selectDimensions = plan.dimensions.map(
    (dimension, index) => sql`${dimensionExpression(dimension)} AS ${sql.id(`d${index}`)}`,
  );
  const selectMeasures = plan.measures.map(
    (measure, index) => sql`${measureExpression(measure)} AS ${sql.id(`m${index}`)}`,
  );
  const where = whereClause(plan, scopes);
  const view = sql.table(plan.dataset.view);

  const groupBy =
    plan.dimensions.length === 0
      ? sql``
      : sql`GROUP BY ${sql.join(plan.dimensions.map((_, index) => sql.id(`d${index}`)))}`;

  const requested = plan.sort.map((entry) => ({
    alias: aliasOf.get(entry.field)!,
    descending: entry.direction === 'DESC',
  }));
  const sortedAliases = new Set(requested.map((entry) => entry.alias));
  const order = [
    ...requested,
    ...plan.dimensions
      .map((_, index) => `d${index}`)
      .filter((alias) => !sortedAliases.has(alias))
      .map((alias) => ({ alias, descending: false })),
  ];
  const orderBy =
    order.length === 0
      ? sql``
      : sql`ORDER BY ${sql.join(
          order.map((entry) =>
            entry.descending ? sql`${sql.id(entry.alias)} DESC` : sql`${sql.id(entry.alias)} ASC`,
          ),
        )}`;

  const rows = sql<Record<string, unknown>>`
    SELECT ${hint} ${sql.join([...selectDimensions, ...selectMeasures])}
      FROM ${view} ${where} ${groupBy} ${orderBy}
     LIMIT ${sql.lit(plan.limit + 1)}`;

  const totalsFromRow = plan.totalsAllowed && plan.dimensions.length === 0;
  const totals =
    plan.totalsAllowed && plan.dimensions.length > 0
      ? sql<Record<string, unknown>>`
          SELECT ${hint} ${sql.join(selectMeasures)}
            FROM ${view} ${where}`
      : null;

  return { columns, rows, totals, totalsFromRow, rowLimit: plan.limit };
}

// --- Lecture des lignes rendues ---------------------------------------------------------------------------

export type ExplorationValue = string | number | boolean | null;

function dimensionValue(type: DimensionType, raw: unknown): ExplorationValue {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case 'id':
      return Buffer.isBuffer(raw) ? fromBin(raw) : String(raw);
    case 'boolean':
      return Boolean(Number(raw));
    case 'number':
      return Number(raw);
    case 'date':
    case 'code':
    case 'text':
      return String(raw);
  }
}

function measureValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  return Number(raw);
}

/** Valeurs d'une ligne brute, par nom de colonne du catalogue. */
export function exploredValues(
  columns: readonly CompiledColumn[],
  raw: Record<string, unknown>,
): Record<string, ExplorationValue> {
  const values: Record<string, ExplorationValue> = {};
  for (const column of columns) {
    values[column.name] =
      column.kind === 'dimension'
        ? dimensionValue(column.dimensionType!, raw[column.alias])
        : measureValue(raw[column.alias]);
  }
  return values;
}

/** Totaux par nom de mesure ; une mesure vide vaut 0 (les mesures additives sont des sommes et des comptes). */
export function exploredTotals(
  columns: readonly CompiledColumn[],
  raw: Record<string, unknown>,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const column of columns) {
    if (column.kind === 'measure') totals[column.name] = measureValue(raw[column.alias]) ?? 0;
  }
  return totals;
}

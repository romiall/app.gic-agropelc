/**
 * Le catalogue de la couche sémantique et les treize vues `analytics_f_*` (P9-13 ; ADR-064 §1 et §2) : tout
 * ce que le catalogue cite — dimensions, mesures, colonnes de portée, colonnes de période — existe dans la
 * vue de son jeu, avec un type qui convient à l'usage déclaré ; chaque permission citée existe ; les vues
 * sont en lecture (`SQL SECURITY INVOKER`, `SELECT` seulement) et n'acceptent aucune écriture.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ANALYTICS_DATASETS, type DatasetDefinition } from '@gic/domain';
import { closeTestDb, db } from './helpers.js';

afterAll(closeTestDb);

interface ColumnInfo {
  readonly dataType: string;
  readonly columnType: string;
}

const NUMERIC = new Set(['decimal', 'int', 'bigint', 'smallint', 'tinyint', 'double', 'float']);
const TEXTUAL = new Set(['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext']);

async function viewColumns(): Promise<ReadonlyMap<string, ReadonlyMap<string, ColumnInfo>>> {
  const { rows } = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    column_type: string;
  }>`
    SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
           COLUMN_TYPE AS column_type
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'analytics\\_f\\_%'
  `.execute(db);
  const views = new Map<string, Map<string, ColumnInfo>>();
  for (const row of rows) {
    const columns = views.get(row.table_name) ?? new Map<string, ColumnInfo>();
    columns.set(row.column_name, { dataType: row.data_type, columnType: row.column_type });
    views.set(row.table_name, columns);
  }
  return views;
}

const columnOf = (dataset: DatasetDefinition, name: string) =>
  dataset.dimensions.find((dimension) => dimension.name === name)?.column ?? name;

describe('catalogue et vues analytics_f_*', () => {
  it('chaque jeu a sa vue et chaque vue son jeu : treize', async () => {
    const views = await viewColumns();
    expect([...views.keys()].sort()).toEqual(ANALYTICS_DATASETS.map((d) => d.view).sort());
    expect(ANALYTICS_DATASETS).toHaveLength(13);
  });

  it('toute colonne citée par le catalogue existe dans la vue de son jeu', async () => {
    const views = await viewColumns();
    for (const dataset of ANALYTICS_DATASETS) {
      const columns = views.get(dataset.view);
      expect(columns, dataset.view).toBeDefined();
      const cited = new Set<string>();
      for (const dimension of dataset.dimensions) cited.add(dimension.column ?? dimension.name);
      for (const measure of dataset.measures) cited.add(measure.column);
      for (const scope of Object.values(dataset.scope))
        for (const column of scope ?? []) cited.add(column);
      const missing = [...cited].filter((column) => !columns!.has(column));
      expect(missing, `${dataset.code} : colonnes absentes de ${dataset.view}`).toEqual([]);
    }
  });

  it('le type de la colonne convient à l’usage déclaré', async () => {
    const views = await viewColumns();
    const problems: string[] = [];
    for (const dataset of ANALYTICS_DATASETS) {
      const columns = views.get(dataset.view)!;
      for (const dimension of dataset.dimensions) {
        const info = columns.get(dimension.column ?? dimension.name)!;
        const ok =
          dimension.type === 'date'
            ? info.dataType === 'date'
            : dimension.type === 'id'
              ? /^(var)?binary\(16\)$/.test(info.columnType)
              : dimension.type === 'boolean'
                ? NUMERIC.has(info.dataType)
                : dimension.type === 'number'
                  ? NUMERIC.has(info.dataType)
                  : TEXTUAL.has(info.dataType);
        if (!ok)
          problems.push(
            `${dataset.code}.${dimension.name} (${dimension.type}) : ${info.columnType}`,
          );
      }
      for (const measure of dataset.measures) {
        const info = columns.get(measure.column)!;
        const numeric = measure.aggregate === 'SUM' || measure.aggregate === 'AVG';
        if (numeric && !NUMERIC.has(info.dataType)) {
          problems.push(
            `${dataset.code}.${measure.name} (${measure.aggregate}) : ${info.columnType}`,
          );
        }
      }
      for (const [kind, scope] of Object.entries(dataset.scope)) {
        for (const column of scope ?? []) {
          const info = columns.get(column)!;
          if (!/^(var)?binary\(16\)$/.test(info.columnType)) {
            problems.push(`${dataset.code} portée ${kind} ${column} : ${info.columnType}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('les colonnes de période sont des dates, celles des jeux datés comme celles des mesures', async () => {
    const views = await viewColumns();
    for (const dataset of ANALYTICS_DATASETS) {
      const columns = views.get(dataset.view)!;
      const periodColumns = new Set<string>();
      if (dataset.periodDimension !== null)
        periodColumns.add(columnOf(dataset, dataset.periodDimension));
      for (const measure of dataset.measures) {
        if (measure.periodDimension !== undefined) {
          periodColumns.add(columnOf(dataset, measure.periodDimension));
        }
      }
      for (const column of periodColumns) {
        expect(columns.get(column)?.dataType, `${dataset.code}.${column}`).toBe('date');
      }
      if (dataset.temporality === 'FLOW')
        expect(periodColumns.size, dataset.code).toBeGreaterThan(0);
    }
  });

  it('chaque permission citée existe', async () => {
    const { rows } = await sql<{ code: string }>`SELECT code FROM identity_permissions`.execute(db);
    const known = new Set(rows.map((row) => row.code));
    for (const dataset of ANALYTICS_DATASETS) {
      for (const permission of dataset.permissions) {
        expect(known.has(permission), `${dataset.code} : ${permission}`).toBe(true);
      }
    }
  });

  it('chaque vue est en lecture au nom du lecteur (SQL SECURITY INVOKER)', async () => {
    const { rows } = await sql<{ table_name: string; security_type: string }>`
      SELECT TABLE_NAME AS table_name, SECURITY_TYPE AS security_type
        FROM INFORMATION_SCHEMA.VIEWS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'analytics\\_f\\_%'
    `.execute(db);
    expect(rows).toHaveLength(13);
    for (const row of rows) expect(row.security_type, row.table_name).toBe('INVOKER');
  });

  // Une vue fusionnée à table unique (ou une jointure) se laisse écrire avec les droits de l'application sur la
  // table de base, quel que soit le droit sur la vue : toutes les vues sont donc `ALGORITHM = TEMPTABLE`, non
  // modifiables par construction.
  it('aucune vue n’est modifiable : MySQL les déclare non modifiables', async () => {
    const { rows } = await sql<{ table_name: string; is_updatable: string }>`
      SELECT TABLE_NAME AS table_name, IS_UPDATABLE AS is_updatable
        FROM INFORMATION_SCHEMA.VIEWS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'analytics\\_f\\_%'
    `.execute(db);
    expect(rows).toHaveLength(13);
    for (const row of rows) expect(row.is_updatable, row.table_name).toBe('NO');
  });

  it('l’application n’a que le droit de lire les vues, et aucune écriture n’aboutit', async () => {
    const views = await viewColumns();
    const { rows } = await sql<Record<string, string>>`SHOW GRANTS FOR CURRENT_USER`.execute(db);
    const grants = rows.map((row) => Object.values(row)[0]!);
    for (const dataset of ANALYTICS_DATASETS) {
      const own = grants.filter((grant) => grant.includes(`\`${dataset.view}\``));
      expect(own.length, dataset.view).toBeGreaterThan(0);
      for (const grant of own) {
        expect(/^GRANT SELECT ON /.test(grant), `${dataset.view} : ${grant}`).toBe(true);
      }
      // Une colonne qui existe vraiment dans la vue : le refus vient de la vue, pas d'un nom inconnu.
      const column = sql.ref([...views.get(dataset.view)!.keys()][0]!);
      const attempts: ReadonlyArray<readonly [string, ReturnType<typeof sql>]> = [
        ['DELETE', sql`DELETE FROM ${sql.table(dataset.view)} WHERE 1 = 0`],
        ['UPDATE', sql`UPDATE ${sql.table(dataset.view)} SET ${column} = ${column} WHERE 1 = 0`],
        ['INSERT', sql`INSERT INTO ${sql.table(dataset.view)} (${column}) VALUES (NULL)`],
      ];
      for (const [name, statement] of attempts) {
        await expect(statement.execute(db), `${dataset.view} ${name}`).rejects.toThrow(
          /not updatable|not insertable|denied/i,
        );
      }
    }
  });
});

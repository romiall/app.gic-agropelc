/**
 * Compilateur et exécution de l'explorateur (P9-14 (2/4) ; BR-ANA-006, ADR-064 §5, §6 et §8) : chaque jeu, chaque
 * dimension et chaque mesure du catalogue se compile en SQL valide ; les valeurs rendues suivent la source ; chaque
 * opérateur de filtre est rapproché d'un calcul indépendant ; l'étendue des lignes restreint le résultat ; les
 * limites (lignes, durée, concurrence) sont des erreurs, jamais une troncature silencieuse ; aucun texte de
 * l'utilisateur n'entre dans le SQL.
 *
 * Les lectures de données se font dans un instantané toujours annulé (`snapshot`), sur la base d'essai partagée :
 * un contrôle sans donnée pour s'exercer **saute** (`enough`, avant toute assertion), il ne passe pas à vide.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import {
  ANALYTICS_DATASETS,
  validateExploration,
  type DatasetDefinition,
  type ExplorationDefinition,
  type ExplorationPlan,
} from '@gic/domain';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  acquireGlobalQuerySlot,
  acquireQuerySlot,
  compileExploration,
  DEFAULT_EXPLORER_LIMITS,
  executeExploration,
  ExplorationLimitError,
  globalQuerySlotName,
  readExplorerLimits,
  recordQueryLog,
  releaseGlobalQuerySlot,
  releaseQuerySlot,
  runExploration,
  type CompiledExploration,
  type ExactScope,
  type ExplorationResult,
  zoneDescendantsOf,
} from '../src/modules/analytics/application/public/index.js';
import { exploredTotals } from '../src/modules/analytics/application/query/compile-exploration.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';
import { enough, snapshot, type Trx } from './analytics-view-seeds.js';

afterAll(closeTestDb);

const PERIOD = { code: 'CUSTOM', fromDay: '2020-01-01', toDay: '2099-12-31' } as const;
const WINDOW = sql`BETWEEN '2020-01-01' AND '2099-12-31'`;
const ALL_SCOPE: readonly ExactScope[] = [{ kind: 'ALL' }];
const NO_ZONES: ReadonlyMap<string, readonly string[]> = new Map();
const LIMITS = { maxRows: 10_000, maxExecutionMs: 15_000 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const dataset = (code: string): DatasetDefinition =>
  ANALYTICS_DATASETS.find((candidate) => candidate.code === code)!;

function definitionOf(
  target: DatasetDefinition,
  partial: Partial<ExplorationDefinition> & Pick<ExplorationDefinition, 'measures'>,
): ExplorationDefinition {
  return {
    dataset: target.code,
    ...(target.temporality === 'FLOW' ? { period: PERIOD } : {}),
    dimensions: [],
    filters: [],
    sort: [],
    ...partial,
  };
}

function planOf(
  definition: ExplorationDefinition,
  options: { readonly datasets?: readonly DatasetDefinition[]; readonly maxRows?: number } = {},
): ExplorationPlan {
  const result = validateExploration(
    definition,
    {
      today: '2026-10-22',
      canReadValuation: true,
      maxDetailDays: 40_000,
      maxRows: options.maxRows ?? LIMITS.maxRows,
    },
    options.datasets,
  );
  if (!result.ok) throw new Error(`${result.code} : ${result.message}`);
  return result.plan;
}

async function explore(
  trx: Trx,
  plan: ExplorationPlan,
  scopes: readonly ExactScope[] = ALL_SCOPE,
  limits: { readonly maxRows: number; readonly maxExecutionMs: number } = LIMITS,
): Promise<ExplorationResult> {
  const compiled = compileExploration(plan, scopes, {
    maxExecutionMs: limits.maxExecutionMs,
    zoneDescendants: await zoneDescendantsOf(trx, plan),
  });
  return executeExploration(trx, compiled, limits);
}

async function scalar(trx: Trx, query: RawBuilder<{ v: string | number | null }>): Promise<number> {
  const { rows } = await query.execute(trx);
  return Number(rows[0]?.v ?? 0);
}

const sales = dataset('f_sales_line');

// --- Chaque jeu, chaque mesure, chaque dimension -----------------------------------------------------------

describe('compilation de tout le catalogue', () => {
  it('chaque mesure, seule, puis chaque dimension avec la première mesure, s’exécute et rend des valeurs typées', async () => {
    await snapshot(async (trx) => {
      let queries = 0;
      for (const target of ANALYTICS_DATASETS) {
        for (const measure of target.measures) {
          const alone = await explore(
            trx,
            planOf(definitionOf(target, { measures: [measure.name] })),
          );
          queries += 1;
          // Sans dimension : une seule ligne ; une somme ou un compte vaut un nombre, jamais `null`.
          expect(alone.rowCount, `${target.code}/${measure.name}`).toBe(1);
          const value = alone.rows[0]![measure.name];
          if (measure.aggregate === 'AVG' || measure.aggregate === 'MAX') {
            expect(
              value === null || typeof value === 'number',
              `${target.code}/${measure.name}`,
            ).toBe(true);
          } else {
            expect(typeof value, `${target.code}/${measure.name}`).toBe('number');
          }
        }
        const first = target.measures[0]!;
        for (const dimension of target.dimensions) {
          const result = await explore(
            trx,
            planOf(
              definitionOf(target, {
                measures: [first.name],
                dimensions: [dimension.name],
                limit: 25,
              }),
            ),
          );
          queries += 1;
          for (const row of result.rows) {
            const cell = row[dimension.name];
            const label = `${target.code}/${dimension.name}`;
            if (cell === null) continue;
            switch (dimension.type) {
              case 'id':
                expect(typeof cell === 'string' && UUID.test(cell), label).toBe(true);
                break;
              case 'date':
                expect(typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cell), label).toBe(
                  true,
                );
                break;
              case 'boolean':
                expect(typeof cell, label).toBe('boolean');
                break;
              case 'number':
                expect(typeof cell, label).toBe('number');
                break;
              default:
                expect(typeof cell, label).toBe('string');
            }
          }
        }
      }
      expect(queries).toBeGreaterThan(100);
    });
  });

  it('les colonnes rendues suivent la requête : dimensions puis mesures, libellés du catalogue', async () => {
    await snapshot(async (trx) => {
      const result = await explore(
        trx,
        planOf(
          definitionOf(sales, {
            measures: ['revenue', 'quantity'],
            dimensions: ['site_id', 'event_kind'],
            limit: 5,
          }),
        ),
      );
      expect(result.columns.map((column) => [column.name, column.kind])).toEqual([
        ['site_id', 'dimension'],
        ['event_kind', 'dimension'],
        ['revenue', 'measure'],
        ['quantity', 'measure'],
      ]);
      expect(result.columns.find((column) => column.name === 'revenue')).toMatchObject({
        label: "Chiffre d'affaires",
        unit: 'xaf',
      });
      expect(result.columns.find((column) => column.name === 'site_id')).toMatchObject({
        dimensionType: 'id',
      });
    });
  });
});

// --- Les valeurs suivent la source ----------------------------------------------------------------------------

describe('valeurs rendues', () => {
  it('le chiffre d’affaires par jour et par site, les jours en AAAA-MM-JJ et les sites en UUID, comme la source', async (ctx) => {
    await snapshot(async (trx) => {
      const source = await sql<{ d: string; site: Buffer; v: string }>`
        SELECT DATE_FORMAT(business_day, '%Y-%m-%d') AS d, site_id AS site, CAST(SUM(amount_xaf) AS CHAR) AS v
          FROM analytics_f_sales_line WHERE business_day ${WINDOW} GROUP BY business_day, site_id`.execute(
        trx,
      );
      enough(ctx, source.rows.length, 3, 'jours et sites de vente');
      const result = await explore(
        trx,
        planOf(
          definitionOf(sales, { measures: ['revenue'], dimensions: ['business_day', 'site_id'] }),
        ),
      );
      expect(
        new Map(result.rows.map((row) => [`${row.business_day}|${row.site_id}`, row.revenue])),
      ).toEqual(
        new Map(source.rows.map((row) => [`${row.d}|${fromBin(row.site)}`, Number(row.v)])),
      );
    });
  });

  it('une moyenne vide reste vide (null), un compte distinct ne l’est jamais', async (ctx) => {
    await snapshot(async (trx) => {
      const production = dataset('f_production_daily');
      const source = await sql<{ lot: Buffer; avg_weight: string | null }>`
        SELECT lot_id AS lot, AVG(average_weight_kg) AS avg_weight FROM analytics_f_production_daily
         WHERE business_day ${WINDOW} GROUP BY lot_id`.execute(trx);
      enough(ctx, source.rows.length, 2, 'lots de production');
      enough(
        ctx,
        source.rows.filter((row) => row.avg_weight === null).length,
        1,
        'lots sans pesée',
      );
      enough(ctx, source.rows.filter((row) => row.avg_weight !== null).length, 1, 'lots pesés');
      const result = await explore(
        trx,
        planOf(definitionOf(production, { measures: ['average_weight'], dimensions: ['lot_id'] })),
      );
      const bySource = new Map(
        source.rows.map((row) => [
          fromBin(row.lot),
          row.avg_weight === null ? null : Number(row.avg_weight),
        ]),
      );
      for (const row of result.rows) {
        const expected = bySource.get(row.lot_id as string);
        if (expected === null) expect(row.average_weight, String(row.lot_id)).toBeNull();
        else expect(row.average_weight as number, String(row.lot_id)).toBeCloseTo(expected!, 6);
      }
      expect(result.rowCount).toBe(source.rows.length);
    });
  });

  it('une somme sans fait vaut 0 : un site inexistant dans l’étendue ne rend aucune ligne, sans dimension le total vaut 0', async () => {
    await snapshot(async (trx) => {
      const nothing: ExactScope = { kind: 'CLAUSES', clauses: [], truncated: false };
      const grouped = await explore(
        trx,
        planOf(definitionOf(sales, { measures: ['revenue'], dimensions: ['site_id'] })),
        [nothing],
      );
      expect(grouped.rowCount).toBe(0);
      const total = await explore(trx, planOf(definitionOf(sales, { measures: ['revenue'] })), [
        nothing,
      ]);
      expect(total.rows).toEqual([{ revenue: 0 }]);
      expect(total.totals).toEqual({ revenue: 0 });
    });
  });
});

// --- Filtres -----------------------------------------------------------------------------------------------------

const movesDataset = (code: string): DatasetDefinition => ({
  code,
  label: 'Mouvements (essai)',
  view: 'analytics_f_stock_moves',
  temporality: 'FLOW',
  permissions: ['inventory.ledger.read'],
  periodDimension: 'business_day',
  scope: { SITE: ['from_site_id', 'to_site_id'] },
  dimensions: [
    { name: 'business_day', label: 'Jour', type: 'date' },
    { name: 'move_type', label: 'Type', type: 'text' },
    { name: 'quantity_base', label: 'Quantité', type: 'number' },
  ],
  measures: [
    {
      name: 'moves',
      label: 'Mouvements',
      aggregate: 'COUNT',
      column: 'move_id',
      unit: 'count',
      additive: true,
    },
  ],
});

describe('filtres', () => {
  async function facts(trx: Trx) {
    const sites = (
      await sql<{ site: Buffer }>`SELECT site_id AS site FROM analytics_f_sales_line
        GROUP BY site_id ORDER BY COUNT(*) DESC, site_id LIMIT 2`.execute(trx)
    ).rows.map((row) => fromBin(row.site));
    const days = (
      await sql<{ d: string }>`SELECT DISTINCT DATE_FORMAT(business_day, '%Y-%m-%d') AS d
        FROM analytics_f_sales_line ORDER BY d`.execute(trx)
    ).rows.map((row) => row.d);
    return { sites, days };
  }

  const revenue = async (trx: Trx, filters: ExplorationDefinition['filters']) => {
    const result = await explore(
      trx,
      planOf(definitionOf(sales, { measures: ['revenue'], filters })),
    );
    return result.rows[0]!.revenue as number;
  };
  const independent = (trx: Trx, predicate: RawBuilder<unknown>) =>
    scalar(
      trx,
      sql<{ v: string | null }>`SELECT COALESCE(SUM(amount_xaf), 0) AS v FROM analytics_f_sales_line
        WHERE business_day ${WINDOW} AND ${predicate}`,
    );

  it('égal, dans une liste, différent : chacun rapproché d’un calcul indépendant', async (ctx) => {
    await snapshot(async (trx) => {
      const { sites } = await facts(trx);
      enough(ctx, sites.length, 2, 'sites ayant des ventes');
      const [first, second] = sites as [string, string];
      const total = await independent(trx, sql`1 = 1`);
      const eq = await revenue(trx, [{ field: 'site_id', op: 'EQ', value: first }]);
      expect(eq).toBe(await independent(trx, sql`site_id = ${toBin(first)}`));
      expect(eq).toBeLessThan(total);
      expect(await revenue(trx, [{ field: 'site_id', op: 'IN', value: [first, second] }])).toBe(
        await independent(trx, sql`site_id IN (${toBin(first)}, ${toBin(second)})`),
      );
      expect(await revenue(trx, [{ field: 'event_kind', op: 'EQ', value: 'CANCELLATION' }])).toBe(
        await independent(trx, sql`event_kind = 'CANCELLATION'`),
      );
      expect(await revenue(trx, [{ field: 'site_id', op: 'NE', value: first }])).toBe(
        await independent(trx, sql`(site_id IS NULL OR site_id <> ${toBin(first)})`),
      );
    });
  });

  it('différent garde les lignes à dimension vide (logique à trois valeurs)', async (ctx) => {
    await snapshot(async (trx) => {
      const nullRevenue = await independent(trx, sql`customer_id IS NULL`);
      const known = (
        await sql<{ customer: Buffer }>`SELECT customer_id AS customer FROM analytics_f_sales_line
          WHERE customer_id IS NOT NULL ORDER BY customer_id LIMIT 1`.execute(trx)
      ).rows[0];
      enough(ctx, known ? 1 : 0, 1, 'ventes à client connu');
      enough(ctx, nullRevenue === 0 ? 0 : 1, 1, 'ventes sans client');
      const customer = fromBin(known!.customer);
      const kept = await revenue(trx, [{ field: 'customer_id', op: 'NE', value: customer }]);
      const naive = await independent(trx, sql`customer_id <> ${toBin(customer)}`);
      expect(kept).toBe(naive + nullRevenue);
      expect(kept).toBeGreaterThan(naive);
    });
  });

  it('bornes de dates : supérieur ou égal, inférieur ou égal, entre', async (ctx) => {
    await snapshot(async (trx) => {
      const { days } = await facts(trx);
      enough(ctx, days.length, 3, 'jours de vente distincts');
      const low = days[Math.floor(days.length / 3)]!;
      const high = days[Math.floor((2 * days.length) / 3)]!;
      expect(await revenue(trx, [{ field: 'business_day', op: 'GTE', value: low }])).toBe(
        await independent(trx, sql`business_day >= ${low}`),
      );
      expect(await revenue(trx, [{ field: 'business_day', op: 'LTE', value: high }])).toBe(
        await independent(trx, sql`business_day <= ${high}`),
      );
      const between = await revenue(trx, [
        { field: 'business_day', op: 'BETWEEN', value: [low, high] },
      ]);
      expect(between).toBe(await independent(trx, sql`business_day BETWEEN ${low} AND ${high}`));
      expect(await revenue(trx, [{ field: 'business_day', op: 'EQ', value: low }])).toBe(
        await independent(trx, sql`business_day = ${low}`),
      );
      expect(between).toBeLessThan(await independent(trx, sql`1 = 1`));
    });
  });

  it('texte (contient, échappé) et nombre : jeu d’essai sur la vue des mouvements', async (ctx) => {
    await snapshot(async (trx) => {
      const synthetic = movesDataset('t_moves');
      const count = async (filters: ExplorationDefinition['filters']) =>
        (
          await explore(
            trx,
            planOf(definitionOf(synthetic, { measures: ['moves'], filters }), {
              datasets: [synthetic],
            }),
          )
        ).rows[0]!.moves as number;
      const independentCount = (predicate: RawBuilder<unknown>) =>
        scalar(
          trx,
          sql<{ v: number }>`SELECT COUNT(move_id) AS v FROM analytics_f_stock_moves
            WHERE business_day ${WINDOW} AND ${predicate}`,
        );
      const types = (
        await sql<{ move_type: string }>`SELECT DISTINCT move_type FROM analytics_f_stock_moves
          ORDER BY move_type`.execute(trx)
      ).rows.map((row) => row.move_type);
      const total = await independentCount(sql`1 = 1`);
      enough(ctx, types.length, 2, 'types de mouvement distincts');
      const withUnderscore = types.filter((type) => type.includes('_'));
      enough(ctx, withUnderscore.length, 1, 'types de mouvement à tiret bas');
      enough(ctx, withUnderscore.length < types.length ? 1 : 0, 1, 'types sans tiret bas');

      // Contient : un fragment réel, comparé à `INSTR` (sans caractère joker).
      const fragment = withUnderscore[0]!.slice(1, 6);
      expect(await count([{ field: 'move_type', op: 'CONTAINS', value: fragment }])).toBe(
        await independentCount(sql`INSTR(move_type, ${fragment}) > 0`),
      );
      // Les jokers de `LIKE` sont des caractères ordinaires : `_` ne vaut pas « un caractère quelconque »,
      // `%` ne vaut pas « tout », et le caractère d'échappement lui-même est un caractère ordinaire.
      const underscores = await count([{ field: 'move_type', op: 'CONTAINS', value: '_' }]);
      expect(underscores).toBe(await independentCount(sql`INSTR(move_type, '_') > 0`));
      expect(underscores).toBeGreaterThan(0);
      expect(underscores).toBeLessThan(total);
      expect(await count([{ field: 'move_type', op: 'CONTAINS', value: '%' }])).toBe(0);
      expect(await count([{ field: 'move_type', op: 'CONTAINS', value: '!' }])).toBe(0);
      expect(await count([{ field: 'move_type', op: 'CONTAINS', value: 'SA_E' }])).toBe(0);
      // Le caractère d'échappement n'échappe pas la lettre qui le suit : `SA!LE` ne vaut pas `SALE`.
      expect(await count([{ field: 'move_type', op: 'CONTAINS', value: 'SA!LE' }])).toBe(0);
      expect(await count([{ field: 'move_type', op: 'CONTAINS', value: 'SALE' }])).toBeGreaterThan(
        0,
      );
      // Nombre : bornes.
      const quantities = (
        await sql<{ q: string }>`SELECT DISTINCT quantity_base AS q FROM analytics_f_stock_moves
          WHERE quantity_base IS NOT NULL ORDER BY quantity_base`.execute(trx)
      ).rows.map((row) => Number(row.q));
      enough(ctx, quantities.length, 3, 'quantités de mouvement distinctes');
      const pivot = quantities[Math.floor(quantities.length / 2)]!;
      expect(await count([{ field: 'quantity_base', op: 'GTE', value: pivot }])).toBe(
        await independentCount(sql`quantity_base >= ${pivot}`),
      );
      expect(await count([{ field: 'quantity_base', op: 'LTE', value: pivot }])).toBe(
        await independentCount(sql`quantity_base <= ${pivot}`),
      );
      expect(
        await count([{ field: 'quantity_base', op: 'BETWEEN', value: [quantities[0]!, pivot] }]),
      ).toBe(await independentCount(sql`quantity_base BETWEEN ${quantities[0]!} AND ${pivot}`));
      expect(await count([{ field: 'quantity_base', op: 'EQ', value: pivot }])).toBe(
        await independentCount(sql`quantity_base = ${pivot}`),
      );
    });
  });

  it('une dimension de type nombre sort en nombre, un jour en AAAA-MM-JJ', async (ctx) => {
    await snapshot(async (trx) => {
      const synthetic = movesDataset('t_typed');
      const result = await explore(
        trx,
        planOf(
          definitionOf(synthetic, {
            measures: ['moves'],
            dimensions: ['quantity_base', 'business_day'],
            limit: 10,
          }),
          { datasets: [synthetic] },
        ),
      );
      enough(ctx, result.rowCount, 1, 'quantités de mouvement');
      for (const row of result.rows) {
        expect(typeof row.quantity_base).toBe('number');
        expect(row.business_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  it('booléen : les contre-écritures du registre de stock, comparées à la source', async (ctx) => {
    await snapshot(async (trx) => {
      const moves = dataset('f_stock_moves');
      const count = async (value: boolean) =>
        (
          await explore(
            trx,
            planOf(
              definitionOf(moves, {
                measures: ['quantity'],
                filters: [{ field: 'is_reversal', op: 'EQ', value }],
              }),
            ),
          )
        ).rows[0]!.quantity as number;
      const reversed = await scalar(
        trx,
        sql<{
          v: string | null;
        }>`SELECT COALESCE(SUM(quantity_base), 0) AS v FROM analytics_f_stock_moves
          WHERE business_day ${WINDOW} AND is_reversal = 1`,
      );
      const plain = await scalar(
        trx,
        sql<{
          v: string | null;
        }>`SELECT COALESCE(SUM(quantity_base), 0) AS v FROM analytics_f_stock_moves
          WHERE business_day ${WINDOW} AND is_reversal = 0`,
      );
      enough(ctx, reversed === 0 ? 0 : 1, 1, 'contre-écritures de stock');
      expect(await count(true)).toBeCloseTo(reversed, 3);
      expect(await count(false)).toBeCloseTo(plain, 3);
    });
  });

  it('une valeur hostile n’entre jamais dans le SQL : elle est un paramètre et ne rend rien', async () => {
    await snapshot(async (trx) => {
      const synthetic = movesDataset('t_hostile');
      const hostile = "x'; DROP TABLE crm_customers; -- %";
      for (const op of ['EQ', 'CONTAINS'] as const) {
        const plan = planOf(
          definitionOf(synthetic, {
            measures: ['moves'],
            filters: [{ field: 'move_type', op, value: hostile }],
          }),
          { datasets: [synthetic] },
        );
        const compiled = compileExploration(plan, ALL_SCOPE, {
          maxExecutionMs: 15_000,
          zoneDescendants: NO_ZONES,
        });
        const text = compiled.rows.compile(db);
        expect(text.sql, op).not.toContain('DROP');
        expect(text.sql, op).not.toContain(hostile);
        expect(
          text.parameters.some((parameter) => String(parameter).includes('DROP TABLE')),
          op,
        ).toBe(true);
        const result = await executeExploration(trx, compiled, LIMITS);
        expect(result.rows[0]!.moves, op).toBe(0);
      }
    });
  });
});

// --- Étendue, tri, total -----------------------------------------------------------------------------------------

describe('période et comptes distincts', () => {
  it('la période borne la colonne de date de la mesure : le jour de l’événement, ou celui de la vente', async (ctx) => {
    await snapshot(async (trx) => {
      const days = (
        await sql<{ d: string }>`SELECT DISTINCT DATE_FORMAT(business_day, '%Y-%m-%d') AS d
          FROM analytics_f_sales_line ORDER BY d`.execute(trx)
      ).rows.map((row) => row.d);
      enough(ctx, days.length, 4, 'jours de vente distincts');
      const fromDay = days[Math.floor(days.length / 4)]!;
      const toDay = days[Math.floor(days.length / 2)]!;
      const window = { code: 'CUSTOM', fromDay, toDay } as const;
      const narrow = (
        await explore(trx, planOf(definitionOf(sales, { period: window, measures: ['revenue'] })))
      ).rows[0]!.revenue as number;
      const wide = (await explore(trx, planOf(definitionOf(sales, { measures: ['revenue'] }))))
        .rows[0]!.revenue as number;
      expect(narrow).toBe(
        await scalar(
          trx,
          sql<{
            v: string | null;
          }>`SELECT COALESCE(SUM(amount_xaf), 0) AS v FROM analytics_f_sales_line
            WHERE business_day BETWEEN ${fromDay} AND ${toDay}`,
        ),
      );
      expect(narrow).toBeLessThan(wide);
      // Une mesure datée par le jour de la vente : la période porte sur `sale_day`, non sur `business_day`.
      const bySaleDay = (
        await explore(
          trx,
          planOf(definitionOf(sales, { period: window, measures: ['net_by_sale_date'] })),
        )
      ).rows[0]!.net_by_sale_date as number;
      expect(bySaleDay).toBe(
        await scalar(
          trx,
          sql<{
            v: string | null;
          }>`SELECT COALESCE(SUM(amount_xaf), 0) AS v FROM analytics_f_sales_line
            WHERE sale_day BETWEEN ${fromDay} AND ${toDay}`,
        ),
      );
    });
  });

  it('un compte distinct compte les ventes, non les lignes', async (ctx) => {
    await snapshot(async (trx) => {
      const distinct = await scalar(
        trx,
        sql<{ v: number }>`SELECT COUNT(DISTINCT counted_sale_id) AS v FROM analytics_f_sales_line
          WHERE business_day ${WINDOW}`,
      );
      const lines = await scalar(
        trx,
        sql<{ v: number }>`SELECT COUNT(counted_sale_id) AS v FROM analytics_f_sales_line
          WHERE business_day ${WINDOW}`,
      );
      enough(ctx, lines > distinct ? 1 : 0, 1, 'ventes à plusieurs lignes');
      const result = await explore(trx, planOf(definitionOf(sales, { measures: ['sales_count'] })));
      expect(result.rows[0]!.sales_count).toBe(distinct);
      expect(result.rows[0]!.sales_count).not.toBe(lines);
    });
  });
});

describe('étendue, tri et total', () => {
  it('l’étendue restreint les lignes comme la clause attendue ; deux étendues se coupent', async (ctx) => {
    await snapshot(async (trx) => {
      const sites = (
        await sql<{ site: Buffer }>`SELECT site_id AS site FROM analytics_f_sales_line
          GROUP BY site_id ORDER BY COUNT(*) DESC, site_id LIMIT 2`.execute(trx)
      ).rows.map((row) => fromBin(row.site));
      enough(ctx, sites.length, 2, 'sites ayant des ventes');
      const [first, second] = sites as [string, string];
      const only = (id: string): ExactScope => ({
        kind: 'CLAUSES',
        clauses: [{ type: 'SITES', ids: [id], viaZoneIds: [] }],
        truncated: false,
      });
      const plan = planOf(definitionOf(sales, { measures: ['revenue'] }));
      const total = (await explore(trx, plan)).rows[0]!.revenue as number;
      const scoped = (await explore(trx, plan, [only(first)])).rows[0]!.revenue as number;
      expect(scoped).toBe(
        await scalar(
          trx,
          sql<{
            v: string | null;
          }>`SELECT COALESCE(SUM(amount_xaf), 0) AS v FROM analytics_f_sales_line
            WHERE business_day ${WINDOW} AND site_id = ${toBin(first)}`,
        ),
      );
      expect(scoped).toBeLessThan(total);
      // Deux permissions exigées : l'intersection de leurs étendues.
      expect((await explore(trx, plan, [only(first), only(second)])).rows[0]!.revenue).toBe(0);
      expect((await explore(trx, plan, [only(first), { kind: 'ALL' }])).rows[0]!.revenue).toBe(
        scoped,
      );
    });
  });

  it('un filtre de zone couvre la zone et ses sous-zones, en égalité, en liste et en exclusion (AV-375, EP-1)', async (ctx) => {
    await snapshot(async (trx) => {
      const zones = (
        await sql<{ zone: Buffer }>`SELECT zone_id AS zone FROM analytics_f_sales_line
          WHERE business_day ${WINDOW} AND zone_id IS NOT NULL
          GROUP BY zone_id ORDER BY COUNT(*) DESC, zone_id LIMIT 1`.execute(trx)
      ).rows.map((row) => fromBin(row.zone));
      enough(ctx, zones.length, 1, 'zones ayant des ventes');
      const child = zones[0]!;
      // Une zone parente neuve, sans vente directe : la zone des ventes devient sa descendante (fermeture transitive).
      const parent = await insertTestZone(trx, await insertTestUser(trx));
      await sql`INSERT INTO organization_zone_ancestors (zone_id, ancestor_id, depth)
        VALUES (${toBin(child)}, ${toBin(parent)}, 1)`.execute(trx);
      const revenueOf = async (filters: ExplorationDefinition['filters']) =>
        (await explore(trx, planOf(definitionOf(sales, { measures: ['revenue'], filters }))))
          .rows[0]!.revenue as number;
      const direct = await revenueOf([{ field: 'zone_id', op: 'EQ', value: child }]);
      const all = await revenueOf([]);
      expect(direct).toBeGreaterThan(0);
      expect(await revenueOf([{ field: 'zone_id', op: 'EQ', value: parent }])).toBe(direct);
      expect(await revenueOf([{ field: 'zone_id', op: 'IN', value: [parent, freshUuid()] }])).toBe(
        direct,
      );
      expect(await revenueOf([{ field: 'zone_id', op: 'NE', value: parent }])).toBe(all - direct);
      // Le compilateur seul, sans descendantes lues : la zone ne couvre qu'elle-même.
      const alone = compileExploration(
        planOf(
          definitionOf(sales, {
            measures: ['revenue'],
            filters: [{ field: 'zone_id', op: 'EQ', value: parent }],
          }),
        ),
        ALL_SCOPE,
        { maxExecutionMs: 15_000, zoneDescendants: NO_ZONES },
      );
      expect((await executeExploration(trx, alone, LIMITS)).rows[0]!.revenue).toBe(0);
    });
  });

  it('le tri demandé, puis les dimensions : un ordre déterministe, identique à chaque exécution', async (ctx) => {
    await snapshot(async (trx) => {
      const plan = planOf(
        definitionOf(sales, {
          measures: ['revenue'],
          dimensions: ['site_id', 'event_kind'],
          sort: [{ field: 'event_kind', direction: 'DESC' }],
        }),
      );
      const first = await explore(trx, plan);
      enough(ctx, first.rowCount, 4, 'groupes site et événement');
      const keys = first.rows.map((row) => [row.event_kind as string, row.site_id as string]);
      const expected = [...keys].sort(
        (a, b) =>
          (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
      );
      expect(keys).toEqual(expected);
      expect((await explore(trx, plan)).rows).toEqual(first.rows);
    });
  });

  it('trier par une mesure : décroissant, puis les dimensions départagent', async (ctx) => {
    await snapshot(async (trx) => {
      const result = await explore(
        trx,
        planOf(
          definitionOf(sales, {
            measures: ['revenue'],
            dimensions: ['business_day'],
            sort: [{ field: 'revenue', direction: 'DESC' }],
          }),
        ),
      );
      enough(ctx, result.rowCount, 3, 'jours de vente');
      const amounts = result.rows.map((row) => row.revenue as number);
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    });
  });

  it('le total est une requête séparée sur toutes les lignes ; sans dimension, c’est la ligne unique ; non additif : aucun', async (ctx) => {
    await snapshot(async (trx) => {
      const grouped = await explore(
        trx,
        planOf(
          definitionOf(sales, {
            measures: ['revenue', 'quantity'],
            dimensions: ['site_id'],
            limit: 1,
          }),
        ),
      );
      enough(ctx, grouped.rowCount, 1, 'groupes de ventes');
      const whole = await explore(
        trx,
        planOf(definitionOf(sales, { measures: ['revenue', 'quantity'] })),
      );
      // Une seule ligne rendue (premier N), mais le total porte sur tous les groupes.
      expect(grouped.rowCount).toBe(1);
      expect(grouped.totals).toEqual({
        revenue: whole.rows[0]!.revenue,
        quantity: whole.rows[0]!.quantity,
      });
      expect(whole.totals).toEqual({
        revenue: whole.rows[0]!.revenue,
        quantity: whole.rows[0]!.quantity,
      });
      const nonAdditive = await explore(
        trx,
        planOf(
          definitionOf(sales, {
            measures: ['revenue', 'sales_count'],
            dimensions: ['site_id'],
            limit: 3,
          }),
        ),
      );
      expect(nonAdditive.totals).toBeNull();
      // Sans dimension, une seule mesure non additive : aucun total non plus.
      const single = await explore(trx, planOf(definitionOf(sales, { measures: ['sales_count'] })));
      expect(single.rowCount).toBe(1);
      expect(single.totals).toBeNull();
    });
  });

  it('le total porte sur les mêmes lignes que le résultat : filtres et étendue compris', async (ctx) => {
    await snapshot(async (trx) => {
      const sites = (
        await sql<{ site: Buffer }>`SELECT site_id AS site FROM analytics_f_sales_line
          GROUP BY site_id ORDER BY COUNT(*) DESC, site_id LIMIT 2`.execute(trx)
      ).rows.map((row) => fromBin(row.site));
      enough(ctx, sites.length, 2, 'sites ayant des ventes');
      const [first] = sites as [string, string];
      const scope: ExactScope = {
        kind: 'CLAUSES',
        clauses: [{ type: 'SITES', ids: [first], viaZoneIds: [] }],
        truncated: false,
      };
      const filtered = await explore(
        trx,
        planOf(
          definitionOf(sales, {
            measures: ['revenue'],
            dimensions: ['event_kind'],
            filters: [{ field: 'event_kind', op: 'EQ', value: 'SALE' }],
          }),
        ),
        [scope],
      );
      const expected = await scalar(
        trx,
        sql<{
          v: string | null;
        }>`SELECT COALESCE(SUM(amount_xaf), 0) AS v FROM analytics_f_sales_line
          WHERE business_day ${WINDOW} AND site_id = ${toBin(first)} AND event_kind = 'SALE'`,
      );
      expect(filtered.rowCount).toBe(1);
      expect(filtered.totals).toEqual({ revenue: expected });
      expect(filtered.rows[0]!.revenue).toBe(expected);
    });
  });

  it('un total absent de la lecture vaut zéro, jamais un nombre inventé', () => {
    const columns = [
      { name: 'revenue', label: 'CA', kind: 'measure', alias: 'm0', unit: 'xaf' },
      { name: 'quantity', label: 'Quantité', kind: 'measure', alias: 'm1', unit: 'quantity' },
    ] as const;
    expect(exploredTotals(columns, {})).toEqual({ revenue: 0, quantity: 0 });
    expect(exploredTotals(columns, { m0: '12500', m1: null })).toEqual({
      revenue: 12500,
      quantity: 0,
    });
  });
});

// --- Limites ----------------------------------------------------------------------------------------------------------

describe('limites en erreur', () => {
  it('au-delà du plafond de lignes : une erreur, jamais une troncature ; à la limite exacte : rendu', async (ctx) => {
    await snapshot(async (trx) => {
      const groups = (
        await explore(
          trx,
          planOf(definitionOf(sales, { measures: ['revenue'], dimensions: ['business_day'] })),
        )
      ).rowCount;
      enough(ctx, groups, 2, 'jours de vente');
      const definition = definitionOf(sales, {
        measures: ['revenue'],
        dimensions: ['business_day'],
      });
      const exact = await explore(trx, planOf(definition, { maxRows: groups }), ALL_SCOPE, {
        maxRows: groups,
        maxExecutionMs: 15_000,
      });
      expect(exact.rowCount).toBe(groups);
      await expect(
        explore(trx, planOf(definition, { maxRows: groups - 1 }), ALL_SCOPE, {
          maxRows: groups - 1,
          maxExecutionMs: 15_000,
        }),
      ).rejects.toMatchObject({ name: 'ExplorationLimitError', limit: 'rows' });
    });
  });

  it('une limite de lignes demandée, sous le plafond, est un « premier N » voulu : N lignes, pas d’erreur', async (ctx) => {
    await snapshot(async (trx) => {
      const result = await explore(
        trx,
        planOf(
          definitionOf(sales, { measures: ['revenue'], dimensions: ['business_day'], limit: 1 }),
        ),
      );
      enough(ctx, result.rowCount, 1, 'jours de vente');
      expect(result.rowCount).toBe(1);
    });
  });

  it('une requête trop longue est interrompue par MAX_EXECUTION_TIME et rendue en erreur de durée', async (ctx) => {
    await snapshot(async (trx) => {
      const moves = await scalar(
        trx,
        sql<{ v: number }>`SELECT COUNT(*) AS v FROM inventory_stock_moves`,
      );
      enough(ctx, moves, 300, 'mouvements de stock');
      const slow: CompiledExploration = {
        columns: [{ name: 'n', label: 'n', kind: 'measure', alias: 'm0', unit: 'count' }],
        rows: sql<Record<string, unknown>>`
          SELECT /*+ MAX_EXECUTION_TIME(30) */ COUNT(*) AS m0
            FROM inventory_stock_moves a
            JOIN inventory_stock_moves b ON a.product_id <> b.product_id
            JOIN inventory_stock_moves c ON c.product_id <> b.product_id`,
        totals: null,
        totalsFromRow: false,
        rowLimit: 10,
      };
      await expect(
        executeExploration(trx, slow, { maxRows: 10, maxExecutionMs: 30 }),
      ).rejects.toMatchObject({ name: 'ExplorationLimitError', limit: 'time' });
    });
  });

  it('l’interruption pour durée se reconnaît à son numéro ou à son code d’erreur ; une autre erreur passe telle quelle', async () => {
    const failing = (error: Error): CompiledExploration => ({
      columns: [],
      rows: {
        execute: async () => {
          throw error;
        },
      } as unknown as RawBuilder<Record<string, unknown>>,
      totals: null,
      totalsFromRow: false,
      rowLimit: 10,
    });
    const limits = { maxRows: 10, maxExecutionMs: 1000 };
    for (const error of [
      Object.assign(new Error('délai'), { errno: 3024 }),
      Object.assign(new Error('délai'), { code: 'ER_QUERY_TIMEOUT' }),
    ]) {
      await expect(executeExploration(db, failing(error), limits)).rejects.toMatchObject({
        name: 'ExplorationLimitError',
        limit: 'time',
      });
    }
    const other = Object.assign(new Error('autre'), { errno: 1064, code: 'ER_PARSE_ERROR' });
    await expect(executeExploration(db, failing(other), limits)).rejects.toBe(other);
  });

  it('la durée maximale est un indice d’optimiseur du SQL compilé, entier et positif', () => {
    const plan = planOf(definitionOf(sales, { measures: ['revenue'] }));
    const text = compileExploration(plan, ALL_SCOPE, {
      maxExecutionMs: 12_345,
      zoneDescendants: NO_ZONES,
    }).rows.compile(db).sql;
    expect(text).toContain('MAX_EXECUTION_TIME(12345)');
    expect(text).toMatch(/LIMIT 10001\s*$/);
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        compileExploration(plan, ALL_SCOPE, { maxExecutionMs: invalid, zoneDescendants: NO_ZONES }),
      ).toThrow(RangeError);
    }
  });

  it('le total est compilé pour le temps qui reste ; sans dimension ou avec une mesure non additive, il n’existe pas (EP-2)', () => {
    const grouped = planOf(
      definitionOf(sales, { measures: ['revenue'], dimensions: ['business_day'] }),
    );
    const compiled = compileExploration(grouped, ALL_SCOPE, {
      maxExecutionMs: 12_345,
      zoneDescendants: NO_ZONES,
    });
    expect(typeof compiled.totals).toBe('function');
    const totals = compiled.totals!;
    const totalSql = totals(7_000).compile(db).sql;
    expect(totalSql).toContain('MAX_EXECUTION_TIME(7000)');
    expect(totalSql).not.toContain('MAX_EXECUTION_TIME(12345)');
    expect(compiled.rows.compile(db).sql).toContain('MAX_EXECUTION_TIME(12345)');
    for (const invalid of [0, 1.5, Number.NaN]) {
      expect(() => totals(invalid)).toThrow(RangeError);
    }
    const flat = compileExploration(
      planOf(definitionOf(sales, { measures: ['revenue'] })),
      ALL_SCOPE,
      { maxExecutionMs: 12_345, zoneDescendants: NO_ZONES },
    );
    expect(flat.totals).toBeNull();
    const nonAdditive = compileExploration(
      planOf(
        definitionOf(dataset('f_production_daily'), {
          measures: ['average_weight'],
          dimensions: ['business_day'],
        }),
      ),
      ALL_SCOPE,
      { maxExecutionMs: 12_345, zoneDescendants: NO_ZONES },
    );
    expect(nonAdditive.totals).toBeNull();
  });

  describe('durée de l’exploration entière : le total reçoit le temps qui reste (EP-2)', () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const fake = (
      rows: Record<string, unknown>[],
      delayMs: number,
    ): RawBuilder<Record<string, unknown>> =>
      ({
        execute: async () => {
          await sleep(delayMs);
          return { rows };
        },
      }) as unknown as RawBuilder<Record<string, unknown>>;
    const columns: CompiledExploration['columns'] = [
      { name: 'n', label: 'n', kind: 'measure', alias: 'm0', unit: 'count' },
    ];

    it('le total est lancé avec un temps restant strictement inférieur à la durée maximale', async () => {
      const remaining: number[] = [];
      const compiled: CompiledExploration = {
        columns,
        rows: fake([{ m0: 1 }], 60),
        totals: (maxExecutionMs) => {
          remaining.push(maxExecutionMs);
          return fake([{ m0: 1 }], 0);
        },
        totalsFromRow: false,
        rowLimit: 10,
      };
      const result = await executeExploration(db, compiled, {
        maxRows: 10,
        maxExecutionMs: 10_000,
      });
      expect(remaining).toHaveLength(1);
      expect(Number.isInteger(remaining[0])).toBe(true);
      expect(remaining[0]).toBeLessThan(10_000);
      expect(remaining[0]).toBeGreaterThan(9_000);
      expect(result.totals).toEqual({ n: 1 });
    });

    it('budget épuisé par les lignes : erreur de durée, le total n’est jamais lancé', async () => {
      let calls = 0;
      const compiled: CompiledExploration = {
        columns,
        rows: fake([{ m0: 1 }], 80),
        totals: () => {
          calls += 1;
          return fake([{ m0: 1 }], 0);
        },
        totalsFromRow: false,
        rowLimit: 10,
      };
      const outcome = executeExploration(db, compiled, { maxRows: 10, maxExecutionMs: 50 });
      await expect(outcome).rejects.toBeInstanceOf(ExplorationLimitError);
      await expect(outcome).rejects.toMatchObject({ limit: 'time' });
      expect(calls).toBe(0);
    });
  });
});

// --- Concurrence par utilisateur --------------------------------------------------------------------------------

describe('requêtes simultanées par utilisateur', () => {
  it('au plus N emplacements tenus par des connexions différentes ; libérés, ils se reprennent', async () => {
    const userId = freshUuid();
    await db.connection().execute(async (one) => {
      await db.connection().execute(async (two) => {
        await db.connection().execute(async (three) => {
          expect(await acquireQuerySlot(one, userId, 2)).toBe(1);
          expect(await acquireQuerySlot(two, userId, 2)).toBe(2);
          expect(await acquireQuerySlot(three, userId, 2)).toBeNull();
          // Un autre utilisateur n'est pas concerné.
          expect(await acquireQuerySlot(three, freshUuid(), 2)).toBe(1);
          await releaseQuerySlot(one, userId, 1);
          expect(await acquireQuerySlot(three, userId, 2)).toBe(1);
          await releaseQuerySlot(three, userId, 1);
          await releaseQuerySlot(two, userId, 2);
        });
      });
    });
  });

  const limits = {
    maxRows: 100,
    maxExecutionMs: 15_000,
    maxConcurrentPerUser: 1,
    maxConcurrentGlobal: 4,
  } as const;
  const simple = (): CompiledExploration =>
    compileExploration(planOf(definitionOf(sales, { measures: ['revenue'] })), ALL_SCOPE, {
      maxExecutionMs: 15_000,
      zoneDescendants: NO_ZONES,
    });

  /**
   * L'emplacement n'est tenu par aucune connexion du bassin : deux connexions épinglées en même temps le prennent
   * l'une après l'autre (la connexion qui l'aurait gardé le reprendrait, l'autre non).
   */
  async function expectSlotFree(userId: string): Promise<void> {
    await db.connection().execute(async (one) => {
      await db.connection().execute(async (two) => {
        for (const connection of [one, two]) {
          expect(await acquireQuerySlot(connection, userId, 1)).toBe(1);
          await releaseQuerySlot(connection, userId, 1);
        }
      });
    });
  }

  it('une requête sous un emplacement tenu est refusée en erreur de concurrence, puis passe une fois libéré', async () => {
    const userId = freshUuid();
    await db.connection().execute(async (holder) => {
      expect(await acquireQuerySlot(holder, userId, 1)).toBe(1);
      const refused = runExploration(db, { userId, compiled: simple(), limits });
      await expect(refused).rejects.toBeInstanceOf(ExplorationLimitError);
      await expect(refused).rejects.toMatchObject({ limit: 'concurrency' });
      await releaseQuerySlot(holder, userId, 1);
    });
    const result = await runExploration(db, { userId, compiled: simple(), limits });
    expect(result.rowCount).toBe(1);
    await expectSlotFree(userId);
  });

  it('plafond global : tous les emplacements globaux tenus, la requête est refusée et rend celui de l’utilisateur (AV-461)', async () => {
    const userId = freshUuid();
    const capped = { ...limits, maxConcurrentGlobal: 1 };
    await db.connection().execute(async (holder) => {
      expect(await acquireGlobalQuerySlot(holder, 1)).toBe(1);
      const refused = runExploration(db, { userId, compiled: simple(), limits: capped });
      await expect(refused).rejects.toMatchObject({ limit: 'concurrency' });
      await expectSlotFree(userId);
      await releaseGlobalQuerySlot(holder, 1);
    });
    expect(
      (await runExploration(db, { userId, compiled: simple(), limits: capped })).rowCount,
    ).toBe(1);
    await db.connection().execute(async (probe) => {
      // Rendu après la requête : un autre utilisateur le reprend.
      expect(await acquireGlobalQuerySlot(probe, 1)).toBe(1);
      await releaseGlobalQuerySlot(probe, 1);
    });
  });

  it('une requête en cours tient l’emplacement global : une autre est refusée, puis passe une fois la première terminée (EP-2)', async () => {
    // L'emplacement global est un verrou nommé, partagé par tout le serveur MySQL : l'essai échoue si un autre
    // processus de la même instance (serveur de développement, autre suite) tient l'emplacement 1.
    const userA = freshUuid();
    const userB = freshUuid();
    const capped = { ...limits, maxConcurrentGlobal: 1 };
    const slow = runExploration(db, {
      userId: userA,
      compiled: { ...simple(), rows: sql<Record<string, unknown>>`SELECT SLEEP(0.5) AS m0` },
      limits: capped,
    });
    try {
      let held = false;
      const deadline = Date.now() + 5_000;
      while (!held && Date.now() < deadline) {
        const { rows } = await sql<{ holder: string | number | null }>`
          SELECT IS_USED_LOCK(${globalQuerySlotName(1)}) AS holder`.execute(db);
        held = rows[0]?.holder !== null && rows[0]?.holder !== undefined;
        if (!held) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(held).toBe(true);
      const refused = runExploration(db, { userId: userB, compiled: simple(), limits: capped });
      await expect(refused).rejects.toMatchObject({ limit: 'concurrency' });
      await expectSlotFree(userB);
    } finally {
      await slow;
    }
    expect(
      (await runExploration(db, { userId: userB, compiled: simple(), limits: capped })).rowCount,
    ).toBe(1);
    await db.connection().execute(async (probe) => {
      expect(await acquireGlobalQuerySlot(probe, 1)).toBe(1);
      await releaseGlobalQuerySlot(probe, 1);
    });
  });

  it('l’emplacement est rendu après une erreur de lecture ; la lecture est en lecture seule', async () => {
    const userId = freshUuid();
    const broken: CompiledExploration = {
      ...simple(),
      rows: sql<Record<string, unknown>>`SELECT nothing FROM analytics_f_does_not_exist`,
    };
    await expect(runExploration(db, { userId, compiled: broken, limits })).rejects.toBeInstanceOf(
      Error,
    );
    await expectSlotFree(userId);
    expect((await runExploration(db, { userId, compiled: simple(), limits })).rowCount).toBe(1);
    await expectSlotFree(userId);
    const writing: CompiledExploration = {
      ...simple(),
      rows: sql<Record<string, unknown>>`
        INSERT INTO analytics_query_log (id, user_id, dataset, definition, outcome)
        VALUES (UNHEX(REPLACE(UUID(), '-', '')), UNHEX(REPLACE(${userId}, '-', '')), 'x', JSON_OBJECT(), 'OK')`,
    };
    await expect(runExploration(db, { userId, compiled: writing, limits })).rejects.toThrow(
      /READ ONLY/i,
    );
  });
});

// --- Limites paramétrées et journal ----------------------------------------------------------------------------

describe('limites paramétrées et journal', () => {
  it('les limites sont celles des paramètres semés', async () => {
    expect(await readExplorerLimits(db, new Date(Date.now() + 60_000))).toEqual(
      DEFAULT_EXPLORER_LIMITS,
    );
  });

  it('une version plus récente d’un paramètre l’emporte ; une valeur mal formée retombe sur le défaut', async () => {
    await withTestUow(async (trx) => {
      const author = await insertTestUser(trx);
      const at = new Date(Date.now() + 60_000);
      for (const [key, value] of [
        ['analytics.query_max_rows', 250],
        ['analytics.query_max_execution_ms', 'beaucoup'],
        ['analytics.query_max_concurrent_per_user', 0],
        ['analytics.query_max_concurrent_global', 0],
        ['analytics.query_max_period_days', 90.5],
      ] as const) {
        await trx
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key,
            value: JSON.stringify(value),
            scope_type: 'GLOBAL',
            valid_from: new Date(at.getTime() - 1000),
            created_by: toBin(author),
          })
          .execute();
      }
      expect(await readExplorerLimits(trx, at)).toEqual({
        ...DEFAULT_EXPLORER_LIMITS,
        maxRows: 250,
      });
    });
  });

  it('le journal consigne la requête, le résultat et la durée, y compris un refus', async () => {
    await withTestUow(async (trx) => {
      const userId = await insertTestUser(trx);
      const definition = { dataset: 'f_sales_line', measures: ['revenue'], catalogVersion: 1 };
      const ok = freshUuid();
      const refused = freshUuid();
      await recordQueryLog(trx, {
        id: ok,
        userId,
        dataset: 'f_sales_line',
        definition,
        outcome: 'OK',
        rowCount: 12,
        durationMs: 34,
      });
      await recordQueryLog(trx, {
        id: refused,
        userId,
        dataset: 'f_sales_line',
        definition,
        outcome: 'REFUSED',
        errorCode: 'FORBIDDEN_MEASURE',
      });
      const logged = await trx
        .selectFrom('analytics_query_log')
        .select(['id', 'outcome', 'error_code', 'row_count', 'duration_ms', 'definition'])
        .where('user_id', '=', toBin(userId))
        .orderBy('outcome')
        .execute();
      expect(
        logged.map((row) => [row.outcome, row.error_code, row.row_count, row.duration_ms]),
      ).toEqual([
        ['OK', null, 12, 34],
        ['REFUSED', 'FORBIDDEN_MEASURE', null, null],
      ]);
      expect(logged[0]!.definition).toEqual(definition);
    });
  });
});

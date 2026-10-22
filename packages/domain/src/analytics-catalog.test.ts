import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_CATALOG_VERSION,
  ANALYTICS_DATASETS,
  EXPLORATION_LIMITS,
  analyticsCatalogIssues,
  datasetOf,
  validateExploration,
  type DatasetDefinition,
  type ExplorationContext,
  type ExplorationDefinition,
} from './analytics-catalog.js';

const CONTEXT: ExplorationContext = {
  today: '2026-10-14',
  canReadValuation: false,
  maxDetailDays: 1095,
  maxRows: 10_000,
};

const SITE = '0191a3f0-0000-7000-8000-0000000000aa';

function weeklySales(overrides: Partial<ExplorationDefinition> = {}): ExplorationDefinition {
  return {
    dataset: 'f_sales_line',
    period: { code: 'WEEK' },
    dimensions: ['commercial_user_id'],
    measures: ['revenue', 'quantity'],
    filters: [],
    sort: [{ field: 'revenue', direction: 'DESC' }],
    ...overrides,
  };
}

describe('catalogue de la couche sémantique (D11, dictionnaire 12-analytics)', () => {
  it('déclare les treize jeux du dictionnaire, sans incohérence interne', () => {
    expect(ANALYTICS_DATASETS.map((d) => d.code)).toEqual([
      'f_sales_line',
      'f_orders',
      'f_payments',
      'f_stock_moves',
      'f_stock_balance',
      'f_losses',
      'f_prospecting',
      'f_attendance',
      'f_production_daily',
      'f_costs',
      'f_expenses',
      'f_cash',
      'f_purchases',
    ]);
    expect(analyticsCatalogIssues()).toEqual([]);
  });

  it('chaque vue porte le préfixe analytics_ et chaque jeu au moins une mesure', () => {
    for (const dataset of ANALYTICS_DATASETS) {
      expect(dataset.view).toBe(`analytics_${dataset.code}`);
      expect(dataset.measures.length).toBeGreaterThan(0);
      expect(dataset.permissions.length).toBeGreaterThan(0);
    }
  });

  it('valeurs au coût : coût, marge, valeur du stock, perte, achat, coût sont protégés (AV-422)', () => {
    const protectedMeasures = ANALYTICS_DATASETS.flatMap((d) =>
      d.measures.filter((m) => m.protected === true).map((m) => `${d.code}.${m.name}`),
    );
    expect(protectedMeasures.sort()).toEqual([
      'f_costs.amount',
      'f_losses.pending_value',
      'f_losses.value',
      'f_purchases.amount',
      'f_sales_line.cost',
      'f_sales_line.margin',
      'f_stock_balance.value',
      'f_stock_moves.value',
    ]);
  });

  it('f_sales_line : deux dates, pas de dimension « lot » (grain ligne × événement, AV-424)', () => {
    const sales = datasetOf('f_sales_line')!;
    const names = sales.dimensions.map((d) => d.name);
    expect(names).toContain('business_day');
    expect(names).toContain('sale_day');
    expect(names).not.toContain('lot');
    expect(names).not.toContain('stock_lot_id');
    expect(sales.measures.find((m) => m.name === 'net_by_sale_date')?.periodDimension).toBe(
      'sale_day',
    );
  });

  it('f_attendance : portée par la zone déclarée et par la personne (règle fermée pour le site)', () => {
    const attendance = datasetOf('f_attendance')!;
    expect(attendance.scope.SITE).toBeUndefined();
    expect(attendance.scope.ZONE).toEqual(['zone_id']);
    expect(attendance.scope.PERSON).toEqual(['user_id']);
  });

  it('un catalogue défectueux est détecté', () => {
    const broken: DatasetDefinition = {
      code: 'f_broken',
      label: 'Cassé',
      view: 'analytics_f_broken',
      temporality: 'FLOW',
      permissions: [],
      periodDimension: 'day',
      scope: {},
      dimensions: [
        { name: 'day', label: 'Jour', type: 'text' },
        { name: 'day', label: 'Jour bis', type: 'text' },
        { name: 'amount', label: 'Montant', type: 'number' },
      ],
      measures: [
        {
          name: 'amount',
          label: 'Montant',
          aggregate: 'SUM',
          column: 'a',
          unit: 'xaf',
          additive: true,
        },
        {
          name: 'amount',
          label: 'Montant bis',
          aggregate: 'SUM',
          column: 'a',
          unit: 'xaf',
          additive: true,
          periodDimension: 'nowhere',
        },
      ],
    };
    const issues = analyticsCatalogIssues([broken, broken]);
    expect(issues).toEqual(
      expect.arrayContaining([
        'Jeu en double : f_broken',
        'f_broken : aucune permission',
        'f_broken : aucune colonne de portée',
        'f_broken : dimension en double day',
        'f_broken : dimension de période absente ou non datée',
        'f_broken : mesure en double amount',
        'f_broken : amount est à la fois dimension et mesure',
        'f_broken.amount : dimension de période inconnue',
      ]),
    );
  });
});

describe('validateExploration (BR-ANA-006, D11 §8)', () => {
  it('accepte une exploration déclarée et rend le plan normalisé', () => {
    const result = validateExploration(weeklySales(), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.dataset.code).toBe('f_sales_line');
    expect(result.plan.period).toMatchObject({ fromDay: '2026-10-12', toDay: '2026-10-18' });
    expect(result.plan.periodDimension).toBe('business_day');
    expect(result.plan.dimensions.map((d) => d.name)).toEqual(['commercial_user_id']);
    expect(result.plan.measures.map((m) => m.name)).toEqual(['revenue', 'quantity']);
    expect(result.plan.limit).toBe(10_000);
    expect(result.plan.totalsAllowed).toBe(true);
    expect(result.plan.catalogVersion).toBe(ANALYTICS_CATALOG_VERSION);
  });

  it('jeu, dimension, mesure ou filtre inconnus : ANALYTICS_FIELD_UNKNOWN', () => {
    expect(validateExploration(weeklySales({ dataset: 'sales_sales' }), CONTEXT)).toMatchObject({
      ok: false,
      code: 'ANALYTICS_FIELD_UNKNOWN',
      field: 'dataset',
    });
    expect(validateExploration(weeklySales({ dimensions: ['password'] }), CONTEXT)).toMatchObject({
      ok: false,
      code: 'ANALYTICS_FIELD_UNKNOWN',
      field: 'password',
    });
    expect(
      validateExploration(weeklySales({ measures: ['1; DROP TABLE'] }), CONTEXT),
    ).toMatchObject({
      ok: false,
      code: 'ANALYTICS_FIELD_UNKNOWN',
    });
    expect(
      validateExploration(
        weeklySales({ filters: [{ field: 'secret', op: 'EQ', value: 'x' }] }),
        CONTEXT,
      ),
    ).toMatchObject({ ok: false, code: 'ANALYTICS_FIELD_UNKNOWN', field: 'secret' });
  });

  it('mesure protégée sans le droit de valorisation : FORBIDDEN_MEASURE ; avec le droit : acceptée', () => {
    const definition = weeklySales({ measures: ['revenue', 'margin'] });
    expect(validateExploration(definition, CONTEXT)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN_MEASURE',
      field: 'margin',
    });
    expect(validateExploration(definition, { ...CONTEXT, canReadValuation: true }).ok).toBe(true);
  });

  it('période obligatoire pour un jeu daté, interdite pour un jeu d’état', () => {
    expect(
      validateExploration(
        { ...weeklySales(), period: undefined } as ExplorationDefinition,
        CONTEXT,
      ),
    ).toMatchObject({ ok: false, code: 'ANALYTICS_PERIOD_REQUIRED' });

    const balance: ExplorationDefinition = {
      dataset: 'f_stock_balance',
      dimensions: ['location_id'],
      measures: ['available'],
      filters: [],
      sort: [],
    };
    const ok = validateExploration(balance, CONTEXT);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.plan.period).toBeNull();
    expect(validateExploration({ ...balance, period: { code: 'TODAY' } }, CONTEXT)).toMatchObject({
      ok: false,
      code: 'ANALYTICS_DEFINITION_INVALID',
      field: 'period',
    });
  });

  it('période trop longue : PERIOD_TOO_LONG ; plage personnalisée incomplète : définition invalide', () => {
    expect(
      validateExploration(
        weeklySales({ period: { code: 'CUSTOM', fromDay: '2020-01-01', toDay: '2026-10-14' } }),
        CONTEXT,
      ),
    ).toMatchObject({ ok: false, code: 'PERIOD_TOO_LONG' });
    expect(
      validateExploration(
        weeklySales({ period: { code: 'CUSTOM', fromDay: '2026-10-01' } }),
        CONTEXT,
      ),
    ).toMatchObject({ ok: false, code: 'ANALYTICS_DEFINITION_INVALID', field: 'period' });
  });

  it('deux mesures de dates différentes : ANALYTICS_MIXED_PERIOD_BASIS (ADR-074 §3)', () => {
    expect(
      validateExploration(weeklySales({ measures: ['revenue', 'net_by_sale_date'] }), CONTEXT),
    ).toMatchObject({ ok: false, code: 'ANALYTICS_MIXED_PERIOD_BASIS' });
    const alone = validateExploration(
      weeklySales({ measures: ['net_by_sale_date'], sort: [] }),
      CONTEXT,
    );
    expect(alone.ok).toBe(true);
    if (alone.ok) expect(alone.plan.periodDimension).toBe('sale_day');
  });

  it('limite de lignes : au-delà du maximum, QUERY_LIMIT_EXCEEDED ; limite invalide refusée', () => {
    expect(validateExploration(weeklySales({ limit: 10_001 }), CONTEXT)).toMatchObject({
      ok: false,
      code: 'QUERY_LIMIT_EXCEEDED',
    });
    expect(validateExploration(weeklySales({ limit: 10_000 }), CONTEXT).ok).toBe(true);
    for (const limit of [0, -1, 1.5]) {
      expect(validateExploration(weeklySales({ limit }), CONTEXT)).toMatchObject({
        ok: false,
        code: 'ANALYTICS_DEFINITION_INVALID',
      });
    }
  });

  it('mesures non additives : aucun total rendu', () => {
    const result = validateExploration(
      weeklySales({ measures: ['sales_count'], sort: [] }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.totalsAllowed).toBe(false);
  });

  it('structure : au moins une mesure, bornes, doublons, tri sur un champ demandé', () => {
    const bad = (partial: Partial<ExplorationDefinition>) =>
      validateExploration(weeklySales(partial), CONTEXT);
    expect(bad({ measures: [] })).toMatchObject({
      ok: false,
      code: 'ANALYTICS_DEFINITION_INVALID',
    });
    expect(bad({ dimensions: ['site_id', 'site_id'] })).toMatchObject({ ok: false });
    expect(bad({ measures: ['revenue', 'revenue'] })).toMatchObject({ ok: false });
    expect(
      bad({
        sort: [
          { field: 'quantity', direction: 'ASC' },
          { field: 'cost', direction: 'ASC' },
        ],
      }),
    ).toMatchObject({
      ok: false,
    });
    expect(bad({ sort: [{ field: 'discount', direction: 'ASC' }] })).toMatchObject({
      ok: false,
      code: 'ANALYTICS_DEFINITION_INVALID',
      field: 'discount',
    });
    const manyDimensions = datasetOf('f_sales_line')!
      .dimensions.slice(0, EXPLORATION_LIMITS.maxDimensions + 1)
      .map((d) => d.name);
    expect(bad({ dimensions: manyDimensions })).toMatchObject({ ok: false });
    const manyFilters = Array.from({ length: EXPLORATION_LIMITS.maxFilters + 1 }, () => ({
      field: 'site_id',
      op: 'EQ' as const,
      value: SITE,
    }));
    expect(bad({ filters: manyFilters })).toMatchObject({ ok: false });
    const manyMeasures = datasetOf('f_sales_line')!.measures.map((m) => m.name);
    expect(bad({ measures: [...manyMeasures, 'x1', 'x2', 'x3', 'x4'] })).toMatchObject({
      ok: false,
    });
  });

  describe('filtres', () => {
    const withFilter = (field: string, op: string, value: unknown) =>
      validateExploration(
        weeklySales({
          filters: [{ field, op: op as 'EQ', value }],
        }),
        CONTEXT,
      );

    it('accepte les opérateurs et valeurs de chaque type', () => {
      expect(withFilter('site_id', 'EQ', SITE).ok).toBe(true);
      expect(withFilter('site_id', 'IN', [SITE]).ok).toBe(true);
      expect(withFilter('channel', 'NE', 'TERRAIN').ok).toBe(true);
      expect(withFilter('business_day', 'BETWEEN', ['2026-10-12', '2026-10-14']).ok).toBe(true);
      expect(withFilter('business_day', 'GTE', '2026-10-12').ok).toBe(true);
    });

    it('refuse un opérateur étranger au type, une valeur mal formée, un intervalle inversé', () => {
      expect(withFilter('site_id', 'CONTAINS', 'x')).toMatchObject({
        ok: false,
        code: 'ANALYTICS_DEFINITION_INVALID',
      });
      expect(withFilter('site_id', 'EQ', 'pas-un-uuid')).toMatchObject({ ok: false });
      expect(withFilter('site_id', 'IN', [])).toMatchObject({ ok: false });
      expect(withFilter('site_id', 'IN', 'seul')).toMatchObject({ ok: false });
      expect(withFilter('channel', 'EQ', "a'; DROP TABLE x;--")).toMatchObject({ ok: false });
      expect(withFilter('business_day', 'EQ', '2026-13-45x')).toMatchObject({ ok: false });
      expect(withFilter('business_day', 'BETWEEN', ['2026-10-14', '2026-10-12'])).toMatchObject({
        ok: false,
      });
      expect(withFilter('business_day', 'BETWEEN', ['2026-10-12'])).toMatchObject({ ok: false });
    });

    it('limite le nombre de valeurs d’un IN', () => {
      const tooMany = Array.from({ length: EXPLORATION_LIMITS.maxInValues + 1 }, () => SITE);
      expect(withFilter('site_id', 'IN', tooMany)).toMatchObject({ ok: false });
    });

    it('booléen et nombre (jeu de présences)', () => {
      const attendance = (filters: ExplorationDefinition['filters']) =>
        validateExploration(
          {
            dataset: 'f_attendance',
            period: { code: 'MONTH' },
            dimensions: ['user_id'],
            measures: ['sessions'],
            filters,
            sort: [],
          },
          CONTEXT,
        );
      expect(attendance([{ field: 'override', op: 'EQ', value: true }]).ok).toBe(true);
      expect(attendance([{ field: 'override', op: 'EQ', value: 'oui' }]).ok).toBe(false);
      expect(attendance([{ field: 'override', op: 'IN', value: [true] }]).ok).toBe(false);
    });
  });
});

describe('document source d’une ligne (P9-21 ; BR-ANA-010 niveau 2, AV-499)', () => {
  const withSource = ANALYTICS_DATASETS.filter((dataset) => dataset.source !== undefined);

  it('onze jeux de lignes détaillées déclarent leur document ; les jeux d’agrégats n’en ont pas', () => {
    expect(withSource.map((dataset) => dataset.code).sort()).toEqual([
      'f_attendance',
      'f_cash',
      'f_costs',
      'f_expenses',
      'f_losses',
      'f_orders',
      'f_payments',
      'f_prospecting',
      'f_purchases',
      'f_sales_line',
      'f_stock_moves',
    ]);
    expect(datasetOf('f_stock_balance')!.source).toBeUndefined();
    expect(datasetOf('f_production_daily')!.source).toBeUndefined();
  });

  it('la dimension du document existe dans le jeu, de type id, et la route est une route de lecture', () => {
    for (const dataset of withSource) {
      const source = dataset.source!;
      const dimension = dataset.dimensions.find((d) => d.name === source.dimension);
      expect(dimension, `${dataset.code} : dimension ${source.dimension}`).toBeDefined();
      expect(dimension!.type).toBe('id');
      expect(source.type).toMatch(/^[A-Z_]+$/);
      expect(source.route).toMatch(/^\/api\/v1\/[a-z-]+(\/\{id\})?$/);
    }
    expect(datasetOf('f_sales_line')!.source).toEqual({
      dimension: 'sale_id',
      type: 'SALE',
      route: '/api/v1/sales/{id}',
    });
  });

  it('regrouper par le document est une exploration valide (une ligne par document)', () => {
    const result = validateExploration(
      {
        dataset: 'f_sales_line',
        period: { code: 'WEEK' },
        dimensions: ['sale_id'],
        measures: ['revenue'],
        filters: [],
        sort: [],
      },
      CONTEXT,
    );
    expect(result.ok).toBe(true);
  });

  it('le catalogue reste sain (noms uniques, périodes et portées déclarées)', () => {
    expect(analyticsCatalogIssues()).toEqual([]);
  });
});

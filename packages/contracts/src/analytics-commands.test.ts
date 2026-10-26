import { ANALYTICS_DATASETS } from '@gic/domain';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_COMMAND_TYPES,
  analyticsExportRequestPayloadSchema,
  analyticsQueryRequestSchema,
  analyticsViewDeletePayloadSchema,
  analyticsViewSavePayloadSchema,
  analyticsViewSetDefaultPayloadSchema,
  analyticsViewSharePayloadSchema,
  explorationDefinitionSchema,
} from './analytics-commands.js';
import { analyticsCatalogResponseSchema, catalogDatasetView } from './analytics-reads.js';
import { commandTypeSchema } from './command-envelope.js';

const SITE = '0198c3a0-1111-7aaa-8bbb-000000000001';

const definition = {
  dataset: 'f_sales_line',
  period: { code: 'WEEK' },
  dimensions: ['commercial_user_id'],
  measures: ['revenue'],
  filters: [{ field: 'site_id', op: 'EQ', value: SITE }],
  sort: [{ field: 'revenue', direction: 'DESC' }],
};

describe('définition d’exploration (forme)', () => {
  it('accepte une définition complète et applique les valeurs par défaut', () => {
    expect(explorationDefinitionSchema.safeParse(definition).success).toBe(true);
    const minimal = explorationDefinitionSchema.parse({
      dataset: 'f_stock_balance',
      measures: ['available'],
    });
    expect(minimal.dimensions).toEqual([]);
    expect(minimal.filters).toEqual([]);
    expect(minimal.sort).toEqual([]);
  });

  it('refuse un nom de champ qui n’est pas un identifiant déclarable (aucune requête libre)', () => {
    for (const bad of ['Revenue', '1; DROP TABLE', 'a b', '', 'x'.repeat(61), 'a-b']) {
      expect(
        explorationDefinitionSchema.safeParse({ ...definition, measures: [bad] }).success,
      ).toBe(false);
      expect(
        explorationDefinitionSchema.safeParse({ ...definition, dimensions: [bad] }).success,
      ).toBe(false);
    }
    expect(
      explorationDefinitionSchema.safeParse({ ...definition, dataset: 'F_SALES' }).success,
    ).toBe(false);
  });

  it('au moins une mesure, bornes de structure, limite entre 1 et 100 000', () => {
    expect(explorationDefinitionSchema.safeParse({ ...definition, measures: [] }).success).toBe(
      false,
    );
    expect(
      explorationDefinitionSchema.safeParse({
        ...definition,
        dimensions: Array.from({ length: 7 }, (_, i) => `d${i}`),
      }).success,
    ).toBe(false);
    expect(explorationDefinitionSchema.safeParse({ ...definition, limit: 0 }).success).toBe(false);
    expect(explorationDefinitionSchema.safeParse({ ...definition, limit: 100_001 }).success).toBe(
      false,
    );
    expect(explorationDefinitionSchema.safeParse({ ...definition, limit: 100_000 }).success).toBe(
      true,
    );
  });

  it('période : plage personnalisée avec ses deux bornes, période nommée sans borne', () => {
    const base = { ...definition };
    expect(
      explorationDefinitionSchema.safeParse({
        ...base,
        period: { code: 'CUSTOM', fromDay: '2026-10-01', toDay: '2026-10-10' },
      }).success,
    ).toBe(true);
    for (const period of [
      { code: 'CUSTOM' },
      { code: 'CUSTOM', fromDay: '2026-10-01' },
      { code: 'WEEK', fromDay: '2026-10-01', toDay: '2026-10-10' },
      { code: 'CUSTOM', fromDay: '2026-02-30', toDay: '2026-03-01' },
      { code: 'QUARTER' },
    ]) {
      expect(explorationDefinitionSchema.safeParse({ ...base, period }).success).toBe(false);
    }
  });

  it('filtre : opérateurs du domaine, valeur scalaire ou liste bornée', () => {
    const withFilter = (filter: unknown) =>
      explorationDefinitionSchema.safeParse({ ...definition, filters: [filter] }).success;
    expect(withFilter({ field: 'site_id', op: 'IN', value: [SITE, SITE] })).toBe(true);
    expect(withFilter({ field: 'site_id', op: 'LIKE', value: '%' })).toBe(false);
    expect(withFilter({ field: 'site_id', op: 'IN', value: [] })).toBe(false);
    expect(withFilter({ field: 'site_id', op: 'EQ', value: { $ne: null } })).toBe(false);
    expect(withFilter({ field: 'Site', op: 'EQ', value: SITE })).toBe(false);
  });
});

describe('requête, vues, exports', () => {
  it('requête : une définition ou une vue, pas les deux', () => {
    expect(analyticsQueryRequestSchema.safeParse({ definition }).success).toBe(true);
    expect(analyticsQueryRequestSchema.safeParse({ viewId: SITE }).success).toBe(true);
    expect(analyticsQueryRequestSchema.safeParse({}).success).toBe(false);
    expect(analyticsQueryRequestSchema.safeParse({ definition, viewId: SITE }).success).toBe(false);
  });

  it('sauvegarde : nom, définition, version du catalogue', () => {
    expect(
      analyticsViewSavePayloadSchema.safeParse({
        name: 'Ventes de la semaine',
        definition,
        catalogVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      analyticsViewSavePayloadSchema.safeParse({ name: '', definition, catalogVersion: 1 }).success,
    ).toBe(false);
    expect(
      analyticsViewSavePayloadSchema.safeParse({ name: 'x', definition, catalogVersion: 0 })
        .success,
    ).toBe(false);
  });

  it('partage par rôles ; vue par défaut d’un rôle ou retrait ; suppression sans charge utile', () => {
    expect(analyticsViewSharePayloadSchema.safeParse({ roles: [] }).success).toBe(true);
    expect(analyticsViewSharePayloadSchema.safeParse({ roles: ['RESP_COMMERCIAL'] }).success).toBe(
      true,
    );
    expect(analyticsViewSharePayloadSchema.safeParse({ roles: ['resp'] }).success).toBe(false);
    expect(analyticsViewSetDefaultPayloadSchema.safeParse({ roleCode: null }).success).toBe(true);
    expect(analyticsViewSetDefaultPayloadSchema.safeParse({ roleCode: 'DIRECTION' }).success).toBe(
      true,
    );
    expect(analyticsViewDeletePayloadSchema.safeParse({}).success).toBe(true);
  });

  it('export : CSV ou XLSX seulement', () => {
    expect(
      analyticsExportRequestPayloadSchema.safeParse({
        definition,
        format: 'CSV',
        catalogVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      analyticsExportRequestPayloadSchema.safeParse({
        definition,
        format: 'XLSX',
        catalogVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      analyticsExportRequestPayloadSchema.safeParse({
        definition,
        format: 'PDF',
        catalogVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('types de commande conformes au registre', () => {
    for (const type of Object.values(ANALYTICS_COMMAND_TYPES)) {
      expect(commandTypeSchema.safeParse(type).success).toBe(true);
    }
  });
});

describe('catalogue rendu au lecteur', () => {
  it('marque interdites les mesures protégées sans le droit de valorisation', () => {
    const sales = ANALYTICS_DATASETS.find((d) => d.code === 'f_sales_line')!;
    const without = catalogDatasetView(sales, false);
    const forbidden = without.measures.filter((m) => m.forbidden).map((m) => m.name);
    expect(forbidden.sort()).toEqual(['cost', 'margin']);
    const withRight = catalogDatasetView(sales, true);
    expect(withRight.measures.some((m) => m.forbidden)).toBe(false);
  });

  it('la réponse de catalogue valide son propre schéma', () => {
    const response = {
      version: 1,
      datasets: ANALYTICS_DATASETS.map((d) => catalogDatasetView(d, false)),
    };
    expect(analyticsCatalogResponseSchema.safeParse(response).success).toBe(true);
  });
});

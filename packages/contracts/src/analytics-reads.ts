/**
 * Réponses des lectures d'`analytics` (P9 ; D11 §4, §7.2 ; ADR-074 à ADR-077) :
 * - `POST /api/v1/analytics/query` (explorateur) et `GET /api/v1/analytics/catalog` ;
 * - `GET /api/v1/analytics/dashboards/{code}` (tour de contrôle et tableaux de rôle ; le tableau de
 *   distribution garde son contrat, `distribution-dashboard.ts`) ;
 * - `GET /api/v1/analytics/snapshots/me`, `/views`, `/exports`.
 *
 * Tout indicateur est **calculé** (BR-ANA-001). Une mesure masquée (valeur au coût sans
 * `inventory.valuation.read`) vaut `null` dans un tableau et est refusée par l'explorateur
 * (`FORBIDDEN_MEASURE`, ADR-074 §7).
 */
import {
  ALERT_SEVERITIES,
  ANALYTICS_PERIOD_CODES,
  type DatasetDefinition,
  type DimensionType,
  type MeasureAggregate,
  type MeasureUnit,
} from '@gic/domain';
import { z } from 'zod';
import { ANALYTICS_EXPORT_FORMATS, explorationDefinitionSchema } from './analytics-commands.js';

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().min(1).max(40);
const count = z.number().int().nonnegative();

export const analyticsPeriodSchema = z.object({
  code: z.enum(ANALYTICS_PERIOD_CODES),
  fromDay: day,
  toDay: day,
  days: z.number().int().min(1),
});
export type AnalyticsPeriodView = z.infer<typeof analyticsPeriodSchema>;

/** Fraîcheur (BR-ANA-005) : dernier calcul et appareils du périmètre en retard de synchronisation. */
export const analyticsFreshnessSchema = z.object({
  computedAt: instant,
  devicesInScope: count,
  staleDevices: count,
  staleAfterHours: z.number().positive(),
});
export type AnalyticsFreshness = z.infer<typeof analyticsFreshnessSchema>;

// --- Explorateur ------------------------------------------------------------------------------------------

export const queryColumnSchema = z.object({
  name: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  kind: z.enum(['dimension', 'measure']),
  unit: z.enum(['xaf', 'quantity', 'count', 'minutes', 'kg', 'pct']).optional(),
  dimensionType: z.enum(['date', 'id', 'code', 'text', 'boolean', 'number']).optional(),
});

/** Une ligne : valeur par colonne ; l'identifiant du document source quand le grain le permet (BR-ANA-010). */
export const queryRowSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  source: z
    .object({ type: z.string().min(1).max(40), id: uuid, route: z.string().min(1).max(200) })
    .nullable()
    .optional(),
});

export const analyticsQueryResponseSchema = z.object({
  dataset: z.string().min(1).max(60),
  catalogVersion: z.number().int().min(1),
  period: analyticsPeriodSchema.nullable(),
  columns: z.array(queryColumnSchema).min(1),
  rows: z.array(queryRowSchema),
  rowCount: count,
  /** Totaux des mesures additives ; `null` si une mesure n'est pas additive. */
  totals: z.record(z.string(), z.number()).nullable(),
  freshness: analyticsFreshnessSchema,
});
export type AnalyticsQueryResponse = z.infer<typeof analyticsQueryResponseSchema>;

export const catalogDimensionSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['date', 'id', 'code', 'text', 'boolean', 'number']),
});
export const catalogMeasureSchema = z.object({
  name: z.string(),
  label: z.string(),
  aggregate: z.enum(['SUM', 'COUNT', 'COUNT_DISTINCT', 'AVG', 'MAX']),
  unit: z.enum(['xaf', 'quantity', 'count', 'minutes', 'kg', 'pct']),
  additive: z.boolean(),
  /** Vrai si la mesure est refusée à ce lecteur (valeur au coût sans le droit). */
  forbidden: z.boolean(),
});
export const catalogDatasetSchema = z.object({
  code: z.string(),
  label: z.string(),
  temporality: z.enum(['FLOW', 'STATE']),
  dimensions: z.array(catalogDimensionSchema),
  measures: z.array(catalogMeasureSchema),
});
/** `GET /analytics/catalog` : les jeux que le lecteur peut explorer, avec ses mesures permises. */
export const analyticsCatalogResponseSchema = z.object({
  version: z.number().int().min(1),
  datasets: z.array(catalogDatasetSchema),
});
export type AnalyticsCatalogResponse = z.infer<typeof analyticsCatalogResponseSchema>;

/** Projection d'un jeu du domaine vers la réponse de catalogue (sans colonnes ni vues SQL). */
export function catalogDatasetView(
  dataset: DatasetDefinition,
  canReadValuation: boolean,
): z.infer<typeof catalogDatasetSchema> {
  return {
    code: dataset.code,
    label: dataset.label,
    temporality: dataset.temporality,
    dimensions: dataset.dimensions.map((d) => ({
      name: d.name,
      label: d.label,
      type: d.type satisfies DimensionType,
    })),
    measures: dataset.measures.map((m) => ({
      name: m.name,
      label: m.label,
      aggregate: m.aggregate satisfies MeasureAggregate,
      unit: m.unit satisfies MeasureUnit,
      additive: m.additive,
      forbidden: m.protected === true && !canReadValuation,
    })),
  };
}

// --- Tableaux de bord ---------------------------------------------------------------------------------------

export const DASHBOARD_CODES = [
  'direction',
  'commercial',
  'stock',
  'production',
  'finance',
  'distribution',
] as const;
export const dashboardCodeSchema = z.enum(DASHBOARD_CODES);
export type DashboardCode = z.infer<typeof dashboardCodeSchema>;

export const DASHBOARD_BLOCK_CODES = [
  'PRODUCTION',
  'STOCK',
  'DISTRIBUTION',
  'VENTES',
  'FINANCES',
  'EQUIPES',
  'ALERTES',
  'COMMERCIAL',
  'COORDINATION',
] as const;

export const dashboardKpiSchema = z.object({
  /** Code `KPI-*` du registre (D11 §7.1). */
  code: z.string().regex(/^KPI-[A-Z]{3}-[A-Z0-9-]+$/),
  label: z.string().min(1).max(120),
  unit: z.enum(['xaf', 'quantity', 'count', 'pct', 'ratio', 'text']),
  /** Valeur courante ; `null` si masquée ou non disponible (jamais une valeur trompeuse). */
  value: z.number().finite().nullable(),
  /** Valeur de la période précédente : pour les flux seulement (ADR-076 §2). */
  previousValue: z.number().finite().nullable().optional(),
  variationPct: z.number().finite().nullable().optional(),
  /** Lien d'exploration vers l'explorateur (BR-ANA-010, niveau 1). */
  explore: z
    .object({
      definition: explorationDefinitionSchema,
    })
    .nullable()
    .optional(),
  /** Type d'alerte associé (D11 §7.2). */
  alertType: z.string().max(40).nullable().optional(),
  alertSeverity: z.enum(ALERT_SEVERITIES).nullable().optional(),
});
export type DashboardKpi = z.infer<typeof dashboardKpiSchema>;

export const dashboardBlockSchema = z.object({
  code: z.enum(DASHBOARD_BLOCK_CODES),
  title: z.string().min(1).max(80),
  kpis: z.array(dashboardKpiSchema),
  /** Lignes classées et bornées (top commerciaux, ruptures, retards…). */
  details: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        value: z.number().finite().nullable(),
        unit: z.enum(['xaf', 'quantity', 'count', 'pct', 'ratio', 'text']),
        link: z.string().max(200).nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
  /** Bloc indisponible : droit manquant ou échec technique isolé ; les autres blocs restent rendus. */
  unavailable: z
    .object({ reason: z.enum(['FORBIDDEN', 'ERROR']), code: z.string().max(60).optional() })
    .nullable()
    .default(null),
});
export type DashboardBlock = z.infer<typeof dashboardBlockSchema>;

export const dashboardResponseSchema = z.object({
  code: dashboardCodeSchema,
  period: analyticsPeriodSchema,
  previousPeriod: analyticsPeriodSchema,
  blocks: z.array(dashboardBlockSchema),
  freshness: analyticsFreshnessSchema,
  computedAt: instant,
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

// --- Instantanés, vues, exports -------------------------------------------------------------------------------

export const kpiSnapshotSchema = z.object({
  scopeKey: dashboardCodeSchema,
  periodKey: z.enum(['TODAY', 'WEEK', 'MONTH']),
  computedAt: instant,
  kpis: z.array(dashboardKpiSchema),
});
export type KpiSnapshot = z.infer<typeof kpiSnapshotSchema>;

export const savedViewSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(120),
  dataset: z.string().min(1).max(60),
  definition: explorationDefinitionSchema,
  catalogVersion: z.number().int().min(1),
  ownerUserId: uuid,
  sharedWithRoles: z.array(z.string()),
  isDefaultForRole: z.string().nullable(),
  /** Exécutabilité pour le lecteur : sans données (ADR-077 §2). */
  executability: z.enum(['OK', 'OUTDATED', 'UNAVAILABLE']),
  updatedAt: instant,
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED'] as const;

export const exportJobSchema = z.object({
  id: uuid,
  dataset: z.string().min(1).max(60),
  format: z.enum(ANALYTICS_EXPORT_FORMATS),
  status: z.enum(EXPORT_STATUSES),
  rowCount: count.nullable(),
  errorCode: z.string().max(60).nullable(),
  createdAt: instant,
  finishedAt: instant.nullable(),
  expiresAt: instant,
});
export type ExportJob = z.infer<typeof exportJobSchema>;

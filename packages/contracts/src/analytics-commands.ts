/**
 * Définition d'exploration et charges utiles des commandes du module `analytics` (P9 ; D11 §4 ; ADR-074,
 * ADR-077) : requête de l'explorateur, vues sauvegardées, exports. La **forme** est validée ici (un seul
 * schéma pour le serveur et la PWA) ; la **sémantique** (jeux, dimensions, mesures déclarés, droits,
 * limites) l'est par `validateExploration` du domaine, jamais par ce schéma.
 *
 * Aucune de ces commandes n'est admise hors ligne (UC-ANA-03 à 05).
 */
import { ANALYTICS_PERIOD_CODES, EXPLORATION_FILTER_OPS, EXPLORATION_LIMITS } from '@gic/domain';
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'Nom de champ déclaré attendu.');
const businessDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ attendue.')
  .refine((value) => {
    const day = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
  }, 'Date inexistante.');
const roleCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Code de rôle attendu.');

const scalar = z.union([z.string().max(120), z.number().finite(), z.boolean()]);

export const explorationFilterSchema = z.object({
  field: identifier,
  op: z.enum(EXPLORATION_FILTER_OPS),
  value: z.union([scalar, z.array(scalar).min(1).max(EXPLORATION_LIMITS.maxInValues)]),
});
export type ExplorationFilterInput = z.infer<typeof explorationFilterSchema>;

export const explorationSortSchema = z.object({
  field: identifier,
  direction: z.enum(['ASC', 'DESC']),
});

export const explorationPeriodSchema = z
  .object({
    code: z.enum(ANALYTICS_PERIOD_CODES),
    fromDay: businessDay.optional(),
    toDay: businessDay.optional(),
  })
  .refine(
    (period) =>
      (period.code === 'CUSTOM') === (period.fromDay !== undefined && period.toDay !== undefined),
    { message: 'Une plage personnalisée indique ses deux bornes ; une période nommée aucune.' },
  );

/**
 * Définition d'une exploration (`POST /api/v1/analytics/query`, vue sauvegardée, export). Bornes de
 * structure seulement : nombre de dimensions, de mesures, de filtres et de tris (ADR-074).
 */
export const explorationDefinitionSchema = z.object({
  dataset: identifier,
  period: explorationPeriodSchema.optional(),
  dimensions: z.array(identifier).max(EXPLORATION_LIMITS.maxDimensions).default([]),
  measures: z.array(identifier).min(1).max(EXPLORATION_LIMITS.maxMeasures),
  filters: z.array(explorationFilterSchema).max(EXPLORATION_LIMITS.maxFilters).default([]),
  sort: z.array(explorationSortSchema).max(EXPLORATION_LIMITS.maxSort).default([]),
  limit: z.number().int().min(1).max(100_000).optional(),
});
export type ExplorationDefinitionInput = z.infer<typeof explorationDefinitionSchema>;

/** Corps de `POST /api/v1/analytics/query` : une définition, ou une vue sauvegardée à exécuter. */
export const analyticsQueryRequestSchema = z
  .object({
    definition: explorationDefinitionSchema.optional(),
    viewId: z.string().uuid().optional(),
  })
  .refine((request) => (request.definition === undefined) !== (request.viewId === undefined), {
    message: 'Indiquer une définition, ou une vue sauvegardée.',
  });
export type AnalyticsQueryRequest = z.infer<typeof analyticsQueryRequestSchema>;

// --- Vues sauvegardées (analytics.view.*) ---------------------------------------------------------------

/** `analytics.view.save` — création ou mise à jour par le propriétaire ; en ligne. */
export const analyticsViewSavePayloadSchema = z.object({
  name: text(120),
  definition: explorationDefinitionSchema,
  /** Version du catalogue de la définition (ADR-077 §2). */
  catalogVersion: z.number().int().min(1),
});
export type AnalyticsViewSavePayload = z.infer<typeof analyticsViewSavePayloadSchema>;

/** `analytics.view.share` — partage par rôles (BR-ANA-007) ; liste vide : ne plus partager. */
export const analyticsViewSharePayloadSchema = z.object({
  roles: z.array(roleCode).max(12),
});
export type AnalyticsViewSharePayload = z.infer<typeof analyticsViewSharePayloadSchema>;

/** `analytics.view.set_default` — vue par défaut d'un rôle ; `null` retire la vue par défaut. */
export const analyticsViewSetDefaultPayloadSchema = z.object({ roleCode: roleCode.nullable() });
export type AnalyticsViewSetDefaultPayload = z.infer<typeof analyticsViewSetDefaultPayloadSchema>;

/** `analytics.view.delete` — suppression physique par le propriétaire, auditée (objet de confort). */
export const analyticsViewDeletePayloadSchema = z.object({});
export type AnalyticsViewDeletePayload = z.infer<typeof analyticsViewDeletePayloadSchema>;

// --- Exports (analytics.export.request) -------------------------------------------------------------------

export const ANALYTICS_EXPORT_FORMATS = ['CSV', 'XLSX'] as const;
export const analyticsExportFormatSchema = z.enum(ANALYTICS_EXPORT_FORMATS);
export type AnalyticsExportFormat = z.infer<typeof analyticsExportFormatSchema>;

/** `analytics.export.request` — toujours asynchrone ; le serveur revalide les droits au calcul. */
export const analyticsExportRequestPayloadSchema = z.object({
  definition: explorationDefinitionSchema,
  format: analyticsExportFormatSchema,
  catalogVersion: z.number().int().min(1),
});
export type AnalyticsExportRequestPayload = z.infer<typeof analyticsExportRequestPayloadSchema>;

export const ANALYTICS_COMMAND_TYPES = {
  viewSave: 'analytics.view.save',
  viewShare: 'analytics.view.share',
  viewSetDefault: 'analytics.view.set_default',
  viewDelete: 'analytics.view.delete',
  exportRequest: 'analytics.export.request',
} as const;

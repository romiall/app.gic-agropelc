/**
 * Logique pure et appels en ligne de l'explorateur analytique (`ECR-ANA-06` :
 * exploration ad hoc, vues sauvegardées, exports asynchrones CSV / XLSX).
 */

import {
  ANALYTICS_COMMAND_TYPES,
  ANALYTICS_EXPORT_FORMATS,
  analyticsExportRequestPayloadSchema,
  analyticsViewDeletePayloadSchema,
  analyticsViewSavePayloadSchema,
  analyticsViewSetDefaultPayloadSchema,
  analyticsViewSharePayloadSchema,
  explorationDefinitionSchema,
  type AnalyticsCatalogResponse,
  type AnalyticsExportFormat,
  type AnalyticsQueryResponse,
  type ExplorationDefinitionInput,
  type ExportJob,
} from '@gic/contracts';
import { ensureAccessToken } from '../auth/session-runtime.js';
import { apiUrl } from '../../platform/env.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';

export { ANALYTICS_COMMAND_TYPES, ANALYTICS_EXPORT_FORMATS };

export type CatalogDatasetView = AnalyticsCatalogResponse['datasets'][number];

export const ANALYTICS_CATALOG_PATH = '/api/v1/analytics/catalog';
export const ANALYTICS_QUERY_PATH = '/api/v1/analytics/query';
export const ANALYTICS_VIEWS_PATH = '/api/v1/analytics/views';
export const ANALYTICS_EXPORTS_PATH = '/api/v1/analytics/exports';

export const analyticsExportDownloadPath = (exportId: string): string =>
  `/api/v1/analytics/exports/${encodeURIComponent(exportId)}/download`;

export const parseDefinitionFromSearch = (search: string): ExplorationDefinitionInput | null => {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const raw = params.get('def');
  if (!raw) return null;
  try {
    const parsedJson = JSON.parse(raw) as unknown;
    const validated = explorationDefinitionSchema.safeParse(parsedJson);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
};

export const defaultDefinitionForDataset = (
  dataset: CatalogDatasetView,
): ExplorationDefinitionInput => {
  const firstPermittedMeasure =
    dataset.measures.find((m) => !m.forbidden)?.name ?? dataset.measures[0]?.name ?? 'count';
  const firstDimension = dataset.dimensions[0]?.name;
  return {
    dataset: dataset.code,
    ...(dataset.temporality === 'FLOW' ? { period: { code: 'MONTH' as const } } : {}),
    dimensions: firstDimension ? [firstDimension] : [],
    measures: [firstPermittedMeasure],
    filters: [],
    sort: [],
    limit: 50,
  };
};

export const buildViewSavePayload = (input: {
  name: string;
  definition: ExplorationDefinitionInput;
  catalogVersion: number;
}) => {
  const parsed = analyticsViewSavePayloadSchema.safeParse({
    name: input.name.trim(),
    definition: input.definition,
    catalogVersion: input.catalogVersion,
  });
  if (!parsed.success) return { ok: false as const, error: 'invalid' as const };
  return {
    ok: true as const,
    commandType: ANALYTICS_COMMAND_TYPES.viewSave,
    payload: parsed.data,
  };
};

export const buildViewSharePayload = (roles: readonly string[]) => {
  const parsed = analyticsViewSharePayloadSchema.safeParse({ roles: [...roles] });
  if (!parsed.success) return { ok: false as const, error: 'invalid' as const };
  return {
    ok: true as const,
    commandType: ANALYTICS_COMMAND_TYPES.viewShare,
    payload: parsed.data,
  };
};

export const buildViewSetDefaultPayload = (roleCode: string | null) => {
  const parsed = analyticsViewSetDefaultPayloadSchema.safeParse({ roleCode });
  if (!parsed.success) return { ok: false as const, error: 'invalid' as const };
  return {
    ok: true as const,
    commandType: ANALYTICS_COMMAND_TYPES.viewSetDefault,
    payload: parsed.data,
  };
};

export const buildViewDeletePayload = () => {
  const parsed = analyticsViewDeletePayloadSchema.safeParse({});
  if (!parsed.success) return { ok: false as const, error: 'invalid' as const };
  return {
    ok: true as const,
    commandType: ANALYTICS_COMMAND_TYPES.viewDelete,
    payload: parsed.data,
  };
};

export const buildExportRequestPayload = (input: {
  definition: ExplorationDefinitionInput;
  format: AnalyticsExportFormat;
  catalogVersion: number;
}) => {
  const parsed = analyticsExportRequestPayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'invalid' as const };
  return {
    ok: true as const,
    commandType: ANALYTICS_COMMAND_TYPES.exportRequest,
    payload: parsed.data,
  };
};

export async function executeAnalyticsQuery(
  body: { definition: ExplorationDefinitionInput } | { viewId: string },
): Promise<{ ok: true; data: AnalyticsQueryResponse } | { ok: false; error: string }> {
  const res = await authorizedRequest<AnalyticsQueryResponse>(getDb(), ANALYTICS_QUERY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true, data: res.data };
  return { ok: false, error: res.reason };
}

export async function downloadAnalyticsExport(job: ExportJob): Promise<boolean> {
  const token = await ensureAccessToken(getDb());
  if (!token.ok) return false;
  try {
    const response = await fetch(apiUrl(analyticsExportDownloadPath(job.id)), {
      method: 'GET',
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    if (!response.ok) return false;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = job.format === 'XLSX' ? 'xlsx' : 'csv';
    a.download = `${job.dataset}-${job.id.slice(0, 8)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

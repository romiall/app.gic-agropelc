/**
 * Logique pure des tableaux de bord analytiques (`ECR-ANA-01` à `ECR-ANA-05`).
 */

import {
  DASHBOARD_CODES,
  type DashboardCode,
  type DashboardKpi,
  type ExplorationDefinitionInput,
  type KpiSnapshot,
} from '@gic/contracts';
import { formatMoney, formatQuantity } from '../sales/format.js';

export { DASHBOARD_CODES };

export type RoleDashboardCode = Exclude<DashboardCode, 'distribution'>;

export const DASHBOARD_PERIOD_OPTIONS = ['TODAY', 'YESTERDAY', 'WEEK', 'MONTH', 'YEAR'] as const;

export type DashboardPeriodOption = (typeof DASHBOARD_PERIOD_OPTIONS)[number];

export const dashboardPath = (code: RoleDashboardCode, period: DashboardPeriodOption): string =>
  `/api/v1/analytics/dashboards/${encodeURIComponent(code)}?period=${encodeURIComponent(period)}`;

/** Convertit une projection hors ligne `kpi:KPI_SNAPSHOT` vers `KpiSnapshot`. */
export const fromProjectedKpiSnapshot = (raw: unknown): KpiSnapshot | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const scopeKey = typeof r.scope_key === 'string' ? r.scope_key : null;
  const periodKey = typeof r.period_key === 'string' ? r.period_key : null;
  if (
    !scopeKey ||
    !(DASHBOARD_CODES as readonly string[]).includes(scopeKey) ||
    (periodKey !== 'TODAY' && periodKey !== 'WEEK' && periodKey !== 'MONTH') ||
    !Array.isArray(r.kpis)
  ) {
    return null;
  }
  return {
    scopeKey: scopeKey as DashboardCode,
    periodKey,
    computedAt: typeof r.computed_at === 'string' ? r.computed_at : '',
    kpis: r.kpis as DashboardKpi[],
  };
};

export const findProjectedSnapshot = (
  records: ReadonlyArray<unknown>,
  code: RoleDashboardCode,
  period: DashboardPeriodOption,
): KpiSnapshot | null => {
  const snapshots = records
    .map((r) => fromProjectedKpiSnapshot(r))
    .filter((s): s is KpiSnapshot => s !== null && s.scopeKey === code);
  if (snapshots.length === 0) return null;
  const exact = snapshots.find((s) => s.periodKey === period);
  if (exact) return exact;
  return snapshots.find((s) => s.periodKey === 'TODAY') ?? snapshots[0] ?? null;
};

export const formatMetricValue = (
  value: number | null,
  unit: 'xaf' | 'quantity' | 'count' | 'pct' | 'ratio' | 'text' | 'minutes' | 'kg',
): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'xaf':
      return formatMoney(Math.round(value));
    case 'pct':
      return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
    case 'ratio':
      return value.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    case 'minutes':
      return `${Math.round(value).toLocaleString('fr-FR')} min`;
    case 'kg':
      return `${formatQuantity(value)} kg`;
    case 'quantity':
    case 'count':
    case 'text':
    default:
      return formatQuantity(value);
  }
};

export const formatVariationPct = (variationPct: number | null | undefined): string | null => {
  if (variationPct === null || variationPct === undefined || !Number.isFinite(variationPct)) {
    return null;
  }
  const sign = variationPct > 0 ? '+' : '';
  return `${sign}${variationPct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
};

export const buildExplorerDrillDownUrl = (
  explorerRoute: string,
  definition: ExplorationDefinitionInput,
): string => {
  const params = new URLSearchParams({ def: JSON.stringify(definition) });
  return `${explorerRoute}?${params.toString()}`;
};

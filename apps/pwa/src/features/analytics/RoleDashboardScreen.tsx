/**
 * Tableaux de bord par rôle (`ECR-ANA-01` à `ECR-ANA-05` ; D11 §3, §7 ; ADR-064 à ADR-066) :
 * - `ECR-ANA-01` : Tour de contrôle Direction (`direction`, hors ligne possible via `kpi:KPI_SNAPSHOT`)
 * - `ECR-ANA-02` : Tableau de bord Commercial (`commercial`, hors ligne possible)
 * - `ECR-ANA-03` : Tableau de bord Stock & Magasin (`stock`, hors ligne possible)
 * - `ECR-ANA-04` : Tableau de bord Production (`production`, hors ligne possible)
 * - `ECR-ANA-05` : Tableau de bord Finance & Trésorerie (`finance`, en ligne)
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { DashboardKpi, DashboardResponse } from '@gic/contracts';
import { ROUTES } from '../../app/screens.js';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  PageHeader,
  Select,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { listProjected } from '../../storage/projections.js';
import { useAdminRead } from '../admin/admin-online.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import {
  buildExplorerDrillDownUrl,
  DASHBOARD_PERIOD_OPTIONS,
  dashboardPath,
  findProjectedSnapshot,
  formatMetricValue,
  formatVariationPct,
  type DashboardPeriodOption,
  type RoleDashboardCode,
} from './dashboards.js';
import './analytics.css';

const EXPLORER_ROLES = new Set([
  'DIRECTION',
  'RESP_COMMERCIAL',
  'RESP_PRODUCTION',
  'RESP_ACHATS',
  'FINANCE',
]);

const alertBadgeTone = (severity: DashboardKpi['alertSeverity']): BadgeTone => {
  if (severity === 'CRITICAL') return 'bad';
  if (severity === 'WARNING') return 'warn';
  return 'info';
};

export interface RoleDashboardScreenProps {
  readonly code: RoleDashboardCode;
  readonly titleKey: string;
  readonly offlineCapable: boolean;
}

export function RoleDashboardScreen({ code, titleKey, offlineCapable }: RoleDashboardScreenProps) {
  const { t } = useTranslation();
  const online = useOnline();
  const { state } = useAuth();
  const unlocked = state.status === 'unlocked' ? state : undefined;
  const navigation = useRememberedNavigation(unlocked?.userId);
  const canExplore = Boolean(navigation?.roles.some((r) => EXPLORER_ROLES.has(r)));

  const [period, setPeriod] = useState<DashboardPeriodOption>('MONTH');

  const dashRead = useAdminRead<DashboardResponse>(
    online ? dashboardPath(code, period) : null,
    period,
  );

  const snapshot = useLiveQuery(async () => {
    if (!offlineCapable) return null;
    const db = getDb();
    const records = await listProjected<unknown>(db, 'kpi', 'KPI_SNAPSHOT');
    return findProjectedSnapshot(records, code, period);
  }, [code, period, offlineCapable]);

  const useSnapshotFallback =
    offlineCapable && (!online || dashRead.failed || dashRead.data === undefined);

  const renderKpiCard = (kpi: DashboardKpi) => {
    const delta = formatVariationPct(kpi.variationPct);
    const drillUrl =
      canExplore && online && kpi.explore?.definition
        ? buildExplorerDrillDownUrl(ROUTES.analyticsExplorer, kpi.explore.definition)
        : null;
    return (
      <div key={kpi.code} className="ana-kpi-card">
        <div className="ana-kpi-card__head">
          <span className="ana-kpi-card__label">{kpi.label}</span>
          {kpi.alertSeverity ? (
            <Badge tone={alertBadgeTone(kpi.alertSeverity)}>
              {t(`comm.alerts.severity.${kpi.alertSeverity}`)}
            </Badge>
          ) : null}
        </div>
        <div className="ana-kpi-card__value">{formatMetricValue(kpi.value, kpi.unit)}</div>
        <div className="ana-kpi-card__foot">
          {delta ? (
            <Badge
              tone={
                (kpi.variationPct ?? 0) > 0 ? 'ok' : (kpi.variationPct ?? 0) < 0 ? 'warn' : 'muted'
              }
            >
              {delta}
            </Badge>
          ) : (
            <span />
          )}
          {drillUrl ? (
            <Link className="btn btn-ghost btn-sm" to={drillUrl}>
              {t('analytics.exploreAction')}
            </Link>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="ana-screen">
      <PageHeader
        title={t(titleKey)}
        subtitle={
          dashRead.data
            ? t('analytics.periodRange', {
                from: dashRead.data.period.fromDay,
                to: dashRead.data.period.toDay,
              })
            : t('analytics.subtitle')
        }
        actions={
          <div className="ana-inline-actions">
            {canExplore && online ? (
              <Link className="btn btn-outline btn-sm" to={ROUTES.analyticsExplorer}>
                {t('nav.screens.analytics_explorer')}
              </Link>
            ) : null}
            <Button
              variant="tonal"
              size="sm"
              icon="sync"
              onClick={() => dashRead.retry()}
              disabled={!online || dashRead.stale}
            >
              {t('analytics.refresh')}
            </Button>
          </div>
        }
      />

      <div className="ana-toolbar">
        <Field label={t('analytics.periodLabel')}>
          {(control) => (
            <Select
              {...control}
              value={period}
              onChange={(e) => setPeriod(e.target.value as DashboardPeriodOption)}
            >
              {DASHBOARD_PERIOD_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`analytics.period.${p}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {dashRead.data?.freshness ? (
          <div className="ana-freshness">
            <span>
              {t('analytics.computedAt', {
                date: formatDateTime(dashRead.data.freshness.computedAt),
              })}
            </span>
            {dashRead.data.freshness.staleDevices > 0 ? (
              <Badge tone="warn">
                {t('analytics.staleDevices', {
                  stale: dashRead.data.freshness.staleDevices,
                  total: dashRead.data.freshness.devicesInScope,
                })}
              </Badge>
            ) : (
              <Badge tone="ok">{t('analytics.freshOk')}</Badge>
            )}
          </div>
        ) : null}
      </div>

      {!online && !offlineCapable ? (
        <Banner tone="warn">{t('analytics.onlineOnlyBanner')}</Banner>
      ) : null}

      {useSnapshotFallback && snapshot ? (
        <>
          <Banner tone="info">
            {t('analytics.snapshotFallbackBanner', {
              period: t(`analytics.period.${snapshot.periodKey}`),
              date: snapshot.computedAt ? formatDateTime(snapshot.computedAt) : '—',
            })}
          </Banner>
          <section className="ana-block">
            <div className="ana-block__head">
              <h2 className="ana-block__title">{t('analytics.snapshotSectionTitle')}</h2>
            </div>
            <div className="ana-kpi-grid">{snapshot.kpis.map(renderKpiCard)}</div>
          </section>
        </>
      ) : online && dashRead.data === undefined && !dashRead.failed ? (
        <SkeletonRows rows={4} />
      ) : dashRead.data ? (
        <div className="ana-blocks">
          {dashRead.data.blocks.map((block) => (
            <section key={block.code} className="ana-block">
              <div className="ana-block__head">
                <h2 className="ana-block__title">{block.title}</h2>
              </div>
              {block.unavailable ? (
                <Banner tone="warn">
                  {block.unavailable.reason === 'FORBIDDEN'
                    ? t('analytics.blockForbidden')
                    : t('analytics.blockError')}
                </Banner>
              ) : (
                <>
                  <div className="ana-kpi-grid">{block.kpis.map(renderKpiCard)}</div>
                  {block.details.length > 0 ? (
                    <ul className="ana-details-list">
                      {block.details.map((detail, idx) => (
                        <li key={`${detail.label}-${idx}`} className="ana-details-row">
                          <span>
                            {detail.link ? (
                              <Link to={detail.link}>{detail.label}</Link>
                            ) : (
                              detail.label
                            )}
                          </span>
                          <span className="ana-details-row__value">
                            {formatMetricValue(detail.value, detail.unit)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </section>
          ))}
        </div>
      ) : (
        <EmptyState icon="chart" title={t('analytics.emptyDashboardTitle')}>
          {t('analytics.emptyDashboardHint')}
        </EmptyState>
      )}
    </div>
  );
}

/** ECR-ANA-01 : Tour de contrôle Direction. */
export function DirectionDashboardScreen() {
  return (
    <RoleDashboardScreen
      code="direction"
      titleKey="nav.screens.analytics_direction"
      offlineCapable={true}
    />
  );
}

/** ECR-ANA-02 : Tableau de bord Commercial. */
export function CommercialDashboardScreen() {
  return (
    <RoleDashboardScreen
      code="commercial"
      titleKey="nav.screens.analytics_commercial"
      offlineCapable={true}
    />
  );
}

/** ECR-ANA-03 : Tableau de bord Stock & Magasin. */
export function StockDashboardScreen() {
  return (
    <RoleDashboardScreen
      code="stock"
      titleKey="nav.screens.analytics_stock"
      offlineCapable={true}
    />
  );
}

/** ECR-ANA-04 : Tableau de bord Production. */
export function ProductionDashboardScreen() {
  return (
    <RoleDashboardScreen
      code="production"
      titleKey="nav.screens.analytics_production"
      offlineCapable={true}
    />
  );
}

/** ECR-ANA-05 : Tableau de bord Finance & Trésorerie (en ligne). */
export function FinanceDashboardScreen() {
  return (
    <RoleDashboardScreen
      code="finance"
      titleKey="nav.screens.analytics_finance"
      offlineCapable={false}
    />
  );
}

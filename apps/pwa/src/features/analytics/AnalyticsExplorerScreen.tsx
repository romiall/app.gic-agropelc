/**
 * ECR-ANA-06 « Explorateur analytique, vues sauvegardées & exports » (D11 §4, §6 ; ADR-064, ADR-067 ;
 * en ligne seulement). Permet d'interroger les jeux de données déclarés du catalogue analytique,
 * de descendre jusqu'au document source (BR-ANA-010), d'enregistrer/partager des vues et de demander
 * ou télécharger des exports CSV / XLSX audités.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import type {
  AnalyticsCatalogResponse,
  AnalyticsExportFormat,
  AnalyticsQueryResponse,
  ExplorationDefinitionInput,
  ExportJob,
  SavedView,
} from '@gic/contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  TabPanel,
  Tabs,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAdminRead, useOnlineCommands } from '../admin/admin-online.js';
import { useAuth } from '../auth/AuthContext.js';
import { ROLE_CODES } from '../communication/alerts.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import {
  DASHBOARD_PERIOD_OPTIONS,
  formatMetricValue,
  type DashboardPeriodOption,
} from './dashboards.js';
import {
  ANALYTICS_CATALOG_PATH,
  ANALYTICS_EXPORT_FORMATS,
  ANALYTICS_EXPORTS_PATH,
  ANALYTICS_VIEWS_PATH,
  buildExportRequestPayload,
  buildViewDeletePayload,
  buildViewSavePayload,
  buildViewSetDefaultPayload,
  buildViewSharePayload,
  defaultDefinitionForDataset,
  downloadAnalyticsExport,
  executeAnalyticsQuery,
  parseDefinitionFromSearch,
} from './explorer.js';
import './analytics.css';

type ExplorerTab = 'explore' | 'views' | 'exports';
const EXPLORER_TABS: readonly ExplorerTab[] = ['explore', 'views', 'exports'];

const exportStatusTone = (status: ExportJob['status']): BadgeTone => {
  if (status === 'DONE') return 'ok';
  if (status === 'RUNNING' || status === 'QUEUED') return 'info';
  if (status === 'FAILED') return 'bad';
  return 'muted';
};

export function AnalyticsExplorerScreen() {
  const { t } = useTranslation();
  const online = useOnline();
  const location = useLocation();
  const { state } = useAuth();
  const unlocked = state.status === 'unlocked' ? state : undefined;
  const navigation = useRememberedNavigation(unlocked?.userId);
  const canSetRoleDefault = Boolean(
    navigation?.roles.some((r) => r === 'DIRECTION' || r === 'ADMIN'),
  );

  const commands = useOnlineCommands('analytics.');
  const [tab, setTab] = useState<ExplorerTab>('explore');

  const catalogRead = useAdminRead<AnalyticsCatalogResponse>(
    online ? ANALYTICS_CATALOG_PATH : null,
    commands.reloadKey,
  );
  const viewsRead = useAdminRead<{ readonly views: readonly SavedView[] }>(
    online ? ANALYTICS_VIEWS_PATH : null,
    commands.reloadKey,
  );
  const exportsRead = useAdminRead<{ readonly exports: readonly ExportJob[] }>(
    online ? ANALYTICS_EXPORTS_PATH : null,
    commands.reloadKey,
  );

  const [prevSearch, setPrevSearch] = useState(location.search);
  const [userDefinition, setUserDefinition] = useState<ExplorationDefinitionInput | null>(null);

  if (location.search !== prevSearch) {
    setPrevSearch(location.search);
    setUserDefinition(null);
  }

  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<AnalyticsQueryResponse | null>(null);

  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [shareViewId, setShareViewId] = useState<string | null>(null);
  const [shareRole, setShareRole] = useState<string>(ROLE_CODES[0]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const datasets = useMemo(() => catalogRead.data?.datasets ?? [], [catalogRead.data?.datasets]);
  const catalogVersion = catalogRead.data?.version ?? 1;

  const urlDefinition = useMemo(
    () => parseDefinitionFromSearch(location.search),
    [location.search],
  );

  const definition =
    userDefinition ??
    urlDefinition ??
    (datasets.length > 0 && datasets[0] ? defaultDefinitionForDataset(datasets[0]) : null);

  const setDefinition = setUserDefinition;

  const currentDataset = datasets.find((d) => d.code === definition?.dataset) ?? datasets[0];

  const handleDatasetChange = (datasetCode: string) => {
    const ds = datasets.find((d) => d.code === datasetCode);
    if (!ds) return;
    setDefinition(defaultDefinitionForDataset(ds));
    setQueryResult(null);
  };

  const handleToggleDimension = (dimName: string, checked: boolean) => {
    if (!definition) return;
    const current = definition.dimensions ?? [];
    const next = checked
      ? [...current.filter((d) => d !== dimName), dimName].slice(0, 3)
      : current.filter((d) => d !== dimName);
    setDefinition({ ...definition, dimensions: next });
  };

  const handleToggleMeasure = (measureName: string, checked: boolean) => {
    if (!definition) return;
    const current = definition.measures;
    const next = checked
      ? [...current.filter((m) => m !== measureName), measureName].slice(0, 5)
      : current.filter((m) => m !== measureName);
    if (next.length === 0) return;
    setDefinition({ ...definition, measures: next });
  };

  const handleRunQuery = async () => {
    if (!definition || !online) return;
    setQueryLoading(true);
    setQueryError(null);
    try {
      const res = await executeAnalyticsQuery({ definition });
      if (res.ok) {
        setQueryResult(res.data);
      } else {
        setQueryError(t('analytics.explorer.queryError'));
      }
    } finally {
      setQueryLoading(false);
    }
  };

  const handleRunSavedView = async (view: SavedView) => {
    if (!online) return;
    setDefinition(view.definition);
    setTab('explore');
    setQueryLoading(true);
    setQueryError(null);
    try {
      const res = await executeAnalyticsQuery({ viewId: view.id });
      if (res.ok) {
        setQueryResult(res.data);
      } else {
        setQueryError(t('analytics.explorer.queryError'));
      }
    } finally {
      setQueryLoading(false);
    }
  };

  const handleSaveView = async () => {
    if (!definition) return;
    const built = buildViewSavePayload({
      name: viewName,
      definition,
      catalogVersion,
    });
    if (!built.ok) return;
    const ok = await commands.send({
      commandType: built.commandType,
      aggregateType: 'SAVED_VIEW',
      aggregateId: crypto.randomUUID(),
      payload: built.payload,
    });
    if (ok) {
      setSaveViewOpen(false);
      setViewName('');
    }
  };

  const handleRequestExport = async (format: AnalyticsExportFormat) => {
    if (!definition) return;
    const built = buildExportRequestPayload({
      definition,
      format,
      catalogVersion,
    });
    if (!built.ok) return;
    const ok = await commands.send({
      commandType: built.commandType,
      aggregateType: 'ANALYTICS_EXPORT',
      aggregateId: crypto.randomUUID(),
      payload: built.payload,
    });
    if (ok) {
      setTab('exports');
    }
  };

  const handleShareView = async (view: SavedView) => {
    const nextRoles = Array.from(new Set([...view.sharedWithRoles, shareRole]));
    const built = buildViewSharePayload(nextRoles);
    if (!built.ok) return;
    const ok = await commands.send({
      commandType: built.commandType,
      aggregateType: 'SAVED_VIEW',
      aggregateId: view.id,
      payload: built.payload,
    });
    if (ok) {
      setShareViewId(null);
    }
  };

  const handleSetDefaultForRole = async (view: SavedView, roleCode: string | null) => {
    const built = buildViewSetDefaultPayload(roleCode);
    if (!built.ok) return;
    await commands.send({
      commandType: built.commandType,
      aggregateType: 'SAVED_VIEW',
      aggregateId: view.id,
      payload: built.payload,
    });
  };

  const handleDeleteView = async (viewId: string) => {
    const built = buildViewDeletePayload();
    if (!built.ok) return;
    await commands.send({
      commandType: built.commandType,
      aggregateType: 'SAVED_VIEW',
      aggregateId: viewId,
      payload: built.payload,
    });
  };

  const handleDownloadExport = async (job: ExportJob) => {
    setDownloadingId(job.id);
    try {
      await downloadAnalyticsExport(job);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="ana-screen">
      <PageHeader
        title={t('nav.screens.analytics_explorer')}
        subtitle={t('analytics.explorer.subtitle')}
        actions={
          <Button
            variant="tonal"
            size="sm"
            icon="sync"
            onClick={() => {
              catalogRead.retry();
              viewsRead.retry();
              exportsRead.retry();
            }}
            disabled={!online || catalogRead.stale}
          >
            {t('analytics.refresh')}
          </Button>
        }
      />

      {!online ? <Banner tone="warn">{t('analytics.onlineOnlyBanner')}</Banner> : null}
      {commands.saveError ? <Banner tone="bad">{t(commands.saveError)}</Banner> : null}
      {commands.last ? (
        <CommandResult commandId={commands.last} messages="analytics.result" />
      ) : null}

      <Tabs
        idPrefix="ana-explorer"
        label={t('nav.screens.analytics_explorer')}
        items={EXPLORER_TABS.map((id) => ({
          id,
          label: t(`analytics.explorer.tab.${id}`),
        }))}
        value={tab}
        onChange={setTab}
      />

      <TabPanel idPrefix="ana-explorer" id="explore" active={tab === 'explore'}>
        {catalogRead.data === undefined && !catalogRead.failed ? (
          <SkeletonRows rows={3} />
        ) : currentDataset && definition ? (
          <>
            <div className="ana-explorer-panel">
              <div className="ana-toolbar">
                <Field label={t('analytics.explorer.datasetLabel')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={definition.dataset}
                      onChange={(e) => handleDatasetChange(e.target.value)}
                    >
                      {datasets.map((ds) => (
                        <option key={ds.code} value={ds.code}>
                          {ds.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                {currentDataset.temporality === 'FLOW' ? (
                  <Field label={t('analytics.periodLabel')}>
                    {(control) => (
                      <Select
                        {...control}
                        value={
                          definition.period?.code && definition.period.code !== 'CUSTOM'
                            ? definition.period.code
                            : 'MONTH'
                        }
                        onChange={(e) =>
                          setDefinition({
                            ...definition,
                            period: { code: e.target.value as DashboardPeriodOption },
                          })
                        }
                      >
                        {DASHBOARD_PERIOD_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {t(`analytics.period.${p}`)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
              </div>

              <div>
                <strong>{t('analytics.explorer.dimensionsLabel')}</strong>
                <div className="ana-chip-group">
                  {currentDataset.dimensions.map((dim) => (
                    <Checkbox
                      key={dim.name}
                      label={dim.label}
                      checked={(definition.dimensions ?? []).includes(dim.name)}
                      onChange={(e) => handleToggleDimension(dim.name, e.target.checked)}
                    />
                  ))}
                </div>
              </div>

              <div>
                <strong>{t('analytics.explorer.measuresLabel')}</strong>
                <div className="ana-chip-group">
                  {currentDataset.measures.map((m) => (
                    <Checkbox
                      key={m.name}
                      label={m.label}
                      disabled={m.forbidden}
                      checked={definition.measures.includes(m.name)}
                      onChange={(e) => handleToggleMeasure(m.name, e.target.checked)}
                    />
                  ))}
                </div>
              </div>

              <div className="ana-inline-actions">
                <Button
                  variant="primary"
                  loading={queryLoading}
                  disabled={!online}
                  onClick={() => void handleRunQuery()}
                >
                  {t('analytics.explorer.runAction')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!online || commands.blocked}
                  onClick={() => setSaveViewOpen((v) => !v)}
                >
                  {t('analytics.explorer.saveViewAction')}
                </Button>
                {ANALYTICS_EXPORT_FORMATS.map((fmt) => (
                  <Button
                    key={fmt}
                    variant="tonal"
                    size="sm"
                    disabled={!online || commands.blocked}
                    onClick={() => void handleRequestExport(fmt)}
                  >
                    {t('analytics.explorer.exportFormatAction', { format: fmt })}
                  </Button>
                ))}
              </div>

              {saveViewOpen ? (
                <div className="ana-toolbar">
                  <Field label={t('analytics.explorer.viewNameLabel')}>
                    {(control) => (
                      <Input
                        {...control}
                        value={viewName}
                        maxLength={120}
                        onChange={(e) => setViewName(e.target.value)}
                      />
                    )}
                  </Field>
                  <Button
                    variant="tonal"
                    size="sm"
                    disabled={commands.blocked || !viewName.trim()}
                    onClick={() => void handleSaveView()}
                  >
                    {t('analytics.explorer.confirmSaveView')}
                  </Button>
                </div>
              ) : null}
            </div>

            {queryError ? <Banner tone="bad">{queryError}</Banner> : null}

            {queryResult ? (
              <div className="ana-block">
                <div className="ana-block__head">
                  <h2 className="ana-block__title">
                    {t('analytics.explorer.resultsTitle', { count: queryResult.rowCount })}
                  </h2>
                  <span className="ana-freshness">
                    {t('analytics.computedAt', {
                      date: formatDateTime(queryResult.freshness.computedAt),
                    })}
                  </span>
                </div>

                {queryResult.scopeTruncated ? (
                  <Banner tone="warn">{t('analytics.explorer.scopeTruncated')}</Banner>
                ) : null}

                {queryResult.totals ? (
                  <div className="ana-kpi-grid">
                    {queryResult.columns
                      .filter(
                        (col) =>
                          col.kind === 'measure' && queryResult.totals?.[col.name] !== undefined,
                      )
                      .map((col) => (
                        <div key={col.name} className="ana-kpi-card">
                          <span className="ana-kpi-card__label">
                            {t('analytics.explorer.totalLabel', { label: col.label })}
                          </span>
                          <span className="ana-kpi-card__value">
                            {formatMetricValue(
                              queryResult.totals?.[col.name] ?? null,
                              col.unit ?? 'count',
                            )}
                          </span>
                        </div>
                      ))}
                  </div>
                ) : null}

                {queryResult.rows.length === 0 ? (
                  <EmptyState icon="search" title={t('analytics.explorer.emptyRowsTitle')}>
                    {t('analytics.explorer.emptyRowsHint')}
                  </EmptyState>
                ) : (
                  <ul className="ana-row-list">
                    {queryResult.rows.map((row, idx) => (
                      <li key={idx} className="ana-row-card">
                        <div className="ana-row-card__grid">
                          {queryResult.columns.map((col) => {
                            const rawVal = row.values[col.name];
                            const formatted =
                              col.kind === 'measure' && typeof rawVal === 'number'
                                ? formatMetricValue(rawVal, col.unit ?? 'count')
                                : rawVal === null || rawVal === undefined
                                  ? '—'
                                  : String(rawVal);
                            return (
                              <div key={col.name} className="ana-row-card__cell">
                                <span className="ana-row-card__label">{col.label}</span>
                                <span className="ana-row-card__value">{formatted}</span>
                              </div>
                            );
                          })}
                        </div>
                        {row.source?.route ? (
                          <div className="ana-inline-actions">
                            <Link className="btn btn-outline btn-sm" to={row.source.route}>
                              {t('analytics.explorer.openSourceDoc')}
                            </Link>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState icon="chart" title={t('analytics.emptyDashboardTitle')}>
            {t('analytics.emptyDashboardHint')}
          </EmptyState>
        )}
      </TabPanel>

      <TabPanel idPrefix="ana-explorer" id="views" active={tab === 'views'}>
        {viewsRead.data === undefined && !viewsRead.failed ? (
          <SkeletonRows rows={3} />
        ) : (viewsRead.data?.views ?? []).length === 0 ? (
          <EmptyState icon="file" title={t('analytics.views.emptyTitle')}>
            {t('analytics.views.emptyHint')}
          </EmptyState>
        ) : (
          <ul className="ana-row-list">
            {(viewsRead.data?.views ?? []).map((view) => {
              const isOwner = view.ownerUserId === unlocked?.userId;
              return (
                <li key={view.id} className="ana-row-card">
                  <div className="ana-block__head">
                    <strong>{view.name}</strong>
                    <div className="ana-inline-actions">
                      <Badge tone={view.executability === 'OK' ? 'ok' : 'warn'}>
                        {t(`analytics.views.executability.${view.executability}`)}
                      </Badge>
                      {view.isDefaultForRole ? (
                        <Badge tone="info">
                          {t('analytics.views.defaultForRole', {
                            role: view.isDefaultForRole,
                          })}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="ana-freshness">
                    <span>{view.dataset}</span>
                    {view.sharedWithRoles.length > 0 ? (
                      <span>
                        {t('analytics.views.sharedWith', {
                          roles: view.sharedWithRoles.join(', '),
                        })}
                      </span>
                    ) : null}
                  </div>
                  <div className="ana-inline-actions">
                    <Button
                      variant="tonal"
                      size="sm"
                      disabled={!online || view.executability === 'UNAVAILABLE'}
                      onClick={() => void handleRunSavedView(view)}
                    >
                      {t('analytics.views.openAction')}
                    </Button>
                    {isOwner ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!online || commands.blocked}
                          onClick={() => setShareViewId(shareViewId === view.id ? null : view.id)}
                        >
                          {t('analytics.views.shareAction')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!online || commands.blocked}
                          onClick={() => void handleDeleteView(view.id)}
                        >
                          {t('analytics.views.deleteAction')}
                        </Button>
                      </>
                    ) : null}
                    {canSetRoleDefault ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!online || commands.blocked}
                        onClick={() =>
                          void handleSetDefaultForRole(
                            view,
                            view.isDefaultForRole ? null : 'DIRECTION',
                          )
                        }
                      >
                        {view.isDefaultForRole
                          ? t('analytics.views.unsetDefaultAction')
                          : t('analytics.views.setDefaultAction')}
                      </Button>
                    ) : null}
                  </div>

                  {shareViewId === view.id ? (
                    <div className="ana-toolbar">
                      <Field label={t('analytics.views.shareRoleLabel')}>
                        {(control) => (
                          <Select
                            {...control}
                            value={shareRole}
                            onChange={(e) => setShareRole(e.target.value)}
                          >
                            {ROLE_CODES.map((r) => (
                              <option key={r} value={r}>
                                {t(`users.role.${r}`, { defaultValue: r })}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Button
                        variant="tonal"
                        size="sm"
                        disabled={commands.blocked}
                        onClick={() => void handleShareView(view)}
                      >
                        {t('analytics.views.confirmShare')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </TabPanel>

      <TabPanel idPrefix="ana-explorer" id="exports" active={tab === 'exports'}>
        {exportsRead.data === undefined && !exportsRead.failed ? (
          <SkeletonRows rows={3} />
        ) : (exportsRead.data?.exports ?? []).length === 0 ? (
          <EmptyState icon="file" title={t('analytics.exports.emptyTitle')}>
            {t('analytics.exports.emptyHint')}
          </EmptyState>
        ) : (
          <ul className="ana-row-list">
            {(exportsRead.data?.exports ?? []).map((job) => (
              <li key={job.id} className="ana-row-card">
                <div className="ana-block__head">
                  <strong>
                    {job.dataset} · {job.format}
                  </strong>
                  <Badge tone={exportStatusTone(job.status)}>
                    {t(`analytics.exports.status.${job.status}`)}
                  </Badge>
                </div>
                <div className="ana-freshness">
                  <span>{formatDateTime(job.createdAt)}</span>
                  {job.rowCount !== null ? (
                    <span>{t('analytics.exports.rowCount', { count: job.rowCount })}</span>
                  ) : null}
                </div>
                {job.status === 'DONE' ? (
                  <div className="ana-inline-actions">
                    <Button
                      variant="tonal"
                      size="sm"
                      loading={downloadingId === job.id}
                      onClick={() => void handleDownloadExport(job)}
                    >
                      {t('analytics.exports.downloadAction')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </TabPanel>
    </div>
  );
}

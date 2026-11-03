/**
 * ECR-SYN-02 « Supervision de la synchronisation » (RP-3 ; UC-SYN-08 ; BR-ANA-005).
 * En ligne seulement : réservé à l'Administrateur et à la Direction pour suivre la fraîcheur des
 * appareils (`lastPushAt`, `lastPullAt`, `lastContactAt`), les files d'opérations en attente signalées
 * (`pendingReported`) et accéder aux conflits ouverts (`ECR-SYN-03`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ROUTES } from '../../app/screens.js';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Segmented,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { readPages, useOnlineRead, useRefreshOnVisible, type Pages } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import {
  filterFromQuery,
  filterMonitoredDevices,
  MONITOR_DEVICES_PATH,
  OPEN_CONFLICTS_PATH,
  summarizeMonitoredDevices,
  SYNC_MONITOR_FILTERS,
  type MonitoredDeviceView,
  type SyncMonitorFilter,
} from './sync-monitor.js';
import '../users/admin.css';

const MAX_PAGES = 5;

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  PENDING: 'warn',
  ACTIVE: 'ok',
  BLOCKED: 'bad',
  LOST: 'muted',
  RETIRED: 'muted',
};

export function SyncMonitorScreen() {
  const { t } = useTranslation();
  const { state, deviceId: thisDeviceId } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const refs = useSalesReferences();
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState<SyncMonitorFilter>(() =>
    filterFromQuery(searchParams.get('filtre')),
  );
  const [search, setSearch] = useState('');

  const devicesRead = useOnlineRead<Pages<MonitoredDeviceView>>(
    online ? MONITOR_DEVICES_PATH : null,
    (path) => readPages<MonitoredDeviceView>([path], 'devices', MAX_PAGES),
    online,
    'monitor-devices',
  );
  const conflictsRead = useOnlineRead<Pages<{ readonly id: string }>>(
    online ? OPEN_CONFLICTS_PATH : null,
    (path) => readPages<{ readonly id: string }>([path], 'conflicts', MAX_PAGES),
    online,
    'monitor-conflicts',
  );

  const refreshAll = () => {
    devicesRead.retry();
    conflictsRead.retry();
  };
  useRefreshOnVisible(refreshAll);

  if (!userId) {
    return (
      <section className="sale adm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.sync_monitor')} />
        <SkeletonRows />
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale adm-screen">
        <PageHeader title={t('nav.screens.sync_monitor')} />
        <Banner tone="muted" role="status">
          {t('sync_monitor.online_only')}
        </Banner>
      </section>
    );
  }

  const allDevices = devicesRead.data?.items;
  const openConflictsCount = conflictsRead.data?.items.length ?? 0;
  const summary = allDevices ? summarizeMonitoredDevices(allDevices, openConflictsCount) : null;
  const devices = allDevices ? filterMonitoredDevices(allDevices, filter, search) : undefined;
  const siteName = (id: string | null) => (id ? (refs?.sites.get(id)?.name ?? null) : null);

  return (
    <section className="sale adm-screen">
      <PageHeader
        title={t('nav.screens.sync_monitor')}
        actions={
          <div className="adm-actions">
            <LinkButton to={ROUTES.syncConflicts} variant="outline" size="sm">
              {t('nav.screens.sync_conflicts')}
            </LinkButton>
            {allDevices && !devicesRead.failed ? (
              <Button variant="tonal" icon="sync" onClick={refreshAll} disabled={devicesRead.stale}>
                {t('sync_monitor.refresh')}
              </Button>
            ) : null}
          </div>
        }
      />
      <HelpDisclosure title={t('sync_monitor.help_title')}>
        <p>{t('sync_monitor.intro')}</p>
      </HelpDisclosure>

      {openConflictsCount > 0 ? (
        <Banner
          tone="warn"
          action={
            <LinkButton to={ROUTES.syncConflicts} variant="tonal" size="sm">
              {t('sync_monitor.open_conflicts_action')}
            </LinkButton>
          }
        >
          {t('sync_monitor.open_conflicts_banner', { count: openConflictsCount })}
        </Banner>
      ) : null}

      {summary ? (
        <p className="adm-note" role="status">
          {t('sync_monitor.summary_line', {
            active: summary.activeCount,
            stale: summary.staleCount,
            pendingDevices: summary.pendingDevicesCount,
            pendingOps: summary.pendingOperationsCount,
          })}
        </p>
      ) : null}

      <div className="adm-toolbar">
        <Segmented
          label={t('sync_monitor.filter_label')}
          value={filter}
          onChange={setFilter}
          options={SYNC_MONITOR_FILTERS.map((option) => ({
            value: option,
            label: t(`sync_monitor.filter.${option}`),
          }))}
        />
        <Field label={t('devices.search_label')}>
          {(control) => (
            <Input
              {...control}
              inputMode="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
      </div>

      {devices === undefined && !devicesRead.failed ? <SkeletonRows /> : null}
      {devicesRead.failed ? (
        <Banner
          tone="bad"
          action={
            devicesRead.denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={refreshAll}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {devicesRead.denied ? t('sync_monitor.denied') : t('sync_monitor.unavailable')}
        </Banner>
      ) : null}

      {devices && devices.length === 0 ? (
        <EmptyState icon="phone" title={t(`sync_monitor.none.${filter}`)} />
      ) : null}

      {devices && devices.length > 0 ? (
        <ul className="adm-cards" aria-label={t('nav.screens.sync_monitor')}>
          {devices.map((device) => {
            const thisDevice = device.id === thisDeviceId;
            const site = siteName(device.designatedSiteId);
            const pendingCount = device.pendingReported ?? 0;
            return (
              <li
                key={device.id}
                className="line-card"
                aria-label={t('devices.card_label', { code: device.shortCode })}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <span className="adm-title-line">
                      <strong>{t('devices.card_label', { code: device.shortCode })}</strong>
                      {thisDevice ? <Badge tone="brand">{t('devices.this_device')}</Badge> : null}
                      {device.stale ? (
                        <Badge tone="warn">{t('sync_monitor.badge_stale')}</Badge>
                      ) : null}
                      {pendingCount > 0 ? (
                        <Badge tone="info">
                          {t('sync_monitor.badge_pending', { count: pendingCount })}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="adm-sub">
                      {[
                        device.enrolledByName ?? t('devices.unknown_user'),
                        device.platform,
                        site ? t('devices.site', { name: site }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[device.status] ?? 'muted'}>
                    {t(`devices.status.${device.status}`, { defaultValue: device.status })}
                  </Badge>
                </div>

                <p className={device.stale ? 'adm-note is-warn' : 'adm-note'}>
                  {device.lastContactAt
                    ? t(device.stale ? 'devices.contact_stale' : 'devices.contact', {
                        date: formatDateTime(device.lastContactAt),
                      })
                    : t('devices.contact_never')}
                </p>

                <p className="adm-note">
                  {[
                    device.lastPushAt
                      ? t('sync_monitor.last_push', { date: formatDateTime(device.lastPushAt) })
                      : t('sync_monitor.no_push'),
                    device.lastPullAt
                      ? t('sync_monitor.last_pull', { date: formatDateTime(device.lastPullAt) })
                      : t('sync_monitor.no_pull'),
                  ].join(' · ')}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * ECR-ADM-06 « Organisation : sites, emplacements, zones, géorepères, équipes, points de vente » (RP-1 ;
 * ADMIN ; en ligne seulement). Quatre onglets lisent l'API fraîche (`GET /sites`, `/zones`, `/teams`,
 * `/points-of-sale`) et écrivent par les commandes `organization.*` : une à la fois, relues après la réponse
 * du serveur. Le détail de chaque onglet est dans son panneau ; la logique pure dans `organization.ts`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, PageHeader, TabPanel, Tabs } from '../../components/ui/index.js';
import { AdminGate } from '../admin/AdminGate.js';
import { useAdminPages, useAdminRead, useOnlineCommands } from '../admin/admin-online.js';
import { CommandResult } from '../sales/CommandResult.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import type { DeviceView } from '../devices/devices.js';
import type { UserView } from '../users/users.js';
import {
  DEVICES_PATH,
  POINTS_OF_SALE_PATH,
  SITES_PATH,
  TEAMS_PATH,
  USERS_PATH,
  ZONES_PATH,
  type Option,
  type PosView,
  type SiteView,
  type TeamView,
  type ZoneView,
} from './organization.js';
import { PosPanel } from './PosPanel.js';
import { SitesPanel } from './SitesPanel.js';
import { TeamsPanel } from './TeamsPanel.js';
import { ZonesPanel } from './ZonesPanel.js';
import type { OrgData } from './panel-props.js';
import './organization.css';

type Tab = 'sites' | 'zones' | 'teams' | 'pos';
const TABS: readonly Tab[] = ['sites', 'zones', 'teams', 'pos'];

const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label, 'fr');

function OrganizationBody() {
  const { t } = useTranslation();
  const commands = useOnlineCommands('organization.');
  const [tab, setTab] = useState<Tab>('sites');
  const reload = commands.reloadKey;
  const sites = useAdminRead<{ readonly sites: readonly SiteView[] }>(SITES_PATH, reload);
  const zones = useAdminRead<{ readonly zones: readonly ZoneView[] }>(ZONES_PATH, reload);
  const teams = useAdminRead<{ readonly teams: readonly TeamView[] }>(TEAMS_PATH, reload);
  const points = useAdminRead<{ readonly points_of_sale: readonly PosView[] }>(
    POINTS_OF_SALE_PATH,
    reload,
  );
  const users = useAdminPages<UserView>(USERS_PATH, 'users', reload);
  const devices = useAdminPages<DeviceView>(DEVICES_PATH, 'devices', reload);

  const reads = [sites, zones, teams, points];
  const failed = reads.some((read) => read.failed);
  const denied = reads.some((read) => read.denied);
  const loaded = reads.every((read) => read.data !== undefined);
  const stale = reads.some((read) => read.stale) || users.stale || devices.stale;
  const refresh = () => {
    for (const read of [...reads, users, devices]) read.retry();
  };

  const data: OrgData = {
    sites: sites.data?.sites ?? [],
    zones: zones.data?.zones ?? [],
    teams: teams.data?.teams ?? [],
    pointsOfSale: points.data?.points_of_sale ?? [],
    users: (users.data?.items ?? [])
      .map((user) => ({ id: user.id, label: user.fullName }))
      .sort(byLabel),
    devices: (devices.data?.items ?? [])
      .map((device) => ({
        id: device.id,
        label: [device.shortCode, device.label, device.platform].filter(Boolean).join(' · '),
      }))
      .sort(byLabel),
    stale,
    reloadKey: reload,
  };

  return (
    <>
      <PageHeader
        title={t('nav.screens.organization')}
        actions={
          loaded && !failed ? (
            <Button variant="tonal" icon="sync" onClick={refresh} disabled={stale}>
              {t('org.refresh')}
            </Button>
          ) : undefined
        }
      />
      <HelpDisclosure title={t('org.help_title')}>
        <p>{t('org.intro')}</p>
      </HelpDisclosure>
      {commands.last ? <CommandResult commandId={commands.last} messages="org.result" /> : null}
      {commands.saveError ? <Banner tone="bad">{t(commands.saveError)}</Banner> : null}
      {failed ? (
        <Banner
          tone="bad"
          action={
            denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={refresh}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {denied ? t('org.denied') : t('org.unavailable')}
        </Banner>
      ) : null}
      <Tabs
        label={t('org.tabs_label')}
        idPrefix="org"
        value={tab}
        onChange={setTab}
        items={TABS.map((id) => ({ id, label: t(`org.tab.${id}`) }))}
      />
      {TABS.map((id) => (
        <TabPanel key={id} idPrefix="org" id={id} active={tab === id}>
          {tab === id && loaded ? (
            id === 'sites' ? (
              <SitesPanel data={data} commands={commands} />
            ) : id === 'zones' ? (
              <ZonesPanel data={data} commands={commands} />
            ) : id === 'teams' ? (
              <TeamsPanel data={data} commands={commands} />
            ) : (
              <PosPanel data={data} commands={commands} />
            )
          ) : null}
        </TabPanel>
      ))}
    </>
  );
}

export function OrganizationScreen() {
  const { t } = useTranslation();
  return (
    <AdminGate title={t('nav.screens.organization')}>
      <OrganizationBody />
    </AdminGate>
  );
}

/**
 * ECR-ADM-07 « Paramètres et politiques de contrôle » (RP-1 ; ADMIN, DIRECTION ; en ligne seulement) : deux
 * onglets — les paramètres système versionnés et les politiques de contrôle. Une commande à la fois, relue
 * après la réponse du serveur ; la logique pure est dans `settings.ts`, la forme des valeurs dans le catalogue
 * partagé (`@gic/contracts`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, PageHeader, TabPanel, Tabs } from '../../components/ui/index.js';
import { AdminGate } from '../admin/AdminGate.js';
import { useOnlineCommands } from '../admin/admin-online.js';
import { ArchivePanel } from '../attachments/ArchivePanel.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import { PoliciesPanel } from './PoliciesPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import './settings.css';

type Tab = 'settings' | 'policies' | 'archive';
const TABS: readonly Tab[] = ['settings', 'policies'];
/** L'archive des photos est réservée à l'administrateur (droits `attachments.archive.*`, AV-539). */
const ARCHIVE_ROLE = 'ADMIN';

function SettingsBody() {
  const { t } = useTranslation();
  // Les deux familles de commandes se suivent ensemble : une seule opération en cours dans l'écran.
  const commands = useOnlineCommands(['organization.setting.', 'approvals.policy.']);
  const [tab, setTab] = useState<Tab>('settings');
  const { state } = useAuth();
  const navigation = useRememberedNavigation(
    state.status === 'unlocked' ? state.userId : undefined,
  );
  const tabs: readonly Tab[] = navigation?.roles.includes(ARCHIVE_ROLE)
    ? [...TABS, 'archive']
    : TABS;
  return (
    <>
      <PageHeader title={t('nav.screens.settings')} />
      <HelpDisclosure title={t('settings.help_title')}>
        <p>{t('settings.intro')}</p>
      </HelpDisclosure>
      {commands.last ? (
        <CommandResult commandId={commands.last} messages="settings.result" />
      ) : null}
      {commands.saveError ? <Banner tone="bad">{t(commands.saveError)}</Banner> : null}
      <Tabs
        label={t('settings.tabs_label')}
        idPrefix="settings"
        value={tab}
        onChange={setTab}
        items={tabs.map((id) => ({ id, label: t(`settings.tab.${id}`) }))}
      />
      {tabs.map((id) => (
        <TabPanel key={id} idPrefix="settings" id={id} active={tab === id}>
          {tab === id ? (
            id === 'settings' ? (
              <SettingsPanel commands={commands} />
            ) : id === 'policies' ? (
              <PoliciesPanel commands={commands} />
            ) : (
              <ArchivePanel />
            )
          ) : null}
        </TabPanel>
      ))}
    </>
  );
}

export function SettingsScreen() {
  const { t } = useTranslation();
  return (
    <AdminGate title={t('nav.screens.settings')}>
      <SettingsBody />
    </AdminGate>
  );
}

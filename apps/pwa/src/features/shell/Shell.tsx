/**
 * Coquille de l'application déverrouillée (ADR-049, lot L2) : barre du haut, onglets du bas ou barre
 * latérale selon la largeur, actions rapides (« + »), menu du compte, bandeaux d'autonomie et
 * d'approbation de l'appareil. Rôles, actions et nom viennent de la navigation mémorisée sur l'appareil
 * (`navigation-store`) : la coquille s'affiche donc aussi hors ligne.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cx } from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { useAuth } from '../auth/AuthContext.js';
import { DeviceApprovalBanner } from '../devices/DeviceApprovalBanner.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { AutonomyBanner } from '../sync/AutonomyBanner.js';
import { Sidebar, TabBar, TopBar } from './Bars.js';
import {
  activeScreenPath,
  activeTabId,
  quickActions,
  sidebarGroups,
  tabsForRoles,
} from './nav-config.js';
import { AccountSheet, QuickActionsSheet } from './Sheets.js';

export interface ShellProps {
  onLogout: () => void;
  children: ReactNode;
}

export function Shell({ onLogout, children }: ShellProps) {
  const { t } = useTranslation();
  const { state } = useAuth();
  const { pathname } = useLocation();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  // Une feuille se souvient de l'écran où elle a été ouverte : elle se referme d'elle-même dès qu'on en
  // change (le chemin ne correspond plus), sans effet ni état à resynchroniser.
  const [quickAt, setQuickAt] = useState<string | null>(null);
  const [accountAt, setAccountAt] = useState<string | null>(null);
  const quickOpen = quickAt === pathname;
  const accountOpen = accountAt === pathname;

  const roles = navigation?.roles;
  const tabs = useMemo(() => tabsForRoles(roles ?? []), [roles]);
  const groups = useMemo(() => sidebarGroups(roles ?? []), [roles]);
  const quick = useMemo(() => quickActions(navigation), [navigation]);

  const userName = navigation?.full_name ?? '';
  const roleLabels = navigation?.sections.map((section) => section.roleLabel) ?? [];

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('nav.skip')}
      </a>
      <Sidebar
        groups={groups}
        activePath={activeScreenPath(pathname, groups)}
        homeActive={pathname === ROUTES.home}
        userName={userName}
        roleLabels={roleLabels}
        onAccount={() => setAccountAt(pathname)}
      />
      <div className="shell-body">
        <TopBar userName={userName} onAccount={() => setAccountAt(pathname)} />
        <main
          id="main"
          tabIndex={-1}
          className={cx('shell-main', pathname === ROUTES.home && 'shell-main-wide')}
        >
          <AutonomyBanner />
          <DeviceApprovalBanner />
          {children}
        </main>
      </div>
      <TabBar
        tabs={tabs}
        activeId={activeTabId(pathname, tabs)}
        hasQuick={quick.length > 0}
        onQuick={() => setQuickAt(pathname)}
      />
      <QuickActionsSheet open={quickOpen} onClose={() => setQuickAt(null)} groups={quick} />
      <AccountSheet
        open={accountOpen}
        onClose={() => setAccountAt(null)}
        userName={userName}
        roleLabels={roleLabels}
        onLogout={() => {
          setAccountAt(null);
          onLogout();
        }}
      />
    </div>
  );
}

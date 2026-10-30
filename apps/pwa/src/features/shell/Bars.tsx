/**
 * Barres de la coquille (ADR-049) : barre du haut (marque, synchronisation, compte), onglets du bas sur
 * téléphone, barre latérale groupée par domaine sur ordinateur. La feuille de style n'en montre qu'une
 * des deux navigations selon la largeur (`styles/shell.css`).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Avatar, Icon, type IconName } from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { SyncBadge } from '../sync/SyncBadge.js';
import type { SidebarGroup, TabSpec } from './nav-config.js';

export interface TopBarProps {
  userName: string;
  onAccount: () => void;
}

export function TopBar({ userName, onAccount }: TopBarProps) {
  const { t } = useTranslation();
  return (
    <header className="topbar">
      <Link to={ROUTES.home} className="topbar-brand">
        <img className="topbar-logo" src="/pwa-192.png" alt="" width={34} height={34} />
        <span className="topbar-name">{t('app.name')}</span>
      </Link>
      <SyncBadge />
      <button
        type="button"
        className="topbar-account"
        aria-label={t('nav.account_open')}
        onClick={onAccount}
      >
        <Avatar name={userName || '?'} />
      </button>
    </header>
  );
}

function TabItem({
  to,
  icon,
  label,
  active,
}: {
  to: string;
  icon: IconName;
  label: string;
  active: boolean;
}) {
  return (
    <Link to={to} className="tabbar-item" aria-current={active ? 'page' : undefined}>
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </Link>
  );
}

export interface TabBarProps {
  tabs: readonly TabSpec[];
  activeId: string;
  /** Affiche le bouton « + » (actions rapides) entre les deux destinations. */
  hasQuick: boolean;
  onQuick: () => void;
}

export function TabBar({ tabs, activeId, hasQuick, onQuick }: TabBarProps) {
  const { t } = useTranslation();
  const [first, second] = tabs;
  const item = (tab: TabSpec) => (
    <TabItem
      key={tab.id}
      to={tab.path}
      icon={tab.icon}
      label={t(`nav.tabs.${tab.labelKey}`)}
      active={activeId === tab.id}
    />
  );
  return (
    <nav className="tabbar" aria-label={t('nav.primary')}>
      <TabItem
        to={ROUTES.home}
        icon="home"
        label={t('nav.tabs.home')}
        active={activeId === 'home'}
      />
      {first ? item(first) : null}
      {hasQuick ? (
        <button
          type="button"
          className="tabbar-fab"
          aria-label={t('nav.quick_open')}
          onClick={onQuick}
        >
          <Icon name="plus" size={26} />
        </button>
      ) : null}
      {second ? item(second) : null}
      <TabItem
        to={ROUTES.menu}
        icon="more"
        label={t('nav.tabs.more')}
        active={activeId === 'more'}
      />
    </nav>
  );
}

export interface SidebarProps {
  groups: readonly SidebarGroup[];
  /** Chemin de l'entrée active (`activeScreenPath`), `null` hors registre. */
  activePath: string | null;
  homeActive: boolean;
  userName: string;
  roleLabels: readonly string[];
  onAccount: () => void;
}

/** Au-delà de ce nombre d'entrées, seuls les domaines utiles sont dépliés. */
const EXPAND_ALL_UNTIL = 14;

export function Sidebar({
  groups,
  activePath,
  homeActive,
  userName,
  roleLabels,
  onAccount,
}: SidebarProps) {
  const { t } = useTranslation();
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const activeGroup = groups.find((group) =>
    group.items.some((item) => item.path === activePath),
  )?.group;
  // Ouvert par défaut : tous les domaines si la liste est courte, sinon celui de l'écran courant.
  // Un choix de l'utilisateur (déplier ou replier) l'emporte sur ce défaut.
  const [chosen, setChosen] = useState<Readonly<Record<string, boolean>>>({});
  const isOpen = (group: string): boolean =>
    chosen[group] ?? (total <= EXPAND_ALL_UNTIL || group === activeGroup);
  const toggle = (group: string) =>
    setChosen((current) => ({ ...current, [group]: !isOpen(group) }));

  return (
    <aside className="sidebar">
      <Link to={ROUTES.home} className="sidebar-brand">
        <img src="/pwa-192.png" alt="" width={40} height={40} />
        <span>
          <b>{t('app.name')}</b>
          <small>{t('app.tagline')}</small>
        </span>
      </Link>
      <nav className="sidebar-nav" aria-label={t('nav.primary')}>
        <Link
          to={ROUTES.home}
          className="sidebar-item"
          aria-current={homeActive ? 'page' : undefined}
        >
          <Icon name="home" />
          {t('nav.tabs.home')}
        </Link>
        {groups.map(({ group, items }) => {
          const expanded = isOpen(group);
          return (
            <div key={group}>
              <button
                type="button"
                className="sidebar-group-title"
                aria-expanded={expanded}
                onClick={() => toggle(group)}
              >
                {t(`nav.groups.${group}`)}
                <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
              </button>
              <ul className="sidebar-list" hidden={!expanded}>
                {items.map((item) => (
                  <li key={item.id}>
                    <Link
                      to={item.path}
                      className="sidebar-item"
                      aria-current={item.path === activePath ? 'page' : undefined}
                    >
                      <Icon name={item.icon} />
                      {t(`nav.screens.${item.labelKey}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <button type="button" className="sidebar-user" onClick={onAccount}>
        <Avatar name={userName || '?'} />
        <span className="sidebar-user-text">
          <b>{userName || t('nav.account')}</b>
          {roleLabels.length > 0 ? <small>{roleLabels.join(' · ')}</small> : null}
        </span>
        <Icon name="sliders" size={18} />
      </button>
    </aside>
  );
}

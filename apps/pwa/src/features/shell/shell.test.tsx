/**
 * Barres et feuilles de la coquille (ADR-049, lot L2) : onglets du bas, barre latérale (domaines
 * repliables, écran actif), actions rapides et menu du compte. Rôles ARIA et libellés, comme les écrans.
 */
import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ROUTES } from '../../app/screens.js';
import { Sidebar, TabBar } from './Bars.js';
import { ROLE_ORDER, sidebarGroups, tabsForRoles, type QuickActionGroup } from './nav-config.js';
import { AccountSheet, QuickActionsSheet } from './Sheets.js';

const show = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('TabBar', () => {
  it('Accueil, deux destinations du rôle, « + » entre elles et « Plus » ; l’onglet actif est marqué', async () => {
    const onQuick = vi.fn();
    const user = userEvent.setup();
    show(
      <TabBar tabs={tabsForRoles(['VENDEUR_PDV'])} activeId="sales" hasQuick onQuick={onQuick} />,
    );
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });
    expect(within(nav).getByRole('link', { name: 'Accueil' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Ventes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Stock' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Plus' })).toHaveAttribute('href', ROUTES.menu);
    await user.click(within(nav).getByRole('button', { name: 'Actions rapides' }));
    expect(onQuick).toHaveBeenCalledTimes(1);
  });

  it('sans action rapide, pas de « + » ; sans destination (rôles inconnus), Accueil et Plus seulement', () => {
    show(<TabBar tabs={[]} activeId="home" hasQuick={false} onQuick={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Actions rapides' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Accueil',
      'Plus',
    ]);
    expect(screen.getByRole('link', { name: 'Accueil' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('Sidebar', () => {
  const noop = () => undefined;

  it('liste courte : tous les domaines sont dépliés, l’écran courant est marqué', () => {
    const groups = sidebarGroups(['RESP_ACHATS']);
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(total).toBeLessThanOrEqual(14);
    show(
      <Sidebar
        groups={groups}
        activePath={ROUTES.purchaseOrders}
        homeActive={false}
        userName="Awa Mbarga"
        roleLabels={['Responsable achats']}
        onAccount={noop}
      />,
    );
    const toggles = screen.getAllByRole('button', { expanded: true });
    expect(toggles).toHaveLength(groups.length);
    expect(screen.getByRole('link', { name: 'Bons de commande' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Accueil' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Awa Mbarga')).toBeInTheDocument();
    expect(screen.getByText('Responsable achats')).toBeInTheDocument();
  });

  it('liste longue : seul le domaine de l’écran courant est déplié, les autres se déplient au clic', async () => {
    const user = userEvent.setup();
    show(
      <Sidebar
        groups={sidebarGroups(ROLE_ORDER)}
        activePath={ROUTES.receivables}
        homeActive={false}
        userName=""
        roleLabels={[]}
        onAccount={noop}
      />,
    );
    const finance = screen.getByRole('button', { name: 'Finance' });
    const sales = screen.getByRole('button', { name: 'Ventes' });
    expect(finance).toHaveAttribute('aria-expanded', 'true');
    expect(sales).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: 'Créances' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Ventes récentes' })).not.toBeInTheDocument();
    await user.click(sales);
    expect(sales).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Ventes récentes' })).toBeInTheDocument();
    await user.click(finance);
    expect(finance).toHaveAttribute('aria-expanded', 'false');
  });

  it('le nom et les rôles ouvrent le menu du compte', async () => {
    const onAccount = vi.fn();
    const user = userEvent.setup();
    show(
      <Sidebar
        groups={[]}
        activePath={null}
        homeActive
        userName="Awa Mbarga"
        roleLabels={['Magasinier', 'Vendeur de point de vente']}
        onAccount={onAccount}
      />,
    );
    expect(screen.getByRole('link', { name: 'Accueil' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: /Awa Mbarga/ }));
    expect(onAccount).toHaveBeenCalledTimes(1);
  });
});

describe('QuickActionsSheet', () => {
  const groups: QuickActionGroup[] = [
    {
      role: 'VENDEUR_PDV',
      roleLabel: 'Vendeur de point de vente',
      actions: [
        {
          key: 'NEW_SALE|/ventes/nouvelle',
          code: 'NEW_SALE',
          label: '+ VENTE',
          hint: 'Enregistrer une vente et encaisser',
          route: ROUTES.newSale,
          primary: true,
        },
        {
          key: 'LOSS|/stock/perte',
          code: 'LOSS',
          label: 'Déclarer une perte',
          hint: null,
          route: ROUTES.loss,
          primary: false,
        },
      ],
    },
  ];

  it('liste les actions du rôle comme des liens vers leur écran', () => {
    show(<QuickActionsSheet open onClose={() => undefined} groups={groups} />);
    expect(screen.getByRole('heading', { name: 'Actions rapides' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /\+ VENTE/ })).toHaveAttribute('href', ROUTES.newSale);
    expect(screen.getByRole('link', { name: /Déclarer une perte/ })).toHaveAttribute(
      'href',
      ROUTES.loss,
    );
  });

  it('sans action : un message, pas de lien', () => {
    show(<QuickActionsSheet open onClose={() => undefined} groups={[]} />);
    expect(screen.getByText('Aucune action rapide pour le moment.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('AccountSheet', () => {
  it('nom, rôles, apparence (clair par défaut) et déconnexion', async () => {
    const onLogout = vi.fn();
    const user = userEvent.setup();
    show(
      <AccountSheet
        open
        onClose={() => undefined}
        userName="Awa Mbarga"
        roleLabels={['Magasinier', 'Vendeur de point de vente']}
        onLogout={onLogout}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Mon compte' })).toBeInTheDocument();
    expect(screen.getByText('Awa Mbarga')).toBeInTheDocument();
    expect(screen.getByText('Magasinier · Vendeur de point de vente')).toBeInTheDocument();
    const theme = screen.getByRole('radiogroup', { name: 'Apparence' });
    expect(within(theme).getByRole('radio', { name: 'Clair' })).toBeChecked();
    await user.click(within(theme).getByRole('radio', { name: 'Sombre' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(within(theme).getByRole('radio', { name: 'Clair' }));
    expect(screen.getByRole('link', { name: 'Synchronisation' })).toHaveAttribute(
      'href',
      ROUTES.sync,
    );
    await user.click(screen.getByRole('button', { name: 'Se déconnecter' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

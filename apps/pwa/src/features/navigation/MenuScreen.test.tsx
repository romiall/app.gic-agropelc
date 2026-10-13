import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FixedClock } from '@gic/domain';
import type { HomeResponse } from '@gic/contracts';
import { getDb } from '../../storage/db.js';
import { MenuScreen } from './MenuScreen.js';
import { rememberNavigation } from './navigation-store.js';

vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({ state: { status: 'unlocked', userId: 'user-1', deviceStatus: 'ACTIVE' } }),
}));

const clock = new FixedClock(new Date('2026-10-10T08:00:00.000Z'));

const response: Pick<HomeResponse, 'user' | 'sections'> = {
  user: { fullName: 'Awa Mbarga', roles: ['VENDEUR_PDV'] },
  sections: [
    {
      role: 'VENDEUR_PDV',
      roleLabel: 'Vendeur de point de vente',
      scopeLabel: 'Votre site',
      actions: [
        { code: 'CASH_OPEN', label: 'Ouvrir la caisse', hint: null, route: null, primary: false },
        { code: 'SYNC_STATUS', label: 'Synchronisation', hint: null, route: null, primary: false },
        { code: 'EXPENSES', label: 'Dépenses de caisse', hint: null, route: null, primary: false },
      ],
      kpis: [],
      activity: [],
    },
  ],
};

describe('MenuScreen (navigation par rôle, hors ligne)', () => {
  beforeEach(async () => {
    await getDb().navigation.clear();
  });

  afterEach(async () => {
    await getDb().navigation.clear();
  });

  it('sans navigation mémorisée : invite à ouvrir l’accueil en ligne, garde les écrans communs', async () => {
    render(
      <MemoryRouter>
        <MenuScreen onLogout={() => undefined} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/première ouverture de l’accueil/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Synchronisation/ })).toHaveAttribute(
      'href',
      '/synchronisation',
    );
  });

  it('avec la navigation mémorisée : actions du jour qui mènent à un écran, rôles affichés', async () => {
    await rememberNavigation(getDb(), clock, 'user-1', response);
    render(
      <MemoryRouter>
        <MenuScreen onLogout={() => undefined} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Vendeur de point de vente')).toBeInTheDocument();
    const actions = screen.getByRole('region', { name: 'Actions du jour' });
    expect(actions).toHaveTextContent('Synchronisation');
    // « Ouvrir la caisse » mène à l'écran de la caisse (ECR-DIS-02).
    expect(within(actions).getByRole('link', { name: /Ouvrir la caisse/ })).toHaveAttribute(
      'href',
      '/caisse',
    );
    // Les dépenses de caisse n'ont pas d'écran (P8) : absentes du menu.
    expect(actions).not.toHaveTextContent('Dépenses de caisse');
  });

  it('la déconnexion se fait depuis le menu', async () => {
    const onLogout = vi.fn();
    render(
      <MemoryRouter>
        <MenuScreen onLogout={onLogout} />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Se déconnecter' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('la navigation mémorisée ne garde ni indicateur ni activité', async () => {
    await rememberNavigation(getDb(), clock, 'user-1', response);
    const record = await getDb().navigation.get('user-1');
    expect(record).toMatchObject({ roles: ['VENDEUR_PDV'], saved_at: '2026-10-10T08:00:00.000Z' });
    expect(Object.keys(record?.sections[0] ?? {})).toEqual(['role', 'roleLabel', 'actions']);
  });
});

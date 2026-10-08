import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { HomeResponse } from '@gic/contracts';
import { HomeScreen } from './HomeScreen.js';
import { authorizedRequest } from '../../sync/api-client.js';

vi.mock('../../storage/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));

const request = vi.mocked(authorizedRequest);

function homeResponse(overrides: Partial<HomeResponse> = {}): HomeResponse {
  return {
    generatedAt: '2026-10-08T13:32:00.000Z',
    businessDay: '2026-10-08',
    user: { fullName: 'Awa Mbarga', roles: ['VENDEUR_PDV'] },
    signals: [
      {
        code: 'STOCK_OUT',
        severity: 'CRITICAL',
        title: '2 produits en rupture',
        detail: 'Disponible nul : réapprovisionner.',
        count: 2,
        action: { label: 'Voir le stock', route: null },
      },
      {
        code: 'OVERDUE_RECEIVABLE',
        severity: 'WARNING',
        title: '1 créance en retard : 45 000 F CFA',
        detail: null,
        count: 1,
        action: { label: 'Synchronisation', route: '/synchronisation' },
      },
    ],
    sections: [
      {
        role: 'VENDEUR_PDV',
        roleLabel: 'Vendeur de point de vente',
        scopeLabel: 'Votre site',
        actions: [
          { code: 'SELL', label: 'Vendre', hint: 'Nouvelle vente', route: null, primary: true },
          {
            code: 'SYNC_STATUS',
            label: 'Synchronisation',
            hint: null,
            route: '/synchronisation',
            primary: false,
          },
        ],
        kpis: [
          {
            code: 'KPI-COM-08',
            label: "Chiffre d'affaires du jour",
            value: 125000,
            unit: 'XAF',
            detail: '5 ventes',
            delta: { label: '+20 % vs hier', direction: 'up', tone: 'good' },
            series: [
              { day: '2026-10-06', value: 80000 },
              { day: '2026-10-07', value: 104000 },
              { day: '2026-10-08', value: 125000 },
            ],
            tone: 'good',
          },
          {
            code: 'KPI-STK-02',
            label: 'Valeur du stock',
            value: null,
            unit: 'XAF',
            detail: null,
            delta: null,
            series: null,
            tone: 'neutral',
          },
        ],
        activity: [
          {
            code: 'RECENT_SALES',
            title: 'Dernières ventes',
            items: [
              {
                id: 'v1',
                at: '2026-10-08T12:10:00.000Z',
                label: 'VTE-001',
                detail: 'Client anonyme',
                amountXaf: 18000,
                tone: 'neutral',
              },
              {
                id: 'v2',
                at: '2026-10-06T08:05:00.000Z',
                label: 'VTE-000',
                detail: null,
                amountXaf: null,
                tone: 'neutral',
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function renderHome() {
  return render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  request.mockReset();
});

describe('HomeScreen (ECR-ADM-03)', () => {
  it('affiche d’abord un chargement, puis la salutation, la date et la fraîcheur', async () => {
    request.mockResolvedValue({ ok: true, data: homeResponse() });
    renderHome();
    expect(screen.getByText('Chargement de votre tableau de bord…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Bonjour, Awa Mbarga' })).toBeInTheDocument();
    expect(screen.getByText('Jeudi 8 octobre')).toBeInTheDocument();
    expect(screen.getByText('Mis à jour à 14:32')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith({}, '/api/v1/home', { method: 'GET' });
  });

  it('signaux : la gravité est écrite en toutes lettres, l’action sans écran est « bientôt »', async () => {
    request.mockResolvedValue({ ok: true, data: homeResponse() });
    renderHome();
    const list = await screen.findByRole('region', { name: 'À traiter en priorité' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Urgent')).toBeInTheDocument();
    expect(within(items[0]!).getByText('2 produits en rupture')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Voir le stock · bientôt')).toBeInTheDocument();
    expect(within(items[1]!).getByText('À surveiller')).toBeInTheDocument();
    expect(within(items[1]!).getByRole('link', { name: 'Synchronisation' })).toHaveAttribute(
      'href',
      '/synchronisation',
    );
  });

  it('section du rôle : périmètre, action avec écran = lien, sans écran = bouton désactivé « Bientôt »', async () => {
    request.mockResolvedValue({ ok: true, data: homeResponse() });
    renderHome();
    const section = await screen.findByRole('region', { name: 'Vendeur de point de vente' });
    expect(within(section).getByText('Votre site')).toBeInTheDocument();

    const link = within(section).getByRole('link', { name: 'Synchronisation' });
    expect(link).toHaveAttribute('href', '/synchronisation');

    const soon = within(section).getByRole('button', { name: /Vendre/ });
    expect(soon).toBeDisabled();
    expect(soon).toHaveClass('action-primary');
    expect(within(soon).getByText('Bientôt')).toBeInTheDocument();
  });

  it('indicateurs : montant en francs CFA, valeur absente en tiret, variation et détail', async () => {
    request.mockResolvedValue({ ok: true, data: homeResponse() });
    renderHome();
    await screen.findByRole('heading', { name: 'Bonjour, Awa Mbarga' });

    const revenue = document.querySelector('[data-kpi="KPI-COM-08"]') as HTMLElement;
    expect(within(revenue).getByText('125 000 F CFA')).toBeInTheDocument();
    expect(within(revenue).getByText('5 ventes')).toBeInTheDocument();
    expect(within(revenue).getByText(/\+20 % vs hier/)).toBeInTheDocument();
    expect(within(revenue).getByRole('img', { name: 'Évolution sur 3 jours' })).toBeInTheDocument();

    const valuation = document.querySelector('[data-kpi="KPI-STK-02"]') as HTMLElement;
    expect(within(valuation).getByText('—')).toBeInTheDocument();
    expect(within(valuation).queryByRole('img')).not.toBeInTheDocument();
  });

  it('activité récente : heure du jour même, date courte sinon, montant si présent', async () => {
    request.mockResolvedValue({ ok: true, data: homeResponse() });
    renderHome();
    const activity = await screen.findByRole('region', { name: 'Dernières ventes' });
    expect(within(activity).getByText('13:10')).toBeInTheDocument();
    expect(within(activity).getByText('18 000 F CFA')).toBeInTheDocument();
    expect(within(activity).getByText('6 oct. 09:05')).toBeInTheDocument();
  });

  it('aucun signal : message rassurant ; aucun rôle : explication', async () => {
    request.mockResolvedValueOnce({ ok: true, data: homeResponse({ signals: [] }) });
    const { unmount } = renderHome();
    expect(await screen.findByText('Rien d’urgent pour le moment.')).toBeInTheDocument();
    unmount();

    request.mockResolvedValueOnce({
      ok: true,
      data: homeResponse({ signals: [], sections: [], user: { fullName: 'Sans Rôle', roles: [] } }),
    });
    renderHome();
    expect(await screen.findByText(/Aucun rôle actif ne vous est attribué/)).toBeInTheDocument();
    expect(screen.queryByText('Rien d’urgent pour le moment.')).not.toBeInTheDocument();
  });

  it('sans donnée et hors ligne : message d’erreur et nouvel essai', async () => {
    const user = userEvent.setup();
    request.mockResolvedValueOnce({ ok: false, reason: 'OFFLINE' });
    renderHome();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pas de réseau et aucune donnée récente à afficher.',
    );

    request.mockResolvedValueOnce({ ok: true, data: homeResponse() });
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('heading', { name: 'Bonjour, Awa Mbarga' })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ok: false, reason: 'SESSION_INVALID' } as const, 'Votre session a expiré'],
    [
      { ok: false, reason: 'HTTP_ERROR', status: 500, body: undefined } as const,
      'Le service est momentanément indisponible',
    ],
  ])('erreur sans donnée : message distinct (%#)', async (result, message) => {
    request.mockResolvedValueOnce(result);
    renderHome();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('une réponse de forme inattendue est une erreur du service, pas un écran cassé', async () => {
    request.mockResolvedValueOnce({ ok: true, data: { n: 'importe quoi' } });
    renderHome();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible',
    );
  });

  it('hors ligne après une première réponse : les chiffres restent, avec leur heure et un bandeau', async () => {
    const user = userEvent.setup();
    request.mockResolvedValueOnce({ ok: true, data: homeResponse() });
    renderHome();
    await screen.findByRole('heading', { name: 'Bonjour, Awa Mbarga' });

    request.mockResolvedValueOnce({ ok: false, reason: 'OFFLINE' });
    await user.click(screen.getByRole('button', { name: 'Actualiser' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Hors ligne : ces chiffres datent de 14:32.',
      ),
    );
    expect(screen.getByText('125 000 F CFA')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

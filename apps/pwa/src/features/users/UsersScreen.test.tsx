import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { UsersScreen } from './UsersScreen.js';
import {
  matchesSearch,
  refusalOf,
  resetPath,
  resetProblem,
  sortByName,
  usersPath,
  type UserView,
} from './users.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
    deviceId: '01900000-0000-7000-8000-0000000000d0',
  }),
}));

function account(overrides: Partial<UserView> = {}): UserView {
  return {
    id: '01900000-0000-7000-8000-0000000003a1',
    fullName: 'Awa Nde',
    phone: '+237690000001',
    email: null,
    status: 'ACTIVE',
    statusChangedAt: null,
    mustChangePassword: false,
    lastLoginAt: '2026-10-13T08:00:00.000Z',
    createdAt: '2026-10-01T08:00:00.000Z',
    roles: ['VENDEUR_PDV'],
    actions: { resetPassword: true },
    ...overrides,
  };
}

/** Réponses du serveur : la liste, puis la réinitialisation. */
function serve(users: readonly UserView[], reset: unknown = { ok: true, data: { status: 'ok' } }) {
  vi.mocked(authorizedRequest).mockImplementation(
    (_db, path, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? reset
          : String(path).startsWith('/api/v1/users')
            ? { ok: true, data: { users, next_cursor: null } }
            : { ok: false, reason: 'HTTP_ERROR', status: 500, body: {} },
      ) as never,
  );
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <UsersScreen />
    </MemoryRouter>,
  );
}

describe('Utilisateurs : logique (ECR-ADM-04 partiel, MP-08)', () => {
  it('chemins, recherche par nom ou téléphone, tri par nom, saisie du provisoire, refus du serveur', () => {
    expect(usersPath('ACTIVE')).toBe('/api/v1/users?limit=200&status=ACTIVE');
    expect(usersPath('ALL')).toBe('/api/v1/users?limit=200');
    expect(resetPath('abc')).toBe('/api/v1/users/abc/reset-password');
    expect(matchesSearch(account(), 'awa')).toBe(true);
    expect(matchesSearch(account(), '690 000')).toBe(true);
    expect(matchesSearch(account(), 'paul')).toBe(false);
    expect(
      sortByName([account({ fullName: 'Paul' }), account({ fullName: 'Awa' })]).map(
        (user) => user.fullName,
      ),
    ).toEqual(['Awa', 'Paul']);
    expect(resetProblem('court', 'court')).toBe('TOO_SHORT');
    expect(resetProblem('provisoire1', 'provisoire2')).toBe('MISMATCH');
    expect(resetProblem('provisoire1', 'provisoire1')).toBeNull();
    expect(
      refusalOf({ error: { code: 'USER_DEACTIVATED', message: 'Compte désactivé.' } }),
    ).toEqual({ code: 'USER_DEACTIVATED', message: 'Compte désactivé.' });
    expect(refusalOf(undefined)).toEqual({ code: 'UNKNOWN', message: null });
  });
});

describe('Utilisateurs (ECR-ADM-04 partiel, MP-08)', () => {
  beforeEach(async () => {
    await getDb().outbox.clear();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().outbox.clear();
  });

  it('réinitialise un mot de passe : route hors file d’envoi, saisie vidée, message de suite', async () => {
    serve([
      account(),
      account({
        id: '01900000-0000-7000-8000-0000000003a2',
        fullName: 'Paul Essomba',
        actions: { resetPassword: false },
        roles: [],
      }),
    ]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
      '/api/v1/users?limit=200&status=ACTIVE',
    );
    expect(within(card).getByText(/Vendeur de point de vente/)).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Paul Essomba' })).queryByRole('button'),
    ).toBeNull();
    expect(
      within(screen.getByRole('listitem', { name: 'Paul Essomba' })).getByText(/aucun rôle/),
    ).toBeInTheDocument();

    await user.click(
      within(card).getByRole('button', { name: 'Réinitialiser le mot de passe de Awa Nde' }),
    );
    const submit = within(card).getByRole('button', { name: 'Réinitialiser pour Awa Nde' });
    expect(submit).toBeDisabled();
    await user.type(within(card).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    // MP-11 : rien n'est signalé tant que la confirmation n'est pas commencée ; bouton grisé.
    expect(within(card).queryByText(/ne correspondent pas/)).toBeNull();
    expect(submit).toBeDisabled();
    await user.type(
      within(card).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-2',
    );
    expect(
      within(card).getByText('Les deux saisies du mot de passe provisoire ne correspondent pas.'),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(within(card).getByLabelText('Confirmer le mot de passe provisoire'));
    await user.type(
      within(card).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    await user.click(submit);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Mot de passe de Awa Nde réinitialisé',
    );
    const post = vi
      .mocked(authorizedRequest)
      .mock.calls.find((call) => (call[2] as RequestInit | undefined)?.method === 'POST')!;
    expect(post[1]).toBe('/api/v1/users/01900000-0000-7000-8000-0000000003a1/reset-password');
    expect(JSON.parse((post[2] as RequestInit).body as string)).toEqual({
      new_password: 'provisoire-1',
    });
    // Hors du journal des commandes : rien dans la file d'envoi ; plus aucun champ ouvert.
    expect(await getDb().outbox.count()).toBe(0);
    expect(screen.queryByLabelText('Mot de passe provisoire')).toBeNull();
    // Liste relue après la réinitialisation.
    await waitFor(() =>
      expect(
        vi
          .mocked(authorizedRequest)
          .mock.calls.filter((call) => call[1] === '/api/v1/users?limit=200&status=ACTIVE').length,
      ).toBeGreaterThan(1),
    );
  });

  it('refus du serveur et réseau absent : message, sans réinitialisation', async () => {
    serve([account()], {
      ok: false,
      reason: 'HTTP_ERROR',
      status: 409,
      body: {
        error: { code: 'USER_DEACTIVATED', message: 'Compte désactivé : réactivez-le avant.' },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(
      within(card).getByRole('button', { name: /Réinitialiser le mot de passe de/ }),
    );
    await user.type(within(card).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    await user.type(
      within(card).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    await user.click(within(card).getByRole('button', { name: 'Réinitialiser pour Awa Nde' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Réinitialisation refusée : Compte désactivé : réactivez-le avant.',
    );

    cleanup();
    serve([account()], { ok: false, reason: 'OFFLINE' });
    renderScreen();
    const again = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(
      within(again).getByRole('button', { name: /Réinitialiser le mot de passe de/ }),
    );
    await user.type(within(again).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    await user.type(
      within(again).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    await user.click(within(again).getByRole('button', { name: 'Réinitialiser pour Awa Nde' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pas de réseau');
  });

  it('mot de passe provisoire en cours signalé ; filtre ; hors ligne ; droit refusé', async () => {
    serve([account({ mustChangePassword: true, lastLoginAt: null })]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(within(card).getByText(/Mot de passe provisoire : à changer/)).toBeInTheDocument();
    expect(within(card).getByText('Jamais connecté.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Tous' }));
    await waitFor(() =>
      expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
        '/api/v1/users?limit=200',
      ),
    );

    cleanup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(
      await screen.findByText(
        'Écran en ligne seulement : reconnectez-vous pour gérer les comptes.',
      ),
    ).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: false,
      reason: 'HTTP_ERROR',
      status: 403,
      body: {},
    } as never);
    renderScreen();
    expect(
      await screen.findByText('Lecture des comptes refusée : droit insuffisant.'),
    ).toBeInTheDocument();
  });
});

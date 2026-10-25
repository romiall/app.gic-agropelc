import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { UsersScreen } from './UsersScreen.js';
import {
  alreadyAssigned,
  assignmentProblem,
  canSendStatus,
  createBody,
  EMPTY_NEW_USER,
  grantPayload,
  matchesSearch,
  newUserProblem,
  phoneOf,
  refusalOf,
  resetPath,
  resetProblem,
  revokePayload,
  scopeTypesFor,
  sortByName,
  statusActionsFor,
  statusCommand,
  statusReasonRequired,
  usersPath,
  type AssignmentView,
  type RoleView,
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

const SELLER_ROLE = '01900000-0000-7000-8000-0000000004a1';
const ADMIN_ROLE = '01900000-0000-7000-8000-0000000004a2';
const AWA = '01900000-0000-7000-8000-0000000003a1';
const PAUL = '01900000-0000-7000-8000-0000000003a2';
const AWA_ASSIGNMENT = '01900000-0000-7000-8000-0000000005a1';

const ROLES: readonly RoleView[] = [
  {
    id: SELLER_ROLE,
    code: 'VENDEUR_PDV',
    name: 'Vendeur de point de vente',
    description: null,
    allowedScopeTypes: ['SITE'],
    isSystem: true,
  },
  {
    id: ADMIN_ROLE,
    code: 'ADMIN',
    name: 'Administrateur',
    description: null,
    allowedScopeTypes: ['GLOBAL'],
    isSystem: true,
  },
];

const NO_ACTIONS = {
  resetPassword: false,
  suspend: false,
  reactivate: false,
  deactivate: false,
  manageRoles: false,
};

function assignment(overrides: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: AWA_ASSIGNMENT,
    roleId: SELLER_ROLE,
    roleCode: 'VENDEUR_PDV',
    roleName: 'Vendeur PDV',
    scopeType: 'SITE',
    scopeSiteId: IDS.site,
    scopeZoneId: null,
    scopeTeamId: null,
    validFrom: '2026-10-01T08:00:00.000Z',
    validTo: null,
    ...overrides,
  };
}

function account(overrides: Partial<UserView> = {}): UserView {
  return {
    id: AWA,
    fullName: 'Awa Nde',
    phone: '+237690000001',
    email: null,
    status: 'ACTIVE',
    statusChangedAt: null,
    mustChangePassword: false,
    lastLoginAt: '2026-10-13T08:00:00.000Z',
    createdAt: '2026-10-01T08:00:00.000Z',
    roles: ['VENDEUR_PDV'],
    assignments: [assignment()],
    actions: { ...NO_ACTIONS, resetPassword: true },
    ...overrides,
  };
}

interface Served {
  readonly users: readonly UserView[];
  /** Réponse de la réinitialisation. */
  readonly reset?: unknown;
  /** Réponse de la création d'un compte. */
  readonly created?: unknown;
  /** Rôles servis : sans eux, la lecture est refusée comme pour un lecteur sans droit d'affecter. */
  readonly roles?: readonly RoleView[];
}

/** Réponses du serveur : liste des comptes, rôles, création et réinitialisation. */
function serve({
  users,
  reset = { ok: true, data: { status: 'ok' } },
  created = { ok: true, data: { id: PAUL } },
  roles,
}: Served) {
  vi.mocked(authorizedRequest).mockImplementation((_db, path, init) => {
    const target = String(path);
    let response: unknown;
    if (init?.method === 'POST') {
      response = target === '/api/v1/users' ? created : reset;
    } else if (target === '/api/v1/roles') {
      response = roles
        ? { ok: true, data: { roles } }
        : { ok: false, reason: 'HTTP_ERROR', status: 403, body: {} };
    } else if (target.startsWith('/api/v1/users')) {
      response = { ok: true, data: { users, next_cursor: null } };
    } else {
      response = { ok: false, reason: 'HTTP_ERROR', status: 500, body: {} };
    }
    return Promise.resolve(response) as never;
  });
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <UsersScreen />
    </MemoryRouter>,
  );
}

const posts = () =>
  vi
    .mocked(authorizedRequest)
    .mock.calls.filter((call) => (call[2] as RequestInit | undefined)?.method === 'POST');

describe('Utilisateurs : logique (ECR-ADM-04, MP-08 et MP-13)', () => {
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

  it('périmètres proposés : GLOBAL et SITE seulement, selon ce que le rôle permet (AV-326)', () => {
    expect(scopeTypesFor(undefined)).toEqual([]);
    expect(scopeTypesFor({ allowedScopeTypes: ['GLOBAL', 'SITE', 'ZONE', 'TEAM'] })).toEqual([
      'GLOBAL',
      'SITE',
    ]);
    expect(scopeTypesFor({ allowedScopeTypes: ['ZONE', 'TEAM'] })).toEqual([]);
    expect(scopeTypesFor({ allowedScopeTypes: ['SITE'] })).toEqual(['SITE']);
  });

  it('choix d’une affectation : rôle, périmètre permis, site ; doublon ; charges des commandes', () => {
    const seller = { roleId: SELLER_ROLE, scopeType: 'SITE', siteId: IDS.site } as const;
    expect(assignmentProblem({ ...seller, roleId: '' }, ROLES)).toBe('ROLE');
    expect(assignmentProblem({ ...seller, scopeType: 'GLOBAL' }, ROLES)).toBe('SCOPE');
    expect(assignmentProblem({ ...seller, siteId: '' }, ROLES)).toBe('SITE');
    expect(assignmentProblem(seller, ROLES)).toBeNull();
    expect(
      assignmentProblem({ roleId: ADMIN_ROLE, scopeType: 'GLOBAL', siteId: '' }, ROLES),
    ).toBeNull();

    expect(alreadyAssigned(account(), seller)).toBe(true);
    expect(alreadyAssigned(account(), { ...seller, siteId: 'autre-site' })).toBe(false);
    expect(
      alreadyAssigned(account(), { roleId: ADMIN_ROLE, scopeType: 'GLOBAL', siteId: '' }),
    ).toBe(false);

    expect(grantPayload(AWA, seller)).toEqual({
      userId: AWA,
      roleId: SELLER_ROLE,
      scopeType: 'SITE',
      scopeSiteId: IDS.site,
    });
    expect(
      grantPayload(AWA, { roleId: ADMIN_ROLE, scopeType: 'GLOBAL', siteId: 'ignoré' }),
    ).toEqual({ userId: AWA, roleId: ADMIN_ROLE, scopeType: 'GLOBAL' });
    expect(revokePayload('  Changement de poste ')).toEqual({ reason: 'Changement de poste' });
  });

  it('état d’un compte : actions selon le serveur, motif exigé pour suspendre et désactiver', () => {
    expect(statusActionsFor(account())).toEqual([]);
    expect(
      statusActionsFor(
        account({ actions: { ...NO_ACTIONS, suspend: true, deactivate: true, reactivate: true } }),
      ),
    ).toEqual(['SUSPEND', 'REACTIVATE', 'DEACTIVATE']);
    expect(statusReasonRequired('SUSPEND')).toBe(true);
    expect(statusReasonRequired('DEACTIVATE')).toBe(true);
    expect(statusReasonRequired('REACTIVATE')).toBe(false);
    expect(canSendStatus('SUSPEND', '   ')).toBe(false);
    expect(canSendStatus('SUSPEND', 'Départ en congé')).toBe(true);
    expect(canSendStatus('REACTIVATE', '')).toBe(true);
    expect(canSendStatus('SUSPEND', 'x'.repeat(501))).toBe(false);
    expect(statusCommand('SUSPEND', ' Congé ')).toEqual({
      commandType: 'identity.user.suspend',
      payload: { reason: 'Congé' },
    });
    expect(statusCommand('DEACTIVATE', 'Départ')).toEqual({
      commandType: 'identity.user.deactivate',
      payload: { reason: 'Départ' },
    });
    expect(statusCommand('REACTIVATE', 'ignoré')).toEqual({
      commandType: 'identity.user.reactivate',
      payload: {},
    });
  });

  it('création d’un compte : téléphone normalisé, défauts de saisie dans l’ordre, corps de la requête', () => {
    expect(phoneOf('699 34 83 71')).toBe('+237699348371');
    expect(phoneOf('+237 699 34 83 71')).toBe('+237699348371');
    expect(phoneOf('0033 6 12 34 56 78')).toBe('+33612345678');
    expect(phoneOf('')).toBeNull();
    expect(phoneOf('abc')).toBeNull();
    expect(phoneOf('12')).toBeNull();

    const base = {
      ...EMPTY_NEW_USER,
      fullName: ' Paul Essomba ',
      phone: '699 34 83 71',
      password: 'provisoire-1',
      confirmation: 'provisoire-1',
    };
    expect(newUserProblem({ ...base, fullName: '  ' }, ROLES)).toBe('NAME');
    expect(newUserProblem({ ...base, phone: '12' }, ROLES)).toBe('PHONE');
    expect(newUserProblem({ ...base, email: 'pas-un-courriel' }, ROLES)).toBe('EMAIL');
    expect(newUserProblem({ ...base, roleId: SELLER_ROLE, scopeType: 'SITE' }, ROLES)).toBe('SITE');
    expect(newUserProblem({ ...base, password: 'court', confirmation: 'court' }, ROLES)).toBe(
      'TOO_SHORT',
    );
    expect(newUserProblem({ ...base, confirmation: 'autre-chose' }, ROLES)).toBe('MISMATCH');
    expect(newUserProblem(base, ROLES)).toBeNull();
    expect(
      newUserProblem({ ...base, roleId: SELLER_ROLE, scopeType: 'SITE', siteId: IDS.site }, ROLES),
    ).toBeNull();

    expect(createBody(base)).toEqual({
      full_name: 'Paul Essomba',
      phone: '+237699348371',
      password: 'provisoire-1',
    });
    expect(
      createBody({
        ...base,
        email: ' paul@gic.cm ',
        roleId: SELLER_ROLE,
        scopeType: 'SITE',
        siteId: IDS.site,
      }),
    ).toEqual({
      full_name: 'Paul Essomba',
      phone: '+237699348371',
      email: 'paul@gic.cm',
      password: 'provisoire-1',
      role: { role_id: SELLER_ROLE, scope_type: 'SITE', scope_site_id: IDS.site },
    });
  });
});

describe('Utilisateurs (ECR-ADM-04, MP-08 et MP-13)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('réinitialise un mot de passe : route hors file d’envoi, saisie vidée, message de suite', async () => {
    serve({
      users: [
        account(),
        account({
          id: PAUL,
          fullName: 'Paul Essomba',
          actions: NO_ACTIONS,
          roles: [],
          assignments: [],
        }),
      ],
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
      '/api/v1/users?limit=200&status=ACTIVE',
    );
    expect(within(card).getByText(/Vendeur de point de vente/)).toBeInTheDocument();
    expect(await within(card).findByText(/site PDV Yaoundé/)).toBeInTheDocument();
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

    expect(await screen.findByText(/Mot de passe de Awa Nde réinitialisé/)).toBeInTheDocument();
    const post = posts()[0]!;
    expect(post[1]).toBe(`/api/v1/users/${AWA}/reset-password`);
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
    serve({
      users: [account()],
      reset: {
        ok: false,
        reason: 'HTTP_ERROR',
        status: 409,
        body: {
          error: { code: 'USER_DEACTIVATED', message: 'Compte désactivé : réactivez-le avant.' },
        },
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
    serve({ users: [account()], reset: { ok: false, reason: 'OFFLINE' } });
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
    serve({ users: [account({ mustChangePassword: true, lastLoginAt: null })] });
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

  it('sans droit d’affecter (rôles refusés) : ni « Nouveau compte » ni ajout ou retrait de rôle', async () => {
    serve({ users: [account()] });
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(screen.queryByRole('button', { name: 'Nouveau compte' })).toBeNull();
    expect(within(card).queryByRole('button', { name: /Ajouter un rôle/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: /Retirer/ })).toBeNull();
  });

  it('crée un compte avec son premier rôle : route hors file d’envoi, mot de passe jamais gardé, liste relue', async () => {
    serve({ users: [account()], roles: ROLES });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(await screen.findByRole('button', { name: 'Nouveau compte' }));
    const form = screen.getByRole('group', { name: 'Nouveau compte' });
    const submit = within(form).getByRole('button', { name: 'Créer le compte' });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText('Nom complet'), 'Paul Essomba');
    await user.type(within(form).getByLabelText('Téléphone'), '699 34 83 71');
    await user.selectOptions(within(form).getByLabelText('Rôle'), SELLER_ROLE);
    // Vendeur de PDV : seul le site est permis ; le site doit être choisi.
    expect(within(form).getByLabelText('Périmètre')).toHaveValue('SITE');
    expect(submit).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('Site'), IDS.site);
    await user.type(within(form).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    await user.type(
      within(form).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText(/Compte de Paul Essomba créé/)).toBeInTheDocument();
    const post = posts()[0]!;
    expect(post[1]).toBe('/api/v1/users');
    expect(JSON.parse((post[2] as RequestInit).body as string)).toEqual({
      full_name: 'Paul Essomba',
      phone: '+237699348371',
      password: 'provisoire-1',
      role: { role_id: SELLER_ROLE, scope_type: 'SITE', scope_site_id: IDS.site },
    });
    // Hors du journal des commandes : rien dans la file d'envoi ; formulaire refermé.
    expect(await getDb().outbox.count()).toBe(0);
    expect(screen.queryByRole('group', { name: 'Nouveau compte' })).toBeNull();
    await waitFor(() =>
      expect(
        vi
          .mocked(authorizedRequest)
          .mock.calls.filter((call) => call[1] === '/api/v1/users?limit=200&status=ACTIVE').length,
      ).toBeGreaterThan(1),
    );
  });

  it('création refusée (numéro déjà utilisé) ou sans réseau : message, formulaire gardé, mot de passe vidé', async () => {
    serve({
      users: [account()],
      roles: ROLES,
      created: {
        ok: false,
        reason: 'HTTP_ERROR',
        status: 409,
        body: {
          error: {
            code: 'PHONE_ALREADY_USED',
            message: 'Ce numéro est déjà utilisé par un compte actif.',
          },
        },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(await screen.findByRole('button', { name: 'Nouveau compte' }));
    const form = screen.getByRole('group', { name: 'Nouveau compte' });
    await user.type(within(form).getByLabelText('Nom complet'), 'Paul Essomba');
    await user.type(within(form).getByLabelText('Téléphone'), '690000001');
    await user.type(within(form).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    await user.type(
      within(form).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    await user.click(within(form).getByRole('button', { name: 'Créer le compte' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Création refusée : Ce numéro est déjà utilisé par un compte actif.',
    );
    // Le formulaire reste ouvert pour corriger ; le mot de passe n'est plus dans les champs.
    expect(within(form).getByLabelText('Nom complet')).toHaveValue('Paul Essomba');
    expect(within(form).getByLabelText('Mot de passe provisoire')).toHaveValue('');
    expect(await getDb().outbox.count()).toBe(0);
  });

  it('numéro invalide signalé avant l’envoi ; aucune requête', async () => {
    serve({ users: [account()], roles: ROLES });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(await screen.findByRole('button', { name: 'Nouveau compte' }));
    const form = screen.getByRole('group', { name: 'Nouveau compte' });
    await user.type(within(form).getByLabelText('Nom complet'), 'Paul Essomba');
    await user.type(within(form).getByLabelText('Téléphone'), '12');
    await user.type(within(form).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    await user.type(
      within(form).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    expect(within(form).getByText(/Numéro de téléphone invalide/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Créer le compte' })).toBeDisabled();
    expect(posts()).toHaveLength(0);
  });

  it('suspend un compte : motif exigé, commande identity.user.suspend sur le compte, liste relue', async () => {
    serve({
      users: [account({ actions: { ...NO_ACTIONS, suspend: true, deactivate: true } })],
      roles: ROLES,
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(within(card).getByRole('button', { name: 'Suspendre le compte de Awa Nde' }));
    const confirm = within(card).getByRole('button', {
      name: 'Confirmer la suspension de Awa Nde',
    });
    expect(confirm).toBeDisabled();
    await user.type(within(card).getByLabelText('Motif (obligatoire)'), 'Congé de deux mois');
    await user.click(confirm);

    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'identity.user.suspend',
      aggregate_type: 'USER',
      aggregate_id: AWA,
      payload: { reason: 'Congé de deux mois' },
    });
    // Le formulaire est refermé.
    expect(within(card).queryByLabelText('Motif (obligatoire)')).toBeNull();
  });

  it('réactive un compte suspendu : aucun motif exigé', async () => {
    serve({
      users: [account({ status: 'SUSPENDED', actions: { ...NO_ACTIONS, reactivate: true } })],
      roles: ROLES,
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Suspendus' }));
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(within(card).getByRole('button', { name: 'Réactiver le compte de Awa Nde' }));
    expect(within(card).queryByLabelText('Motif (obligatoire)')).toBeNull();
    await user.click(
      within(card).getByRole('button', { name: 'Confirmer la réactivation de Awa Nde' }),
    );
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'identity.user.reactivate',
      aggregate_type: 'USER',
      aggregate_id: AWA,
      payload: {},
    });
  });

  it('ajoute un rôle : périmètre permis par le rôle, doublon refusé, commande identity.role_assignment.grant', async () => {
    serve({
      users: [account({ actions: { ...NO_ACTIONS, manageRoles: true } })],
      roles: ROLES,
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(within(card).getByRole('button', { name: 'Ajouter un rôle à Awa Nde' }));
    const confirm = within(card).getByRole('button', { name: 'Ajouter le rôle à Awa Nde' });
    expect(confirm).toBeDisabled();
    await user.selectOptions(within(card).getByLabelText('Rôle'), SELLER_ROLE);
    await user.selectOptions(within(card).getByLabelText('Site'), IDS.site);
    // Même rôle, même site que l'affectation existante.
    expect(
      within(card).getByText('Ce compte a déjà ce rôle sur ce périmètre.'),
    ).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.selectOptions(within(card).getByLabelText('Rôle'), ADMIN_ROLE);
    expect(within(card).getByLabelText('Périmètre')).toHaveValue('GLOBAL');
    expect(within(card).queryByLabelText('Site')).toBeNull();
    await user.click(confirm);

    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'identity.role_assignment.grant',
      aggregate_type: 'ROLE_ASSIGNMENT',
      payload: { userId: AWA, roleId: ADMIN_ROLE, scopeType: 'GLOBAL' },
    });
    expect(command!.aggregate_id).not.toBe(AWA_ASSIGNMENT);
  });

  it('retire un rôle : motif exigé, commande identity.role_assignment.revoke sur l’affectation', async () => {
    serve({
      users: [account({ actions: { ...NO_ACTIONS, manageRoles: true } })],
      roles: ROLES,
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(
      within(card).getByRole('button', {
        name: 'Retirer le rôle Vendeur de point de vente de Awa Nde',
      }),
    );
    const confirm = within(card).getByRole('button', { name: 'Confirmer le retrait du rôle' });
    expect(confirm).toBeDisabled();
    await user.type(within(card).getByLabelText('Motif (obligatoire)'), 'Changement de poste');
    await user.click(confirm);

    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'identity.role_assignment.revoke',
      aggregate_type: 'ROLE_ASSIGNMENT',
      aggregate_id: AWA_ASSIGNMENT,
      payload: { reason: 'Changement de poste' },
    });
  });
});

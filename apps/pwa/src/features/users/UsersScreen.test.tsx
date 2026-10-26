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
  failureOutcome,
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
  revokeRoles: false,
};

const FIELD_ROLE = '01900000-0000-7000-8000-0000000004a3';
/** Rôle de zone seulement : aucun périmètre que l'écran sait proposer (AV-326). */
const ZONE_ONLY: RoleView = {
  id: FIELD_ROLE,
  code: 'COMMERCIAL_TERRAIN',
  name: 'Commercial terrain',
  description: null,
  allowedScopeTypes: ['ZONE'],
  isSystem: true,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Le texte figure-t-il quelque part dans la base locale ou les stockages web ? */
async function storedAnywhere(text: string): Promise<boolean> {
  const db = getDb();
  for (const table of db.tables) {
    if (JSON.stringify(await table.toArray()).includes(text)) return true;
  }
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)!;
      if (key.includes(text) || (storage.getItem(key) ?? '').includes(text)) return true;
    }
  }
  return false;
}

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
  /** Réponse de la lecture des rôles, à la place de `roles` (panne passagère). */
  readonly rolesResponse?: unknown;
}

/** Réponses du serveur : liste des comptes, rôles, création et réinitialisation. */
function serve({
  users,
  reset = { ok: true, data: { status: 'ok' } },
  created = { ok: true, data: { id: PAUL } },
  roles,
  rolesResponse,
}: Served) {
  vi.mocked(authorizedRequest).mockImplementation((_db, path, init) => {
    const target = String(path);
    let response: unknown;
    if (init?.method === 'POST') {
      response = target === '/api/v1/users' ? created : reset;
    } else if (target === '/api/v1/roles') {
      response = rolesResponse
        ? rolesResponse
        : roles
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
    // Sans réponse, l'issue est inconnue ; une session à rouvrir n'a rien envoyé.
    expect(failureOutcome({ reason: 'OFFLINE' })).toEqual({ kind: 'OFFLINE' });
    expect(failureOutcome({ reason: 'SESSION_INVALID' })).toEqual({ kind: 'SESSION' });
    expect(failureOutcome({ reason: 'SESSION_CHANGED' })).toEqual({ kind: 'SESSION' });
    expect(
      failureOutcome({ reason: 'HTTP_ERROR', body: { error: { code: 'X', message: 'Non.' } } }),
    ).toEqual({ kind: 'REFUSED', code: 'X', message: 'Non.' });
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
    // Plusieurs défauts : le premier dans l'ordre nom, téléphone, courriel, rôle, mot de passe.
    expect(newUserProblem({ ...base, fullName: '', phone: '12', email: 'x' }, ROLES)).toBe('NAME');
    expect(newUserProblem({ ...base, phone: '12', email: 'x', password: '' }, ROLES)).toBe('PHONE');
    expect(
      newUserProblem({ ...base, email: 'x', roleId: SELLER_ROLE, scopeType: 'SITE' }, ROLES),
    ).toBe('EMAIL');
    expect(
      newUserProblem(
        { ...base, roleId: SELLER_ROLE, scopeType: 'SITE', password: 'court', confirmation: '' },
        ROLES,
      ),
    ).toBe('SITE');
    // Indicatif du paramètre : un numéro local prend l'indicatif choisi.
    expect(createBody({ ...base, phone: '6 12 34 56 78' }, '33')).toMatchObject({
      phone: '+33612345678',
    });
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Réponse non reçue : la réinitialisation a peut-être été faite.',
    );
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

  it('rôles refusés : ni « Nouveau compte » ni ajout de rôle, sans message ; le retrait ne dépend que du serveur', async () => {
    serve({
      users: [account({ actions: { ...NO_ACTIONS, manageRoles: true, revokeRoles: true } })],
    });
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await waitFor(() =>
      expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
        '/api/v1/roles',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Nouveau compte' })).toBeNull();
    expect(within(card).queryByRole('button', { name: /Ajouter un rôle/ })).toBeNull();
    expect(within(card).getByRole('button', { name: /Retirer le rôle/ })).toBeInTheDocument();
    expect(screen.queryByText(/Lecture des rôles impossible/)).toBeNull();

    // Sans le droit côté serveur, aucun retrait non plus.
    cleanup();
    serve({ users: [account()] });
    renderScreen();
    const plain = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(within(plain).queryByRole('button', { name: /Retirer/ })).toBeNull();
  });

  it('lecture des rôles en panne passagère : message et relecture, distincte d’un refus', async () => {
    serve({ users: [account()], rolesResponse: { ok: false, reason: 'OFFLINE' } });
    const user = userEvent.setup();
    renderScreen();
    const alert = await screen.findByText(/Lecture des rôles impossible/);
    expect(screen.queryByRole('button', { name: 'Nouveau compte' })).toBeNull();
    serve({ users: [account()], roles: ROLES });
    await user.click(within(alert.closest('div')!).getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('button', { name: 'Nouveau compte' })).toBeInTheDocument();
    expect(screen.queryByText(/Lecture des rôles impossible/)).toBeNull();
  });

  it('lecteur sans droit d’affecter : codes des rôles sans périmètre', async () => {
    serve({ users: [account({ assignments: [], roles: ['VENDEUR_PDV', 'ADMIN'] })] });
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(within(card).getByText(/Vendeur de point de vente, Administrateur/)).toBeInTheDocument();
    expect(within(card).queryByText(/aucun rôle/)).toBeNull();
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
    // Hors du journal des commandes : rien dans la file d'envoi ni ailleurs ; formulaire refermé.
    expect(await getDb().outbox.count()).toBe(0);
    expect(await storedAnywhere('provisoire-1')).toBe(false);
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
    expect(await storedAnywhere('provisoire-1')).toBe(false);
  });

  it.each([
    {
      title: 'réponse non reçue',
      created: { ok: false, reason: 'OFFLINE' },
      message: 'Réponse non reçue : le compte a peut-être été créé. Vérifiez la liste',
      reread: true,
    },
    {
      title: 'session à rouvrir',
      created: { ok: false, reason: 'SESSION_INVALID' },
      message: 'Session expirée : reconnectez-vous',
      reread: false,
    },
    {
      title: 'échec local imprévu',
      created: new Error('base locale indisponible'),
      message: 'Réponse non reçue',
      reread: true,
    },
  ])(
    'création sans réponse ($title) : message juste, formulaire gardé, mot de passe vidé',
    async ({ created, message, reread }) => {
      serve({ users: [account()], roles: ROLES });
      if (created instanceof Error) {
        const served = vi.mocked(authorizedRequest).getMockImplementation()!;
        vi.mocked(authorizedRequest).mockImplementation((db, path, init) =>
          init?.method === 'POST' ? Promise.reject(created) : served(db, path, init),
        );
      } else {
        serve({ users: [account()], roles: ROLES, created });
      }
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
      const reads = () =>
        vi
          .mocked(authorizedRequest)
          .mock.calls.filter((call) => call[1] === '/api/v1/users?limit=200&status=ACTIVE').length;
      const readsBefore = reads();
      await user.click(within(form).getByRole('button', { name: 'Créer le compte' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(within(form).getByLabelText('Nom complet')).toHaveValue('Paul Essomba');
      expect(within(form).getByLabelText('Mot de passe provisoire')).toHaveValue('');
      // Plus d'envoi en cours : le bouton n'est pas figé sur « Création… ».
      expect(within(form).queryByText('Création…')).toBeNull();
      expect(within(form).getByRole('button', { name: 'Annuler' })).toBeEnabled();
      expect(await storedAnywhere('provisoire-1')).toBe(false);
      if (reread) await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
      else {
        // Laisser passer les rendus suivants avant d'affirmer qu'aucune relecture n'est partie.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(reads()).toBe(readsBefore);
      }
    },
  );

  it('création en cours : « Annuler » désactivé jusqu’à la réponse', async () => {
    serve({ users: [account()], roles: ROLES });
    let answer: (value: unknown) => void = () => undefined;
    const served = vi.mocked(authorizedRequest).getMockImplementation()!;
    vi.mocked(authorizedRequest).mockImplementation((db, path, init) =>
      init?.method === 'POST'
        ? (new Promise((resolve) => {
            answer = resolve;
          }) as never)
        : served(db, path, init),
    );
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(await screen.findByRole('button', { name: 'Nouveau compte' }));
    const form = screen.getByRole('group', { name: 'Nouveau compte' });
    expect(within(form).getByLabelText('Nom complet')).toHaveFocus();
    await user.type(within(form).getByLabelText('Nom complet'), 'Paul Essomba');
    await user.type(within(form).getByLabelText('Téléphone'), '690000001');
    await user.type(within(form).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    await user.type(
      within(form).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    await user.click(within(form).getByRole('button', { name: 'Créer le compte' }));
    expect(within(form).getByRole('button', { name: 'Annuler' })).toBeDisabled();
    // Une action ouverte sur une carte pendant l'envoi ne ferme pas la création en cours.
    await user.click(
      screen.getByRole('button', { name: 'Réinitialiser le mot de passe de Awa Nde' }),
    );
    expect(screen.getByRole('group', { name: 'Nouveau compte' })).toBeInTheDocument();
    answer({ ok: true, data: { id: PAUL } });
    expect(await screen.findByText(/Compte de Paul Essomba créé/)).toBeInTheDocument();
  });

  it('numéro invalide signalé avant l’envoi ; aucune requête', async () => {
    serve({ users: [account()], roles: ROLES });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(await screen.findByRole('button', { name: 'Nouveau compte' }));
    const form = screen.getByRole('group', { name: 'Nouveau compte' });
    await user.type(within(form).getByLabelText('Nom complet'), 'Paul Essomba');
    // Rien n'est signalé sur le téléphone tant qu'il n'est pas commencé.
    expect(within(form).queryByText(/Numéro de téléphone invalide/)).toBeNull();
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

  it('rôle sans périmètre proposable (zone seulement) : alerte unique, création bloquée', async () => {
    serve({ users: [account()], roles: [...ROLES, ZONE_ONLY] });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(await screen.findByRole('button', { name: 'Nouveau compte' }));
    const form = screen.getByRole('group', { name: 'Nouveau compte' });
    await user.type(within(form).getByLabelText('Nom complet'), 'Paul Essomba');
    await user.type(within(form).getByLabelText('Téléphone'), '690000001');
    await user.selectOptions(within(form).getByLabelText('Rôle'), FIELD_ROLE);
    await user.type(within(form).getByLabelText('Mot de passe provisoire'), 'provisoire-1');
    await user.type(
      within(form).getByLabelText('Confirmer le mot de passe provisoire'),
      'provisoire-1',
    );
    expect(within(form).getAllByRole('alert')).toHaveLength(1);
    expect(within(form).getByRole('button', { name: 'Créer le compte' })).toBeDisabled();
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
    // Le formulaire est refermé ; l'envoi est suivi et retient l'opération suivante.
    expect(within(card).queryByLabelText('Motif (obligatoire)')).toBeNull();
    expect(await screen.findByText('Opération en cours d’envoi…')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Désactiver le compte de Awa Nde' }));
    await user.type(within(card).getByLabelText('Motif (obligatoire)'), 'Départ');
    expect(
      within(card).getByRole('button', { name: 'Confirmer la désactivation de Awa Nde' }),
    ).toBeDisabled();

    // Refus du serveur : affiché ; la liste est relue à la réponse.
    const reads = () =>
      vi
        .mocked(authorizedRequest)
        .mock.calls.filter((call) => call[1] === '/api/v1/users?limit=200&status=ACTIVE').length;
    const readsBefore = reads();
    await getDb().outbox.update(command!.command_id, {
      status: 'REJECTED',
      last_error: { code: 'LAST_ADMIN', message_fr: 'Aucun autre ADMIN actif ne resterait.' },
    });
    expect(
      await screen.findByText(/Opération refusée : Aucun autre ADMIN actif/),
    ).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
  });

  it('une commande d’appareil en attente ne retient pas l’écran des comptes', async () => {
    await getDb().outbox.add({
      command_id: '01900000-0000-7000-8000-0000000009d1',
      device_seq: 1,
      command_version: 1,
      command_type: 'identity.device.approve',
      aggregate_type: 'DEVICE',
      aggregate_id: '01900000-0000-7000-8000-0000000009d2',
      author_user_id: '01900000-0000-7000-8000-000000000001',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-25T08:00:00.000Z',
      client_created_at: '2026-10-25T08:00:00.000Z',
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: {},
      status: 'PENDING',
      attempts: 0,
      last_error: null,
    } as never);
    serve({
      users: [account({ actions: { ...NO_ACTIONS, suspend: true } })],
      roles: ROLES,
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    expect(screen.queryByText('Opération en cours d’envoi…')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Suspendre le compte de Awa Nde' }));
    await user.type(within(card).getByLabelText('Motif (obligatoire)'), 'Congé');
    expect(
      within(card).getByRole('button', { name: 'Confirmer la suspension de Awa Nde' }),
    ).toBeEnabled();
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
    });
    expect(command!.payload).toEqual({});
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
    });
    // Le site choisi pour l'essai précédent ne part pas avec un rôle global.
    expect(command!.payload).toEqual({ userId: AWA, roleId: ADMIN_ROLE, scopeType: 'GLOBAL' });
    expect(command!.aggregate_id).toMatch(UUID);
    expect(command!.aggregate_id).not.toBe(AWA_ASSIGNMENT);
  });

  it('retire un rôle : affectation nommée, motif exigé et propre à chaque affectation, commande identity.role_assignment.revoke', async () => {
    const OTHER_ASSIGNMENT = '01900000-0000-7000-8000-0000000005a2';
    serve({
      users: [
        account({
          assignments: [
            assignment(),
            assignment({
              id: OTHER_ASSIGNMENT,
              roleId: ADMIN_ROLE,
              roleCode: 'ADMIN',
              roleName: 'Administrateur',
              scopeType: 'GLOBAL',
              scopeSiteId: null,
            }),
          ],
          actions: { ...NO_ACTIONS, manageRoles: true, revokeRoles: true },
        }),
      ],
      roles: ROLES,
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Awa Nde' });
    await user.click(
      within(card).getByRole('button', { name: 'Retirer le rôle Administrateur de Awa Nde' }),
    );
    await user.type(within(card).getByLabelText('Motif (obligatoire)'), 'Motif pour l’admin');
    await user.click(
      within(card).getByRole('button', {
        name: 'Retirer le rôle Vendeur de point de vente de Awa Nde',
      }),
    );
    // Autre affectation : formulaire nommé pour elle, motif vide.
    expect(within(card).getByLabelText('Motif (obligatoire)')).toHaveValue('');
    expect(
      within(card).getByRole('group', { name: /Retrait du rôle Vendeur de point de vente · site/ }),
    ).toBeInTheDocument();
    const confirm = within(card).getByRole('button', {
      name: /Confirmer le retrait du rôle Vendeur de point de vente · site/,
    });
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

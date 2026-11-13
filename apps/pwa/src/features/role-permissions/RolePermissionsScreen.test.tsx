import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { seedSalesFixtures } from '../sales/fixtures.js';
import { RolePermissionsScreen } from './RolePermissionsScreen.js';
import {
  groupedPermissions,
  permissionCommand,
  reasonValid,
  scopeChoices,
  type RolePermissionEntry,
  type RolePermissionsResponse,
} from './role-permissions.js';

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

const ROLE = '01900000-0000-7000-8000-0000000000e1';
const ADMIN_ROLE = '01900000-0000-7000-8000-0000000000e0';

const entry = (overrides: Partial<RolePermissionEntry>): RolePermissionEntry => ({
  code: 'finance.expense.approve',
  module: 'finance',
  description: 'Valider une dépense',
  supportedScopes: ['OWN', 'SITE', 'ZONE', 'ALL'],
  isApproval: true,
  isSensitive: false,
  maxScope: null,
  editable: true,
  grantableScopes: ['OWN', 'SITE', 'ZONE', 'ALL'],
  canRevoke: false,
  ...overrides,
});

const DETAIL: RolePermissionsResponse = {
  role: {
    id: ROLE,
    code: 'RESP_FERME',
    name: 'Responsable de ferme',
    description: null,
    isSystem: true,
    editable: true,
  },
  permissions: [
    entry({}),
    entry({
      code: 'inventory.loss.approve',
      module: 'inventory',
      description: 'Valider une perte',
      maxScope: 'SITE',
      canRevoke: true,
    }),
    entry({
      code: 'identity.role.manage',
      module: 'identity',
      description: 'Créer et modifier les rôles et leurs permissions',
      isApproval: false,
      supportedScopes: ['ALL'],
      editable: false,
      grantableScopes: [],
    }),
  ],
  changes: [
    {
      id: '01900000-0000-7000-8000-0000000000f1',
      permissionCode: 'inventory.loss.approve',
      changeType: 'GRANT',
      scopeBefore: null,
      scopeAfter: 'SITE',
      reason: 'Le responsable de ferme valide les pertes de sa ferme.',
      changedByUserId: '01900000-0000-7000-8000-000000000001',
      changedByName: 'Awa Admin',
      changedAt: '2026-11-11T08:00:00.000Z',
    },
  ],
};

function serve() {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (target === '/api/v1/roles/editable') {
      return ok({
        roles: [
          { ...DETAIL.role },
          {
            id: ADMIN_ROLE,
            code: 'ADMIN',
            name: 'Administrateur',
            description: null,
            isSystem: true,
            editable: false,
          },
        ],
      });
    }
    if (target === `/api/v1/roles/${ROLE}/permissions`) return ok(DETAIL);
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

const lastCommand = async () =>
  (await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray())[0];

describe('Droits des rôles (ECR-ADM-09, Q28, ADR-072)', () => {
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

  it('droits groupés par module, portée accordée, droit protégé non modifiable, historique du rôle', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RolePermissionsScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Rôle'), ROLE);
    const loss = await screen.findByRole('listitem', { name: 'inventory.loss.approve' });
    expect(within(loss).getByText('Son site')).toBeInTheDocument();
    const manage = screen.getByRole('listitem', { name: 'identity.role.manage' });
    expect(within(manage).getByText('Ne se modifie pas ici')).toBeInTheDocument();
    expect(within(manage).queryByRole('button', { name: 'Modifier' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'finance' })).toBeInTheDocument();
    expect(screen.getByText(/1 droits accordés sur 3/)).toBeInTheDocument();
    expect(
      screen.getByText(/Le responsable de ferme valide les pertes de sa ferme/),
    ).toBeInTheDocument();
  });

  it('changement : motif obligatoire, puis une commande identity.role_permission.set en file', async () => {
    serve();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RolePermissionsScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Rôle'), ROLE);
    const loss = await screen.findByRole('listitem', { name: 'inventory.loss.approve' });
    await user.click(within(loss).getByRole('button', { name: 'Modifier' }));
    await user.selectOptions(within(loss).getByLabelText('Nouvelle portée'), 'REVOKE');
    await user.click(within(loss).getByRole('button', { name: 'Enregistrer le changement' }));
    expect(within(loss).getByText('Le motif est obligatoire.')).toBeInTheDocument();
    expect(await getDb().outbox.count()).toBe(0);
    await user.type(within(loss).getByLabelText('Motif du changement'), 'Revue des droits.');
    await user.click(within(loss).getByRole('button', { name: 'Enregistrer le changement' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'identity.role_permission.set',
      aggregate_type: 'ROLE',
      aggregate_id: ROLE,
      payload: {
        permissionCode: 'inventory.loss.approve',
        maxScope: null,
        reason: 'Revue des droits.',
      },
    });
  });

  it('rôle Administrateur figé : bandeau d’information', async () => {
    vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
      const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
      if (String(path) === '/api/v1/roles/editable') {
        return ok({
          roles: [
            {
              id: ADMIN_ROLE,
              code: 'ADMIN',
              name: 'Administrateur',
              description: null,
              isSystem: true,
              editable: false,
            },
          ],
        });
      }
      return ok({
        ...DETAIL,
        role: { ...DETAIL.role, id: ADMIN_ROLE, code: 'ADMIN', editable: false },
      });
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RolePermissionsScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Rôle'), ADMIN_ROLE);
    expect(
      await screen.findByText('Les droits de ce rôle ne se modifient pas dans l’application.'),
    ).toBeInTheDocument();
  });
});

describe('Droits des rôles : logique pure', () => {
  it('choix proposés : portées données par le serveur sauf l’actuelle, puis le retrait s’il est permis', () => {
    expect(scopeChoices(entry({ maxScope: 'SITE', canRevoke: true }))).toEqual([
      'OWN',
      'ZONE',
      'ALL',
      'REVOKE',
    ]);
    expect(scopeChoices(entry({ grantableScopes: [], canRevoke: false }))).toEqual([]);
  });

  it('filtre texte et « accordés seulement », groupes par module', () => {
    const groups = groupedPermissions(DETAIL.permissions, { text: 'perte', grantedOnly: false });
    expect(groups.map((group) => group.module)).toEqual(['inventory']);
    expect(groupedPermissions(DETAIL.permissions, { text: '', grantedOnly: true })).toHaveLength(1);
  });

  it('commande : retrait en portée nulle, motif nettoyé ; motif vide refusé', () => {
    expect(permissionCommand(ROLE, 'x', 'REVOKE', '  motif  ')).toEqual({
      commandType: 'identity.role_permission.set',
      aggregateType: 'ROLE',
      aggregateId: ROLE,
      payload: { permissionCode: 'x', maxScope: null, reason: 'motif' },
    });
    expect(permissionCommand(ROLE, 'x', 'SITE', 'm').payload).toMatchObject({ maxScope: 'SITE' });
    expect(reasonValid('   ')).toBe(false);
    expect(reasonValid('ok')).toBe(true);
  });
});

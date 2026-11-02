import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { authorizedRequest } from '../../sync/api-client.js';
import { AuditScreen } from './AuditScreen.js';
import type { AuditEntryView } from './audit.js';

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

const AWA = '01900000-0000-7000-8000-0000000000a1';
const BRICE = '01900000-0000-7000-8000-0000000000a2';

const entry = (seq: number, overrides: Partial<AuditEntryView> = {}): AuditEntryView => ({
  seq,
  id: `01900000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
  occurredAt: '2026-10-20T08:00:00.000Z',
  recordedAt: '2026-10-20T08:00:05.000Z',
  actorUserId: AWA,
  actorName: 'Awa Admin',
  actorRoles: ['ADMIN'],
  deviceId: null,
  action: 'sales.sale.record',
  entityType: 'SALE',
  entityId: '01900000-0000-7000-8000-0000000000e1',
  before: null,
  after: null,
  reason: null,
  result: 'SUCCESS',
  commandId: null,
  ...overrides,
});

interface Served {
  readonly denied?: boolean;
  readonly entries?: readonly AuditEntryView[];
  readonly older?: readonly AuditEntryView[];
  readonly entityTypes?: readonly string[];
}

function serve({
  denied = false,
  entries = [entry(3), entry(2), entry(1)],
  older = [],
  entityTypes = ['EXPENSE', 'SALE'],
}: Served = {}) {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (target.startsWith('/api/v1/audit?')) {
      if (denied) {
        return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 403, body: {} }) as never;
      }
      return ok({ entries: target.includes('before_seq=') ? older : entries });
    }
    if (target === '/api/v1/audit/entity-types') return ok({ entity_types: entityTypes });
    if (target.startsWith('/api/v1/users')) {
      return ok({
        users: [
          { id: AWA, fullName: 'Awa Admin' },
          { id: BRICE, fullName: 'Brice Finance' },
        ],
      });
    }
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

const auditCalls = () =>
  vi
    .mocked(authorizedRequest)
    .mock.calls.map((call) => String(call[1]))
    .filter((path) => path.startsWith('/api/v1/audit?'));

function renderScreen() {
  return render(
    <MemoryRouter>
      <AuditScreen />
    </MemoryRouter>,
  );
}

describe('Journal d’audit (ECR-AUD-01)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
  });

  it('liste la plus récente d’abord : acteur nommé, action, entité, résultat, champs modifiés, détail', async () => {
    serve({
      entries: [
        entry(3, {
          before: { status: 'DRAFT', total: 100 },
          after: { status: 'CONFIRMED', total: 100 },
          reason: 'Contrôle mensuel',
          commandId: '01900000-0000-7000-8000-0000000000c3',
        }),
        entry(2, {
          actorName: null,
          result: 'DENIED',
          action: 'finance.expense.approve',
          entityType: 'EXPENSE',
        }),
        entry(1),
      ],
    });
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Entrée 3 du journal' });
    expect(within(card).getByText('Awa Admin')).toBeInTheDocument();
    expect(within(card).getByText('Réussi')).toBeInTheDocument();
    expect(within(card).getByText('sales.sale.record')).toBeInTheDocument();
    expect(within(card).getByText(/^Vente · …000000e1 · /)).toBeInTheDocument();
    expect(within(card).getByText('Champs modifiés : status')).toBeInTheDocument();
    expect(within(card).getByText('Contrôle mensuel')).toBeInTheDocument();
    expect(within(card).getByText('…000000c3')).toBeInTheDocument();
    expect(within(card).getByText(/"status": "DRAFT"/)).toBeInTheDocument();
    expect(within(card).getByText(/"status": "CONFIRMED"/)).toBeInTheDocument();

    const refused = screen.getByRole('listitem', { name: 'Entrée 2 du journal' });
    expect(within(refused).getByText('Acteur inconnu')).toBeInTheDocument();
    expect(within(refused).getByText('Refusé')).toBeInTheDocument();
    expect(within(refused).getByText(/^Dépense · /)).toBeInTheDocument();
    // Sans avant, après, motif, appareil ni commande : pas de détail à déplier.
    expect(within(refused).queryByText('Voir le détail')).toBeNull();

    expect(
      screen.getByText('3 entrées affichées, de la plus récente à la plus ancienne.'),
    ).toBeInTheDocument();
    expect(auditCalls()).toEqual(['/api/v1/audit?limit=50']);
  });

  it('recherche : les filtres renseignés partent dans le chemin, « Réinitialiser » les efface', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Entrée 3 du journal' });

    fireEvent.change(screen.getByLabelText(/^Du/), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(/^Au/), { target: { value: '2026-10-31' } });
    await user.selectOptions(await screen.findByLabelText(/^Type d’entité/), 'SALE');
    await user.selectOptions(await screen.findByLabelText(/^Qui/), BRICE);
    await user.type(screen.getByLabelText(/^Action/), 'sales.sale.record');
    await user.click(screen.getByRole('button', { name: 'Rechercher' }));

    await waitFor(() => expect(auditCalls()).toHaveLength(2));
    const query = new URLSearchParams(auditCalls()[1]!.split('?')[1]);
    expect(Object.fromEntries(query)).toEqual({
      limit: '50',
      entity_type: 'SALE',
      actor_user_id: BRICE,
      action: 'sales.sale.record',
      from: '2026-10-01',
      to: '2026-10-31',
    });

    await user.click(screen.getByRole('button', { name: 'Réinitialiser' }));
    await waitFor(() => expect(auditCalls()).toHaveLength(3));
    expect(auditCalls()[2]).toBe('/api/v1/audit?limit=50');
    expect(screen.getByLabelText(/^Action/)).toHaveValue('');
    expect(screen.getByLabelText(/^Du/)).toHaveValue('');
  });

  it('période à l’envers ou identifiant d’entité invalide : message, recherche désactivée, rien envoyé', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Entrée 3 du journal' });
    const search = screen.getByRole('button', { name: 'Rechercher' });

    fireEvent.change(screen.getByLabelText(/^Du/), { target: { value: '2026-10-02' } });
    fireEvent.change(screen.getByLabelText(/^Au/), { target: { value: '2026-10-01' } });
    expect(screen.getByText('La date de fin précède celle de début.')).toBeInTheDocument();
    expect(search).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Au/), { target: { value: '2026-10-02' } });
    expect(search).toBeEnabled();

    await user.type(screen.getByLabelText(/^Identifiant de l’entité/), 'abc');
    expect(screen.getByText(/Un identifiant d’entité est un UUID/)).toBeInTheDocument();
    expect(search).toBeDisabled();
    expect(auditCalls()).toHaveLength(1);
  });

  it('page pleine : « Voir les entrées plus anciennes » lit la suite avant la plus ancienne entrée vue', async () => {
    serve({
      entries: Array.from({ length: 50 }, (_, index) => entry(100 - index)),
      older: [entry(50), entry(49)],
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText('50 entrées affichées, de la plus récente à la plus ancienne.');

    await user.click(screen.getByRole('button', { name: 'Voir les entrées plus anciennes' }));
    expect(
      await screen.findByText('52 entrées affichées, de la plus récente à la plus ancienne.'),
    ).toBeInTheDocument();
    expect(auditCalls()).toContain('/api/v1/audit?limit=50&before_seq=51');
    expect(screen.getByRole('listitem', { name: 'Entrée 49 du journal' })).toBeInTheDocument();
    // La dernière page est incomplète : plus rien à demander.
    expect(screen.queryByRole('button', { name: 'Voir les entrées plus anciennes' })).toBeNull();
  });

  it('page incomplète : pas de bouton pour les entrées plus anciennes', async () => {
    serve();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Entrée 3 du journal' });
    expect(screen.queryByRole('button', { name: 'Voir les entrées plus anciennes' })).toBeNull();
  });

  it('journal vide pour cette recherche : un état vide', async () => {
    serve({ entries: [] });
    renderScreen();
    expect(
      await screen.findByText('Aucune entrée ne correspond à cette recherche.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('refus de lecture : un message, aucune entrée', async () => {
    serve({ denied: true });
    renderScreen();
    expect(await screen.findByText('Lecture refusée : droit insuffisant.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('les types d’entité proposés sont ceux du serveur, triés par libellé (Finance : entités financières)', async () => {
    serve({ entityTypes: ['SUPPLIER_PAYMENT', 'EXPENSE'] });
    renderScreen();
    await screen.findByRole('option', { name: 'Dépense' });
    const select = screen.getByLabelText(/^Type d’entité/);
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Tous', 'Dépense', 'Paiement fournisseur']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { seedSalesFixtures } from '../sales/fixtures.js';
import { SettingsScreen } from './SettingsScreen.js';
import type { PolicyView, SettingVersionView } from './settings.js';

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

const SITE = '01900000-0000-7000-8000-0000000000b1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const version = (overrides: Partial<SettingVersionView>): SettingVersionView => ({
  id: '01900000-0000-7000-8000-0000000000a0',
  key: 'finance.expense_approval_threshold_xaf',
  value: 50000,
  scopeType: 'GLOBAL',
  scopeId: null,
  validFrom: '2026-10-01T08:00:00.000Z',
  isClientVisible: true,
  reason: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  createdByName: 'Awa Admin',
  ...overrides,
});

const SETTINGS: readonly SettingVersionView[] = [
  version({ id: '01900000-0000-7000-8000-0000000000a1' }),
  version({
    id: '01900000-0000-7000-8000-0000000000a2',
    key: 'inventory.high_loss_alert_xaf',
    value: 50000,
    isClientVisible: false,
  }),
  version({
    id: '01900000-0000-7000-8000-0000000000a3',
    key: 'production.daily_entry_working_days',
    value: ['1', '2', '3', '4', '5', '6', '7'],
    isClientVisible: false,
  }),
  version({
    id: '01900000-0000-7000-8000-0000000000a4',
    key: 'sync.stale_hours',
    value: 24,
    isClientVisible: false,
  }),
  version({
    id: '01900000-0000-7000-8000-0000000000a5',
    key: 'finance.supplier_advance_allowed',
    value: true,
    isClientVisible: false,
  }),
  version({
    id: '01900000-0000-7000-8000-0000000000a6',
    key: 'finance.expense_photo_threshold_xaf',
    value: 20000,
  }),
  version({
    id: '01900000-0000-7000-8000-0000000000a7',
    key: 'finance.expense_photo_threshold_xaf',
    value: 30000,
    scopeType: 'ZONE',
    scopeId: '01900000-0000-7000-8000-000000000e01',
  }),
];

const POLICY: PolicyView = {
  id: '01900000-0000-7000-8000-0000000000c1',
  code: 'EXPENSE_DEFAULT',
  version: 2,
  operationType: 'EXPENSE',
  condition: { category: 'TRANSPORT' },
  requiresPhoto: false,
  requiresComment: false,
  requiresApproval: true,
  approverPermission: 'finance.expense.approve',
  approverScope: 'ALL',
  status: 'ACTIVE',
  validFrom: '2026-10-01T08:00:00.000Z',
  validTo: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  createdByName: 'Awa Admin',
};

const PERMISSIONS = [
  { code: 'finance.expense.approve', description: 'Valider une dépense' },
  { code: 'sales.sale_cancel.approve', description: 'Valider une annulation de vente' },
];

function serve({ denied = false }: { denied?: boolean } = {}) {
  vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
    const target = String(path);
    const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
    if (denied) {
      return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 403, body: {} }) as never;
    }
    if (target === '/api/v1/organization/settings/current') return ok({ settings: SETTINGS });
    if (target.startsWith('/api/v1/organization/settings?key=')) {
      return ok({
        history: [
          version({
            value: 60000,
            reason: 'Revue annuelle',
            validFrom: '2026-10-20T08:00:00.000Z',
          }),
          version({ value: 50000 }),
        ],
      });
    }
    if (target === '/api/v1/sites') {
      return ok({ sites: [{ id: SITE, code: 'PDV1', name: 'Point de vente Akwa' }] });
    }
    if (target.startsWith('/api/v1/attachment-archives/catalog')) {
      return ok({
        granularity: 'QUARTER',
        settings: {
          minAgeDays: 30,
          volumeMaxMb: 512,
          defaultGranularity: 'QUARTER',
          retentionYears: 5,
        },
        server: { files: 0, bytes: 0 },
        periods: [],
      });
    }
    if (target === '/api/v1/attachment-archives') return ok({ archives: [] });
    if (target === '/api/v1/approvals/policies') {
      return ok({ policies: [POLICY], approver_permissions: PERMISSIONS });
    }
    if (target.startsWith('/api/v1/approvals/policies?code=')) {
      return ok({
        policies: [
          POLICY,
          { ...POLICY, id: '01900000-0000-7000-8000-0000000000c2', version: 1, status: 'RETIRED' },
        ],
        approver_permissions: PERMISSIONS,
      });
    }
    return Promise.resolve({ ok: false, reason: 'HTTP_ERROR', status: 500, body: {} }) as never;
  });
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <SettingsScreen />
    </MemoryRouter>,
  );
}

const lastCommand = async () =>
  (await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray())[0];

describe('Paramètres et politiques (ECR-ADM-07)', () => {
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

  it('paramètres groupés par domaine, valeur et unité du catalogue ; réglages techniques repliés', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Seuil de validation d’une dépense' });
    expect(within(card).getByText('50 000 XAF')).toBeInTheDocument();
    expect(within(card).getByText('finance.expense_approval_threshold_xaf')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Caisse et finance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stock' })).toBeInTheDocument();
    expect(screen.getByText('lun. mar. mer. jeu. ven. sam. dim.')).toBeInTheDocument();
    expect(screen.getByText('Oui')).toBeInTheDocument();
    // Technique : absent tant que l'interrupteur est éteint.
    expect(screen.queryByRole('heading', { name: 'Réglages techniques' })).toBeNull();
    await user.click(screen.getByRole('switch', { name: /Afficher les réglages techniques/ }));
    expect(
      await screen.findByRole('listitem', {
        name: 'Heures sans contact avant qu’un appareil soit en retard',
      }),
    ).toBeInTheDocument();
  });

  it('refus de lecture : un message, aucune carte', async () => {
    serve({ denied: true });
    renderScreen();
    expect(await screen.findByText('Lecture refusée : droit insuffisant.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('recherche par libellé ou par clé', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Seuil de validation d’une dépense' });
    await user.type(screen.getByLabelText('Rechercher un paramètre'), 'inventory.high');
    expect(
      screen.queryByRole('listitem', { name: 'Seuil de validation d’une dépense' }),
    ).toBeNull();
    expect(
      screen.getByRole('listitem', { name: 'Seuil d’alerte d’une perte importante' }),
    ).toBeInTheDocument();
  });

  it('modifie un seuil : nouvelle version globale, visibilité sur les appareils reportée, motif', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Seuil de validation d’une dépense' });
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    const save = within(card).getByRole('button', { name: 'Enregistrer la nouvelle valeur' });
    // Aucun changement : rien à enregistrer.
    expect(save).toBeDisabled();
    expect(
      within(card).getByText('La valeur n’a pas changé : rien à enregistrer.'),
    ).toBeInTheDocument();
    const field = within(card).getByLabelText('Seuil de validation d’une dépense');
    await user.clear(field);
    await user.type(field, '-5');
    expect(save).toBeDisabled();
    expect(within(card).getByText('La valeur est trop petite.')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '60000');
    await user.type(within(card).getByLabelText(/^Motif du changement/), 'Revue annuelle');
    await user.click(save);

    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const command = await lastCommand();
    expect(command).toMatchObject({
      command_type: 'organization.setting.set',
      aggregate_type: 'SETTING',
      payload: {
        key: 'finance.expense_approval_threshold_xaf',
        value: 60000,
        scopeType: 'GLOBAL',
        isClientVisible: true,
        reason: 'Revue annuelle',
      },
      captured_offline: false,
    });
    expect(command!.aggregate_id).toMatch(UUID);
    expect(await screen.findByText('Changement en cours d’envoi…')).toBeInTheDocument();
  });

  it('réglage lu par site : surcharge pour un site, la valeur globale reste', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', {
      name: 'Seuil d’alerte d’une perte importante',
    });
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    await user.selectOptions(within(card).getByLabelText('S’applique à'), SITE);
    const field = within(card).getByLabelText('Seuil d’alerte d’une perte importante');
    await user.clear(field);
    await user.type(field, '80000');
    await user.click(within(card).getByRole('button', { name: 'Enregistrer la nouvelle valeur' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'organization.setting.set',
      payload: {
        key: 'inventory.high_loss_alert_xaf',
        value: 80000,
        scopeType: 'SITE',
        scopeId: SITE,
        isClientVisible: false,
      },
    });
  });

  it('une valeur propre à une zone n’est pas présentée comme un site', async () => {
    serve();
    renderScreen();
    const card = await screen.findByRole('listitem', {
      name: 'Seuil d’un justificatif photo pour une dépense',
    });
    expect(within(card).getByText('Zone …00000e01')).toBeInTheDocument();
    expect(within(card).queryByText(/^Site :/)).toBeNull();
  });

  it('un réglage sans valeur par site ne propose pas de portée', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Seuil de validation d’une dépense' });
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    expect(within(card).queryByLabelText('S’applique à')).toBeNull();
  });

  it('jours de la semaine : cocher et décocher, valeur ordonnée', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Jours de saisie attendue d’un lot' });
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    await user.click(within(card).getByRole('checkbox', { name: 'Dimanche' }));
    await user.click(within(card).getByRole('button', { name: 'Enregistrer la nouvelle valeur' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect((await lastCommand())!.payload).toMatchObject({
      key: 'production.daily_entry_working_days',
      value: ['1', '2', '3', '4', '5', '6'],
    });
  });

  it('historique d’une clé : versions, auteur et motif lus sur le serveur', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Seuil de validation d’une dépense' });
    await user.click(within(card).getByRole('button', { name: 'Historique' }));
    expect(await within(card).findByText('60 000 XAF')).toBeInTheDocument();
    expect(within(card).getAllByText(/Awa Admin/)).toHaveLength(2);
    expect(within(card).getByText('Motif : Revue annuelle')).toBeInTheDocument();
    expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
      '/api/v1/organization/settings?key=finance.expense_approval_threshold_xaf',
    );
  });

  it('politiques : liste des politiques en vigueur, révision avec condition reprise et nouvelle version', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Politiques de contrôle' }));
    const card = await screen.findByRole('listitem', { name: 'Politique EXPENSE_DEFAULT' });
    expect(
      within(card).getByText(/validation par « finance.expense.approve »/),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    const save = within(card).getByRole('button', { name: 'Enregistrer la nouvelle version' });
    expect(save).toBeDisabled();
    await user.click(within(card).getByRole('switch', { name: 'Photo exigée' }));
    await user.selectOptions(within(card).getByLabelText('Portée de l’approbateur'), 'SITE');
    await user.click(save);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const command = await lastCommand();
    expect(command).toMatchObject({
      command_type: 'approvals.policy.set',
      aggregate_type: 'CONTROL_POLICY',
      payload: {
        code: 'EXPENSE_DEFAULT',
        operationType: 'EXPENSE',
        condition: { category: 'TRANSPORT' },
        requiresPhoto: true,
        requiresComment: false,
        requiresApproval: true,
        approverPermission: 'finance.expense.approve',
        approverScope: 'SITE',
      },
    });
    expect(command!.aggregate_id).toMatch(UUID);
    expect(command!.aggregate_id).not.toBe(POLICY.id);
  });

  it('politique : retirer la validation prévient, et n’envoie plus d’approbateur', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Politiques de contrôle' }));
    const card = await screen.findByRole('listitem', { name: 'Politique EXPENSE_DEFAULT' });
    await user.click(within(card).getByRole('button', { name: 'Modifier' }));
    await user.click(
      within(card).getByRole('switch', { name: 'Validation d’un responsable exigée' }),
    );
    expect(
      within(card).getByText(/ne demandera plus l’accord d’un responsable/),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Enregistrer la nouvelle version' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const payload = (await lastCommand())!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ code: 'EXPENSE_DEFAULT', requiresApproval: false });
    expect(payload).not.toHaveProperty('approverPermission');
  });

  it('l’onglet « Archive des photos » n’est proposé qu’à l’administrateur', async () => {
    const userId = '01900000-0000-7000-8000-000000000001';
    const saved = (roles: string[]) => ({
      user_id: userId,
      roles,
      sections: [],
      saved_at: '2026-11-08T08:00:00.000Z',
    });
    serve();
    const user = userEvent.setup();

    await getDb().navigation.put(saved(['DIRECTION']));
    const direction = renderScreen();
    await screen.findByRole('tab', { name: 'Politiques de contrôle' });
    expect(screen.queryByRole('tab', { name: 'Archive des photos' })).toBeNull();
    direction.unmount();

    await getDb().navigation.put(saved(['ADMIN']));
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Archive des photos' }));
    expect(await screen.findByText('À quoi sert l’archive des photos ?')).toBeInTheDocument();
    expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
      '/api/v1/attachment-archives',
    );
    await getDb().navigation.delete(userId);
  });

  it('politique : historique des versions', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('tab', { name: 'Politiques de contrôle' }));
    const card = await screen.findByRole('listitem', { name: 'Politique EXPENSE_DEFAULT' });
    await user.click(within(card).getByRole('button', { name: 'Historique' }));
    expect(await within(card).findByText('retirée', { exact: false })).toBeInTheDocument();
    expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
      '/api/v1/approvals/policies?code=EXPENSE_DEFAULT',
    );
  });
});

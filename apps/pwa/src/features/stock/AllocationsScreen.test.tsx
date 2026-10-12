import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { resetConnectivityForTests } from '../../platform/connectivity.js';
import { DEVICE_ID, IDS, seedSalesFixtures } from '../sales/fixtures.js';
import type { AllocationItem, AllocationsPage } from './allocations.js';
import { AllocationsScreen } from './AllocationsScreen.js';

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

const request = vi.mocked(authorizedRequest);
const VENDOR = '01900000-0000-7000-8000-0000000000e1';
const TABLET = '01900000-0000-7000-8000-0000000000e2';
const ACTIVE = '01900000-0000-7000-8000-0000000000e3';
const CLOSED = '01900000-0000-7000-8000-0000000000e4';

function item(overrides: Partial<AllocationItem>): AllocationItem {
  return {
    id: ACTIVE,
    locationId: IDS.pos,
    productId: IDS.eggs,
    lotId: null,
    holderUserId: VENDOR,
    holderDeviceId: TABLET,
    quantityGranted: 60,
    quantityRemaining: 45,
    validUntil: '2026-10-10T22:59:59.999Z',
    status: 'ACTIVE',
    revocationPending: false,
    version: 3,
    ...overrides,
  };
}

const page: AllocationsPage = {
  location_id: IDS.pos,
  allocations: [
    item({}),
    // Ancien quota clos d'un autre détenteur : connu, proposé à l'octroi.
    item({
      id: CLOSED,
      holderUserId: '01900000-0000-7000-8000-0000000000e5',
      holderDeviceId: '01900000-0000-7000-8000-0000000000e6',
      status: 'CLOSED',
      quantityRemaining: 0,
    }),
  ],
  active_totals: [{ productId: IDS.eggs, activeCount: 1, quantityRemaining: 45 }],
  next_cursor: null,
};

function renderScreen() {
  return render(
    <MemoryRouter>
      <AllocationsScreen />
    </MemoryRouter>,
  );
}

async function outboxOf(type: string) {
  return (await getDb().outbox.toArray()).filter((command) => command.command_type === type);
}

describe('Quotas des téléphones (ECR-STK-06)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    request.mockReset();
    request.mockResolvedValue({ ok: true, data: page });
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('octroi à un détenteur connu : non alloué indicatif, durée facultative, charge utile', async () => {
    const user = userEvent.setup();
    renderScreen();
    const active = await screen.findByRole('region', { name: 'Quotas actifs' });
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/allocations?location_id=${IDS.pos}`,
      { method: 'GET' },
    );
    expect(
      within(active).getByText(/Reste 45 U sur 60 U accordé\(s\), jusqu’au/),
    ).toBeInTheDocument();
    const holder = screen.getByLabelText('Détenteur');
    // Détenteurs proposés : vous sur ce téléphone, le détenteur actif et l'ancien détenteur.
    expect(within(holder).getAllByRole('option')).toHaveLength(4);
    expect(
      within(holder).getByRole('option', { name: 'utilisateur vous, appareil ce téléphone' }),
    ).toBeInTheDocument();
    await user.selectOptions(holder, `${VENDOR}|${TABLET}`);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    // 300 œufs au comptoir, 45 déjà alloués.
    expect(screen.getByText(/Non alloué \(indicatif\) : 255 U/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Accorder le quota' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Quantité accordée (U)'), '30');
    await user.type(screen.getByLabelText('Durée en heures (facultatif)'), '800');
    expect(screen.getByText('Durée invalide : de 1 à 744 heures.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText('Durée en heures (facultatif)'));
    await user.type(screen.getByLabelText('Durée en heures (facultatif)'), '12');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('Octroi en cours d’envoi…')).toBeInTheDocument();
    const [grant] = await outboxOf('inventory.allocation.grant');
    expect(grant).toMatchObject({
      aggregate_type: 'STOCK_ALLOCATION',
      captured_offline: false,
      payload: {
        holderUserId: VENDOR,
        holderDeviceId: TABLET,
        locationId: IDS.pos,
        productId: IDS.eggs,
        quantityBase: 30,
        validityHours: 12,
      },
    });
    // Une opération en attente bloque la suivante, même une fois la liste relue.
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      within(active).getByRole('button', { name: 'Augmenter le quota Œufs de table' }),
    ).toBeDisabled();
  });

  it('augmentation avec la version attendue ; révocation avec un motif', async () => {
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    await user.click(
      await screen.findByRole('button', { name: 'Augmenter le quota Œufs de table' }),
    );
    const add = screen.getByRole('button', { name: 'Augmenter' });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('Quantité à ajouter (U)'), '15');
    await user.click(add);
    await screen.findByText('Augmentation en cours d’envoi…');
    const [increase] = await outboxOf('inventory.allocation.increase');
    expect(increase).toMatchObject({
      aggregate_id: ACTIVE,
      base_version: 3,
      payload: { quantityBase: 15 },
    });
    unmount();

    await getDb().outbox.clear();
    renderScreen();
    await user.click(
      await screen.findByRole('button', { name: 'Révoquer le quota Œufs de table' }),
    );
    const confirm = screen.getByRole('button', { name: 'Confirmer la révocation' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Motif de la révocation'), '  Téléphone perdu  ');
    await user.click(confirm);
    await screen.findByText('Révocation en cours d’envoi…');
    const [revoke] = await outboxOf('inventory.allocation.revoke');
    expect(revoke).toMatchObject({ aggregate_id: ACTIVE, payload: { reason: 'Téléphone perdu' } });
  });

  it('appareil signalé : révocation seule ; hors ligne : gestion en ligne seulement', async () => {
    request.mockResolvedValue({
      ok: true,
      data: { ...page, allocations: [item({ revocationPending: true })] },
    });
    const { unmount } = renderScreen();
    expect(
      await screen.findByText(/Appareil signalé : le quota ne se consomme plus/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Augmenter le quota Œufs de table' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Révoquer le quota Œufs de table' })).toBeEnabled();
    unmount();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByText(/Gestion des quotas en ligne seulement/)).toBeInTheDocument();
    expect(DEVICE_ID).toBeDefined();
  });
});

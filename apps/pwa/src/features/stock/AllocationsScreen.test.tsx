import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { resetConnectivityForTests } from '../../platform/connectivity.js';
import { DEVICE_ID, IDS, seedSalesFixtures, stockRow } from '../sales/fixtures.js';
import type { AllocationItem, AllocationsPage } from './allocations.js';
import { AllocationsScreen } from './AllocationsScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
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
const OLD_USER = '01900000-0000-7000-8000-0000000000e5';
const OLD_DEVICE = '01900000-0000-7000-8000-0000000000e6';
/** Détenteur affiché du quota actif des tests. */
const VENDOR_LABEL = 'utilisateur …00e1, appareil …00e2';

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
      holderUserId: OLD_USER,
      holderDeviceId: OLD_DEVICE,
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

const ACTIVE_PATH = `/api/v1/allocations?location_id=${IDS.pos}&limit=200&status=ACTIVE`;
const HISTORY_PATH = `/api/v1/allocations?location_id=${IDS.pos}&limit=200`;

/** Réponses par chemin : quotas actifs (première page et suites) et historique. */
function serve(routes: Readonly<Record<string, AllocationsPage>>) {
  request.mockImplementation((_db, path) => {
    const data = routes[path];
    return Promise.resolve(
      data
        ? { ok: true, data }
        : { ok: false, reason: 'HTTP_ERROR', status: 500, message: 'route absente' },
    ) as ReturnType<typeof authorizedRequest>;
  });
}

/** Appareil en lecture seule le temps de `run` : dernière synchronisation complète ancienne (AV-009). */
async function whileReadOnly(run: () => Promise<void>) {
  const db = getDb();
  const saved = await db.syncMeta.get('device');
  await db.syncMeta.put({
    key: 'device',
    device_id: saved?.device_id ?? '01900000-0000-7000-8000-0000000000d0',
    clock_skew_ms: null,
    last_sync_at: '2026-09-01T00:00:00.000Z',
  });
  try {
    await run();
  } finally {
    if (saved) await db.syncMeta.put(saved);
    else await db.syncMeta.delete('device');
  }
}

async function rememberRoles(roles: readonly string[]) {
  await getDb().navigation.put({
    user_id: IDS.user,
    roles: [...roles],
    sections: [],
    saved_at: '2026-10-10T08:00:00.000Z',
  });
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
    await getDb().navigation.clear();
  });

  it('octroi à un détenteur connu : non alloué indicatif, durée facultative, charge utile', async () => {
    const user = userEvent.setup();
    renderScreen();
    const active = await screen.findByRole('region', { name: 'Quotas actifs' });
    // Quotas actifs lus à part, puis l'historique des détenteurs.
    expect(request).toHaveBeenCalledWith(expect.anything(), ACTIVE_PATH, { method: 'GET' });
    expect(request).toHaveBeenCalledWith(expect.anything(), HISTORY_PATH, { method: 'GET' });
    expect(
      within(active).getByText(/Reste 45 U sur 60 U accordé\(s\), jusqu’au/),
    ).toBeInTheDocument();
    const holder = screen.getByLabelText('Détenteur');
    // Détenteurs proposés : vous sur ce téléphone, le détenteur actif et l'ancien détenteur.
    expect(within(holder).getAllByRole('option')).toHaveLength(4);
    expect(
      within(holder).getByRole('option', { name: 'utilisateur vous, appareil ce téléphone' }),
    ).toBeInTheDocument();
    // Sans produit choisi, la quantité n'a pas d'unité.
    expect(screen.getByLabelText('Quantité accordée')).toBeInTheDocument();
    await user.selectOptions(holder, `${OLD_USER}|${OLD_DEVICE}`);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    // 300 œufs au comptoir, 45 déjà alloués.
    expect(screen.getByText(/Non alloué \(indicatif\) : 255 U/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Accorder le quota' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Quantité accordée (U)'), '30');
    const hours = screen.getByLabelText('Durée en heures (facultatif)');
    await user.type(hours, '800');
    const invalid = screen.getByText('Durée invalide : plus de 0 et au plus 744 heures.');
    expect(hours).toHaveAttribute('aria-describedby', invalid.id);
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
        holderUserId: OLD_USER,
        holderDeviceId: OLD_DEVICE,
        locationId: IDS.pos,
        productId: IDS.eggs,
        quantityBase: 30,
        validityHours: 12,
      },
    });
    // Une opération en attente bloque la suivante, même une fois la liste relue.
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      within(active).getByRole('button', {
        name: `Augmenter le quota Œufs de table (${VENDOR_LABEL})`,
      }),
    ).toBeDisabled();
  });

  it('augmentation avec la version attendue ; révocation avec un motif', async () => {
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    await user.click(
      await screen.findByRole('button', {
        name: `Augmenter le quota Œufs de table (${VENDOR_LABEL})`,
      }),
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
      await screen.findByRole('button', {
        name: `Révoquer le quota Œufs de table (${VENDOR_LABEL})`,
      }),
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
    expect(screen.queryByRole('button', { name: /^Augmenter le quota/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Révoquer le quota Œufs de table (${VENDOR_LABEL})` }),
    ).toBeEnabled();
    // Couple signalé : plus proposé à l'octroi (`ALLOCATION_HOLDER_INVALID`).
    expect(
      within(screen.getByLabelText('Détenteur')).queryByRole('option', { name: VENDOR_LABEL }),
    ).not.toBeInTheDocument();
    unmount();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByText(/Gestion des quotas en ligne seulement/)).toBeInTheDocument();
    expect(DEVICE_ID).toBeDefined();
  });

  it('quotas actifs lus sur toutes leurs pages : un ancien quota actif reste visible', async () => {
    const OLD_ACTIVE = '01900000-0000-7000-8000-0000000000e7';
    serve({
      [ACTIVE_PATH]: { ...page, allocations: [item({})], next_cursor: OLD_ACTIVE },
      [`${ACTIVE_PATH}&cursor=${OLD_ACTIVE}`]: {
        ...page,
        allocations: [
          item({
            id: OLD_ACTIVE,
            holderUserId: OLD_USER,
            holderDeviceId: OLD_DEVICE,
            productId: IDS.chicken,
          }),
        ],
        next_cursor: null,
      },
      [HISTORY_PATH]: { ...page, allocations: [], next_cursor: null },
    });
    renderScreen();
    const active = await screen.findByRole('region', { name: 'Quotas actifs' });
    expect(
      await within(active).findByRole('listitem', {
        name: 'Poulet de chair, utilisateur …00e5, appareil …00e6',
      }),
    ).toBeInTheDocument();
    expect(
      within(active).getByRole('listitem', { name: `Œufs de table, ${VENDOR_LABEL}` }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Liste partielle/)).not.toBeInTheDocument();
  });

  it('au-delà des pages lues : liste annoncée partielle ; détenteurs tirés des plus récents', async () => {
    const routes: Record<string, AllocationsPage> = {};
    for (let index = 0; index < 5; index += 1) {
      const cursor = `01900000-0000-7000-8000-00000000f00${index}`;
      routes[index === 0 ? ACTIVE_PATH : `${ACTIVE_PATH}&cursor=${cursor}`] = {
        ...page,
        allocations: [item({ id: `01900000-0000-7000-8000-00000000f10${index}` })],
        next_cursor: `01900000-0000-7000-8000-00000000f00${index + 1}`,
      };
      if (index < 2) {
        routes[index === 0 ? HISTORY_PATH : `${HISTORY_PATH}&cursor=${cursor}`] = {
          ...page,
          next_cursor: `01900000-0000-7000-8000-00000000f00${index + 1}`,
        };
      }
    }
    serve(routes);
    renderScreen();
    expect(
      await screen.findByText(/Liste partielle : plus de 5 quotas actifs sur cet emplacement/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Détenteurs tirés des 4 quotas les plus récents/)).toBeInTheDocument();
  });

  it('quota échu encore actif : annoncé, pas d’augmentation, révocation possible', async () => {
    request.mockResolvedValue({
      ok: true,
      data: { ...page, allocations: [item({ validUntil: '2026-10-09T22:59:59.999Z' })] },
    });
    renderScreen();
    expect(await screen.findByText(/Quota échu : il ne se consomme plus/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Augmenter le quota/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Révoquer le quota Œufs de table (${VENDOR_LABEL})` }),
    ).toBeEnabled();
  });

  it('octroi : produit déjà tenu par le détenteur écarté ; sur-allocation montrée à part', async () => {
    request.mockResolvedValue({
      ok: true,
      data: {
        ...page,
        active_totals: [{ productId: IDS.eggs, activeCount: 2, quantityRemaining: 350 }],
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const holder = await screen.findByLabelText('Détenteur');
    await user.selectOptions(holder, `${VENDOR}|${TABLET}`);
    const held = within(screen.getByLabelText('Produit')).getByRole('option', {
      name: 'Œufs de table (quota actif de ce détenteur : augmentez-le ou révoquez-le)',
    });
    expect(held).toBeDisabled();
    await user.selectOptions(holder, `${OLD_USER}|${OLD_DEVICE}`);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    // 300 physiques, 350 de restes actifs : non alloué nul, dépassement à part.
    expect(screen.getByText(/Non alloué \(indicatif\) : 0 U/)).toBeInTheDocument();
    expect(screen.getByText('Quotas au-delà du stock : 50 U.')).toBeInTheDocument();
  });

  it('détenteurs : vous-même seulement si votre rôle libère un quota ; emplacement inactif écarté', async () => {
    await rememberRoles(['MAGASINIER']);
    const db = getDb();
    const own = await db.projections.get(`location:LOCATION:${IDS.pos}`);
    const OLD_STORE = '01900000-0000-7000-8000-0000000000a3';
    await db.projections.bulkPut([
      {
        ...own!,
        key: `location:LOCATION:${OLD_STORE}`,
        entity_id: OLD_STORE,
        // Premier par ordre alphabétique, désactivé avec un solde nul.
        data: {
          ...(own!.data as object),
          id: OLD_STORE,
          name: 'Ancien comptoir',
          status: 'INACTIVE',
        },
      },
      stockRow(OLD_STORE, IDS.eggs, '0.000'),
    ]);
    renderScreen();
    expect(await screen.findByText('Comptoir Yaoundé')).toBeInTheDocument();
    expect(screen.queryByLabelText('Emplacement')).not.toBeInTheDocument();
    const holder = await screen.findByLabelText('Détenteur');
    expect(
      within(holder).queryByRole('option', { name: 'utilisateur vous, appareil ce téléphone' }),
    ).not.toBeInTheDocument();
    expect(within(holder).getAllByRole('option')).toHaveLength(3);
  });

  it('lecture seule (AV-009) : augmentation refusée et annoncée, rien n’est enregistré', async () => {
    await whileReadOnly(async () => {
      const user = userEvent.setup();
      renderScreen();
      await user.click(
        await screen.findByRole('button', {
          name: `Augmenter le quota Œufs de table (${VENDOR_LABEL})`,
        }),
      );
      await user.type(screen.getByLabelText('Quantité à ajouter (U)'), '15');
      await user.click(screen.getByRole('button', { name: 'Augmenter' }));
      expect(
        await screen.findByText(
          /Lecture seule : aucune synchronisation depuis plus longtemps que l’autonomie permise\. Rien n’a été enregistré/,
        ),
      ).toBeInTheDocument();
      expect(await outboxOf('inventory.allocation.increase')).toEqual([]);
    });
  });

  it('deux détenteurs du même produit : boutons nommés par leur détenteur', async () => {
    request.mockResolvedValue({
      ok: true,
      data: {
        ...page,
        allocations: [
          item({}),
          item({
            id: '01900000-0000-7000-8000-0000000000e8',
            holderUserId: OLD_USER,
            holderDeviceId: OLD_DEVICE,
          }),
        ],
      },
    });
    renderScreen();
    expect(
      await screen.findByRole('button', {
        name: `Révoquer le quota Œufs de table (${VENDOR_LABEL})`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Révoquer le quota Œufs de table (utilisateur …00e5, appareil …00e6)',
      }),
    ).toBeInTheDocument();
  });

  it('retour sur l’écran avec une opération en attente : annoncée, puis liste relue à sa réponse', async () => {
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    await user.click(
      await screen.findByRole('button', {
        name: `Augmenter le quota Œufs de table (${VENDOR_LABEL})`,
      }),
    );
    await user.type(screen.getByLabelText('Quantité à ajouter (U)'), '15');
    await user.click(screen.getByRole('button', { name: 'Augmenter' }));
    await screen.findByText('Augmentation en cours d’envoi…');
    unmount();

    renderScreen();
    expect(await screen.findByText('Augmentation en cours d’envoi…')).toBeInTheDocument();
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(2));
    const before = request.mock.calls.length;
    request.mockResolvedValue({
      ok: true,
      data: {
        ...page,
        allocations: [item({ quantityGranted: 75, quantityRemaining: 60, version: 4 })],
      },
    });
    const [increase] = await outboxOf('inventory.allocation.increase');
    await getDb().outbox.update(increase!.command_id, {
      status: 'SYNCED',
      synced_at: '2026-10-10T09:00:30.000Z',
    });
    expect(await screen.findByText(/Reste 60 U sur 75 U accordé\(s\)/)).toBeInTheDocument();
    expect(request.mock.calls.length).toBeGreaterThan(before);
  });
});

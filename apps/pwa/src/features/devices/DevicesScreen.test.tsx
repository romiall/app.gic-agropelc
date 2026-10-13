import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { DevicesScreen } from './DevicesScreen.js';
import {
  actionsFor,
  canSend,
  commandOf,
  devicesPath,
  matchesSearch,
  type DeviceView,
} from './devices.js';

const THIS_DEVICE = '01900000-0000-7000-8000-0000000000d0';

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

const ALL_ACTIONS = { approve: true, block: true, unblock: true, designate: true };

function device(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: '01900000-0000-7000-8000-0000000000e1',
    shortCode: '7KQ2',
    label: null,
    status: 'PENDING',
    statusReason: null,
    statusChangedAt: '2026-10-13T08:00:00.000Z',
    platform: 'PWA',
    appVersion: null,
    isShared: false,
    designatedSiteId: null,
    enrolledByUserId: '01900000-0000-7000-8000-0000000000aa',
    enrolledByName: 'Awa Nde',
    createdAt: '2026-10-13T08:00:00.000Z',
    lastContactAt: '2026-10-13T08:00:00.000Z',
    stale: false,
    actions: ALL_ACTIONS,
    ...overrides,
  };
}

function serve(devices: readonly DeviceView[]) {
  vi.mocked(authorizedRequest).mockImplementation(
    (_db, path) =>
      Promise.resolve(
        String(path).startsWith('/api/v1/devices')
          ? { ok: true, data: { devices, next_cursor: null } }
          : { ok: false, reason: 'HTTP_ERROR', status: 500, message: `route absente : ${path}` },
      ) as never,
  );
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <DevicesScreen />
    </MemoryRouter>,
  );
}

const lastCommand = async () =>
  (await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray())[0];

describe('Appareils : logique (ECR-ADM-05, SM-DEVICE)', () => {
  it('décisions proposées selon l’état et les droits rendus par le serveur', () => {
    expect(actionsFor(device())).toEqual(['APPROVE', 'REFUSE']);
    expect(actionsFor(device({ actions: { ...ALL_ACTIONS, approve: false } }))).toEqual(['REFUSE']);
    expect(actionsFor(device({ status: 'ACTIVE' }))).toEqual([
      'BLOCK',
      'LOST',
      'RETIRE',
      'DESIGNATE',
    ]);
    expect(actionsFor(device({ status: 'BLOCKED' }))).toEqual(['UNBLOCK', 'RETIRE', 'DESIGNATE']);
    expect(
      actionsFor(device({ status: 'BLOCKED', actions: { ...ALL_ACTIONS, unblock: false } })),
    ).toEqual(['RETIRE', 'DESIGNATE']);
    expect(actionsFor(device({ status: 'LOST' }))).toEqual(['RETIRE']);
    expect(actionsFor(device({ status: 'RETIRED' }))).toEqual([]);
    expect(
      actionsFor(
        device({
          status: 'ACTIVE',
          actions: { approve: false, block: false, unblock: false, designate: false },
        }),
      ),
    ).toEqual([]);
  });

  it('motifs et commandes : obligatoire pour bloquer ou refuser, facultatif pour perdu et retrait', () => {
    expect(canSend('BLOCK', '  ')).toBe(false);
    expect(canSend('REFUSE', 'Inconnu')).toBe(true);
    expect(canSend('LOST', '')).toBe(true);
    expect(canSend('RETIRE', 'x'.repeat(501))).toBe(false);
    expect(commandOf('REFUSE', { reason: ' Inconnu ' })).toEqual({
      commandType: 'identity.device.block',
      payload: { reason: 'Inconnu' },
    });
    expect(commandOf('LOST', { reason: '' })).toEqual({
      commandType: 'identity.device.declare_lost',
      payload: {},
    });
    expect(
      commandOf('DESIGNATE', { reason: '', designation: { isShared: true, siteId: '' } }),
    ).toEqual({
      commandType: 'identity.device.designate',
      payload: { isShared: true, designatedSiteId: null },
    });
    expect(matchesSearch(device(), '7kq')).toBe(true);
    expect(matchesSearch(device(), 'awa')).toBe(true);
    expect(matchesSearch(device(), 'zzz')).toBe(false);
    expect(devicesPath('ALL')).toBe('/api/v1/devices?limit=200');
    expect(devicesPath('PENDING')).toBe('/api/v1/devices?limit=200&status=PENDING');
  });
});

describe('Appareils (ECR-ADM-05)', () => {
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

  it('approuve un appareil en attente : commande identity.device.approve sur l’agrégat de l’appareil', async () => {
    serve([device()]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Appareil 7KQ2' });
    // Chemins seuls : en cas d'échec, afficher la base locale passée en argument épuise la mémoire.
    expect(vi.mocked(authorizedRequest).mock.calls.map((call) => call[1])).toContain(
      '/api/v1/devices?limit=200&status=PENDING',
    );
    expect(within(card).getByText('En attente')).toBeInTheDocument();
    expect(within(card).getByText(/connecté par Awa Nde/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Approuver l’appareil 7KQ2' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'identity.device.approve',
      aggregate_type: 'DEVICE',
      aggregate_id: '01900000-0000-7000-8000-0000000000e1',
      payload: {},
      captured_offline: false,
    });
    expect(await screen.findByText('Décision en cours d’envoi…')).toBeInTheDocument();
  });

  it('refuser exige un motif', async () => {
    serve([device()]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Appareil 7KQ2' });
    await user.click(within(card).getByRole('button', { name: 'Refuser l’appareil 7KQ2' }));
    const confirm = within(card).getByRole('button', { name: 'Confirmer le refus de 7KQ2' });
    expect(confirm).toBeDisabled();
    await user.type(within(card).getByLabelText('Motif (obligatoire)'), 'Téléphone inconnu');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'identity.device.block',
      payload: { reason: 'Téléphone inconnu' },
    });
  });

  it('ce téléphone est signalé, avec un avertissement avant de le bloquer', async () => {
    serve([device({ id: THIS_DEVICE, shortCode: 'AB12', status: 'ACTIVE' })]);
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Actifs' }));
    const mine = await screen.findByRole('listitem', { name: 'Appareil AB12' });
    expect(within(mine).getByText('Ce téléphone')).toBeInTheDocument();
    await user.click(within(mine).getByRole('button', { name: 'Bloquer l’appareil AB12' }));
    expect(within(mine).getByRole('alert')).toHaveTextContent(/il sera déconnecté/);
  });

  it('rattache un appareil à un site, partagé', async () => {
    serve([device({ status: 'ACTIVE' })]);
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Actifs' }));
    const card = await screen.findByRole('listitem', { name: 'Appareil 7KQ2' });
    await user.click(within(card).getByRole('button', { name: 'Rattacher l’appareil 7KQ2' }));
    await user.click(within(card).getByLabelText(/Appareil partagé/));
    await user.selectOptions(within(card).getByLabelText('Site de rattachement'), IDS.site);
    await user.click(
      within(card).getByRole('button', { name: 'Enregistrer le rattachement de 7KQ2' }),
    );
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    expect(await lastCommand()).toMatchObject({
      command_type: 'identity.device.designate',
      payload: { isShared: true, designatedSiteId: IDS.site },
    });
  });

  it('appareil connecté par moi, en attente : pas d’approbation proposée, explication', async () => {
    serve([
      device({
        enrolledByUserId: '01900000-0000-7000-8000-000000000001',
        actions: { ...ALL_ACTIONS, approve: false, unblock: false },
      }),
    ]);
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Appareil 7KQ2' });
    expect(within(card).queryByRole('button', { name: /Approuver/ })).toBeNull();
    expect(within(card).getByText(/son approbation revient à l’Admin/)).toBeInTheDocument();
  });

  it('hors ligne : écran en ligne seulement ; refus de droit annoncé', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(
      await screen.findByText(
        'Écran en ligne seulement : reconnectez-vous pour gérer les appareils.',
      ),
    ).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: false,
      reason: 'HTTP_ERROR',
      status: 403,
      message: 'refusé',
    } as never);
    renderScreen();
    expect(
      await screen.findByText('Lecture des appareils refusée : droit insuffisant.'),
    ).toBeInTheDocument();
  });
});

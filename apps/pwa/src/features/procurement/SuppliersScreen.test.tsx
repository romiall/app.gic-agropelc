import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { seedSalesFixtures } from '../sales/fixtures.js';
import { SuppliersScreen } from './SuppliersScreen.js';
import {
  checkSupplier,
  EMPTY_SUPPLIER,
  formOf,
  updatePayload,
  type SupplierView,
} from './suppliers.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const FEED_CO: SupplierView = {
  id: 'sup-1',
  code: 'PROVENDERIE',
  name: 'Provenderie du Centre',
  suppliedCategories: [],
  contactName: 'M. Ndzi',
  phone: '699000000',
  email: null,
  taxId: null,
  paymentTermsDays: 30,
  status: 'ACTIVE',
};

function renderScreen() {
  return render(
    <MemoryRouter>
      <SuppliersScreen />
    </MemoryRouter>,
  );
}

async function settleLast(expectedCount?: number) {
  if (expectedCount !== undefined) {
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(expectedCount));
  }
  const [command] = await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray();
  if (!command) throw new Error('aucune commande');
  await getDb().outbox.update(command.command_id, {
    status: 'SYNCED',
    synced_at: '2026-10-10T09:00:05.000Z',
  });
}

describe('Fournisseurs (ECR-APP-01)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: true,
      data: { suppliers: [FEED_CO] },
    } as never);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('création avec code unique, puis modification des seuls champs changés et désactivation', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'Provenderie du Centre' });
    expect(authorizedRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/suppliers', {
      method: 'GET',
    });

    await user.click(screen.getByRole('button', { name: 'Nouveau fournisseur' }));
    await user.type(screen.getByLabelText('Code'), 'PROVENDERIE');
    expect(screen.getByText('Ce code est déjà celui d’un autre fournisseur.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Code'));
    await user.type(screen.getByLabelText('Code'), 'COUVOIR-EST');
    await user.type(screen.getByLabelText('Raison sociale'), 'Couvoir de l’Est');
    await user.type(screen.getByLabelText('Adresse électronique (facultatif)'), 'couvoir@exemple');
    expect(screen.getByText('Adresse électronique invalide.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Adresse électronique (facultatif)'), '.cm');
    await user.type(screen.getByLabelText('Délai de paiement en jours (facultatif)'), '15');
    await user.click(screen.getByRole('button', { name: 'Créer le fournisseur' }));
    await screen.findByText(/Opération (en cours d’envoi|enregistrée)/);
    const edit = await screen.findByRole('button', { name: 'Modifier' });
    expect(edit).toBeDisabled();
    await settleLast();
    await waitFor(() => expect(edit).toBeEnabled());

    await user.click(edit);
    const phone = screen.getByLabelText('Téléphone (facultatif)');
    expect(phone).toHaveValue('699000000');
    expect(screen.getByLabelText('Code')).toBeDisabled();
    await user.clear(phone);
    await user.type(phone, '677112233');
    await user.click(screen.getByRole('button', { name: 'Enregistrer les changements' }));
    await settleLast(2);

    const card = await screen.findByRole('listitem', { name: 'Provenderie du Centre' });
    const deactivate = within(card).getByRole('button', { name: 'Désactiver' });
    await waitFor(() => expect(deactivate).toBeEnabled());
    await user.click(deactivate);

    const [created, updated, deactivated] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(created).toMatchObject({
      command_type: 'procurement.supplier.create',
      aggregate_type: 'SUPPLIER',
      payload: {
        code: 'COUVOIR-EST',
        name: 'Couvoir de l’Est',
        email: 'couvoir@exemple.cm',
        paymentTermsDays: 15,
      },
    });
    expect(updated).toMatchObject({
      command_type: 'procurement.supplier.update',
      aggregate_id: 'sup-1',
      payload: { phone: '677112233' },
    });
    expect(Object.keys(updated?.payload as object)).toEqual(['phone']);
    expect(deactivated).toMatchObject({
      command_type: 'procurement.supplier.deactivate',
      aggregate_id: 'sup-1',
      payload: {},
    });
  });

  it('retour sur l’écran avant la réponse : l’opération en attente bloque encore la suivante', async () => {
    const user = userEvent.setup();
    const first = renderScreen();
    const card = await screen.findByRole('listitem', { name: 'Provenderie du Centre' });
    await user.click(within(card).getByRole('button', { name: 'Désactiver' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    first.unmount();

    renderScreen();
    const again = await screen.findByRole('listitem', { name: 'Provenderie du Centre' });
    expect(within(again).getByRole('button', { name: 'Désactiver' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nouveau fournisseur' })).toBeDisabled();
    expect(await screen.findByText(/Opération (en cours d’envoi|enregistrée)/)).toBeInTheDocument();
    const reads = vi.mocked(authorizedRequest).mock.calls.length;
    await settleLast();
    // La réponse reçue relit la liste et rend la main.
    await waitFor(() =>
      expect(vi.mocked(authorizedRequest).mock.calls.length).toBeGreaterThan(reads),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Nouveau fournisseur' })).toBeEnabled(),
    );
  });

  it('hors ligne : écran en ligne seulement, aucune lecture', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/en ligne seulement/);
    expect(authorizedRequest).not.toHaveBeenCalled();
  });
});

describe('Fournisseurs : contrôles et changements', () => {
  it('code, raison sociale, courriel et délai contrôlés ; aucun changement, rien à envoyer', () => {
    expect(checkSupplier(EMPTY_SUPPLIER, { creating: true, takenCodes: new Set() })).toEqual([
      'CODE_REQUIRED',
      'NAME_REQUIRED',
    ]);
    expect(
      checkSupplier(
        { ...EMPTY_SUPPLIER, code: 'A', name: 'A', paymentTermsText: '1,5' },
        { creating: true, takenCodes: new Set() },
      ),
    ).toEqual(['TERMS_INVALID']);
    expect(updatePayload(FEED_CO, formOf(FEED_CO))).toEqual({});
    // Un champ vidé ne s'efface pas (le serveur ne sait pas remettre à vide) : rien n'est envoyé.
    expect(updatePayload(FEED_CO, { ...formOf(FEED_CO), contactName: '' })).toEqual({});
    expect(
      updatePayload(FEED_CO, {
        ...formOf(FEED_CO),
        suppliedCategories: ['ALIMENT'],
        address: 'Mfou',
      }),
    ).toEqual({ suppliedCategories: ['ALIMENT'], address: 'Mfou' });
  });
});

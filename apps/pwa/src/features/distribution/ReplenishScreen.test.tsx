import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, pointOfSaleRow, seedSalesFixtures } from '../sales/fixtures.js';
import { ReplenishScreen } from './ReplenishScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
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

const STORE = '01900000-0000-7000-8000-0000000000c3';
const OTHER_STORE = '01900000-0000-7000-8000-0000000000c4';
const REQUEST = '01900000-0000-7000-8000-0000000000c5';

function projection(dataset: string, type: string, id: string, data: object, scopeId?: string) {
  return {
    key: `${dataset}:${type}:${id}`,
    dataset,
    entity_type: type,
    entity_id: id,
    scope_type: scopeId ? 'LOCATION' : 'GLOBAL',
    scope_id: scopeId ?? null,
    row_version: 1,
    seq: 1,
    data: { id, ...data } as Record<string, unknown>,
  };
}

const store = (id: string, name: string) =>
  projection('location', 'LOCATION', id, {
    site_id: IDS.site,
    code: name,
    name,
    location_type: 'STORE',
    is_virtual: false,
    custody_mode: 'SHARED',
    custodian_user_id: null,
    designated_device_id: null,
    status: 'ACTIVE',
  });

/** Demande du serveur vers le comptoir, encore à expédier. */
const serverRequest = (requestedBy: string) =>
  projection(
    'transfers',
    'STOCK_TRANSFER',
    REQUEST,
    {
      doc_number: 'TRF-2026-000040',
      transfer_kind: 'STANDARD',
      from_location_id: STORE,
      to_location_id: IDS.pos,
      status: 'REQUESTED',
      requested_by: requestedBy,
      dispatched_at: null,
      carrier_name: null,
      notes: null,
      occurred_at: '2026-10-10T07:00:00.000Z',
      version: 1,
      lines: [
        {
          id: '01900000-0000-7000-8000-0000000000c6',
          product_id: IDS.chicken,
          lot_id: null,
          unit_code: 'U',
          requested_qty_base: '12.000',
          dispatched_qty_base: null,
          received_qty_base: null,
        },
      ],
    },
    IDS.pos,
  );

function renderScreen() {
  return render(
    <MemoryRouter>
      <ReplenishScreen />
    </MemoryRouter>,
  );
}

async function outboxOf(type: string) {
  return (await getDb().outbox.toArray()).filter((command) => command.command_type === type);
}

describe('Demande de réapprovisionnement (ECR-DIS-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      store(STORE, 'Magasin central'),
      store(OTHER_STORE, 'Magasin annexe'),
      pointOfSaleRow({ replenishment_source_location_id: STORE }),
      // 300 œufs au comptoir, sous le minimum de 400 ; cible 600.
      projection('stock', 'STOCK_THRESHOLD', 'th-oeuf', {
        location_id: IDS.pos,
        product_id: IDS.eggs,
        min_qty_base: '400',
        target_qty_base: '600',
        is_active: true,
      }),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : suggestion ajoutée à la main, demande enregistrée, puis rappelée et déduite de la suggestion', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText('Pour : Comptoir Yaoundé')).toBeInTheDocument();
    expect(screen.getByText('Depuis : Magasin central')).toBeInTheDocument();
    const suggestions = screen.getByRole('region', { name: 'À réapprovisionner' });
    expect(within(suggestions).getByText('Sous le minimum')).toBeInTheDocument();
    expect(within(suggestions).getByText(/suggéré : 300 U/)).toBeInTheDocument();
    // Jamais de demande sans geste du vendeur (BR-DIS-011).
    expect(await getDb().outbox.count()).toBe(0);
    const submit = screen.getByRole('button', { name: 'Envoyer la demande' });
    expect(submit).toBeDisabled();
    await user.click(
      within(suggestions).getByRole('button', { name: 'Ajouter Œufs de table à la demande' }),
    );
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    expect(within(line).getByLabelText('Produit')).toHaveValue(IDS.eggs);
    expect(within(line).getByLabelText('Quantité')).toHaveValue('300');
    await user.type(screen.getByLabelText('Note pour le magasin (facultatif)'), ' Week-end ');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    expect(
      await screen.findByText(
        'Demande enregistrée sur ce téléphone ; elle sera envoyée au retour du réseau.',
      ),
    ).toBeInTheDocument();
    const [request] = await outboxOf('inventory.transfer.request');
    expect(request).toMatchObject({
      aggregate_type: 'STOCK_TRANSFER',
      captured_offline: true,
      payload: {
        fromLocationId: STORE,
        toLocationId: IDS.pos,
        lines: [{ productId: IDS.eggs, unitCode: 'U', quantityBase: 300 }],
        notes: 'Week-end',
      },
    });

    await user.click(screen.getByRole('button', { name: 'Retour aux demandes' }));
    const pending = await screen.findByRole('listitem', { name: 'Demande en attente du numéro' });
    expect(within(pending).getByText('Œufs de table : 300 U')).toBeInTheDocument();
    expect(
      within(pending).getByText('Enregistrée sur ce téléphone, en attente d’envoi.'),
    ).toBeInTheDocument();
    // La demande en attente comble la suggestion, et elle est rappelée sur une nouvelle ligne.
    expect(
      screen.getByText('Aucun produit sous sa cible connue de ce téléphone.'),
    ).toBeInTheDocument();
    await user.selectOptions(
      within(screen.getByRole('listitem', { name: 'Ligne 1' })).getByLabelText('Produit'),
      IDS.eggs,
    );
    expect(screen.getByText('Déjà demandé, pas encore expédié : 300 U.')).toBeInTheDocument();
    // Annoncé, pas bloqué (AV-307) : un complément reste possible.
    await user.type(
      within(screen.getByRole('listitem', { name: 'Ligne 1' })).getByLabelText('Quantité'),
      '50',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Envoyer la demande' })).toBeEnabled(),
    );
  });

  it('PDV sans magasin configuré : le vendeur choisit le magasin (AV-306) ; produit en double refusé', async () => {
    await getDb().projections.put(pointOfSaleRow({ replenishment_source_location_id: null }));
    const user = userEvent.setup();
    renderScreen();
    const source = await screen.findByLabelText('Depuis le magasin');
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.chicken);
    await user.type(within(line).getByLabelText('Quantité'), '5');
    const submit = screen.getByRole('button', { name: 'Envoyer la demande' });
    expect(submit).toBeDisabled();
    await user.selectOptions(source, OTHER_STORE);
    await waitFor(() => expect(submit).toBeEnabled());
    // Même produit sur deux lignes : à regrouper.
    await user.click(screen.getByRole('button', { name: /Ajouter une ligne/ }));
    const second = screen.getByRole('listitem', { name: 'Ligne 2' });
    await user.selectOptions(within(second).getByLabelText('Produit'), IDS.chicken);
    await user.type(within(second).getByLabelText('Quantité'), '1');
    expect(
      screen.getAllByText('Produit déjà présent dans la demande : regroupez les quantités.'),
    ).toHaveLength(2);
    expect(submit).toBeDisabled();
    await user.click(within(second).getByRole('button', { name: /Retirer/ }));
    await user.click(submit);
    await screen.findByText('Demande en cours d’envoi…');
    const [request] = await outboxOf('inventory.transfer.request');
    expect(request?.payload).toMatchObject({ fromLocationId: OTHER_STORE, toLocationId: IDS.pos });
  });

  it('demande du serveur : annulée par son demandeur après confirmation, jamais par un autre', async () => {
    await getDb().projections.put(serverRequest('01900000-0000-7000-8000-000000000001'));
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    const card = await screen.findByRole('listitem', { name: 'TRF-2026-000040' });
    expect(within(card).getByText('Poulet de chair : 12 U')).toBeInTheDocument();
    await user.click(
      within(card).getByRole('button', { name: 'Annuler la demande TRF-2026-000040' }),
    );
    expect(await outboxOf('inventory.transfer.cancel')).toHaveLength(0);
    await user.click(
      within(card).getByRole('button', { name: 'Confirmer l’annulation de TRF-2026-000040' }),
    );
    await screen.findByText('Annulation en cours d’envoi…');
    const [cancel] = await outboxOf('inventory.transfer.cancel');
    expect(cancel).toMatchObject({
      aggregate_type: 'STOCK_TRANSFER',
      aggregate_id: REQUEST,
      payload: { transferId: REQUEST },
    });
    unmount();

    await getDb().outbox.clear();
    await getDb().projections.put(serverRequest('01900000-0000-7000-8000-0000000000e9'));
    renderScreen();
    const other = await screen.findByRole('listitem', { name: 'TRF-2026-000040' });
    expect(within(other).queryByRole('button', { name: /Annuler/ })).not.toBeInTheDocument();
  });

  it('magasin configuré pas encore synchronisé : la demande le vise, sans choix proposé', async () => {
    const UNKNOWN_STORE = '01900000-0000-7000-8000-0000000000c7';
    await getDb().projections.put(
      pointOfSaleRow({ replenishment_source_location_id: UNKNOWN_STORE }),
    );
    const user = userEvent.setup();
    renderScreen();
    expect(
      await screen.findByText(
        /magasin configuré du point de vente \(en attente de synchronisation\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Depuis le magasin')).not.toBeInTheDocument();
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.chicken);
    await user.type(within(line).getByLabelText('Quantité'), '4');
    await user.click(screen.getByRole('button', { name: 'Envoyer la demande' }));
    await screen.findByText('Demande en cours d’envoi…');
    const [request] = await outboxOf('inventory.transfer.request');
    expect(request?.payload).toMatchObject({ fromLocationId: UNKNOWN_STORE });
  });

  it('demande acceptée pas encore relue : envoyée, annulable ; une annulation garde la saisie en cours', async () => {
    const user = userEvent.setup();
    renderScreen();
    // Une demande envoyée puis acceptée (pas encore relue du jeu `transfers`).
    const line = await screen.findByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.chicken);
    await user.type(within(line).getByLabelText('Quantité'), '4');
    await user.click(screen.getByRole('button', { name: 'Envoyer la demande' }));
    await screen.findByText('Demande en cours d’envoi…');
    const [request] = await outboxOf('inventory.transfer.request');
    await getDb().outbox.update(request!.command_id, {
      status: 'SYNCED',
      synced_at: '2026-10-10T09:30:00.000Z',
    });
    expect(
      await screen.findByText(
        'Demande envoyée au magasin ; son numéro apparaîtra à la prochaine synchronisation.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retour aux demandes' }));
    const card = await screen.findByRole('listitem', { name: 'Demande en attente du numéro' });
    expect(
      within(card).getByText('Envoyée ; son numéro apparaîtra à la prochaine synchronisation.'),
    ).toBeInTheDocument();
    // Nouvelle demande en cours de saisie, puis annulation de la demande envoyée.
    const draft = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(draft).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(draft).getByLabelText('Quantité'), '12');
    await user.type(screen.getByLabelText('Note pour le magasin (facultatif)'), 'Urgent');
    await user.click(within(card).getByRole('button', { name: /^Annuler la demande/ }));
    await user.click(within(card).getByRole('button', { name: /^Confirmer l’annulation/ }));
    await screen.findByText('Annulation en cours d’envoi…');
    const [cancel] = await outboxOf('inventory.transfer.cancel');
    expect(cancel).toMatchObject({ aggregate_id: request!.aggregate_id });
    await user.click(screen.getByRole('button', { name: 'Retour aux demandes' }));
    const kept = await screen.findByRole('listitem', { name: 'Ligne 1' });
    expect(within(kept).getByLabelText('Produit')).toHaveValue(IDS.eggs);
    expect(within(kept).getByLabelText('Quantité')).toHaveValue('12');
    expect(screen.getByLabelText('Note pour le magasin (facultatif)')).toHaveValue('Urgent');
  });

  it('aucun PDV servi : message, pas de formulaire', async () => {
    await getDb().projections.delete(`org:POINT_OF_SALE:${IDS.site}`);
    renderScreen();
    expect(await screen.findByText(/Aucun point de vente sur ce téléphone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Envoyer la demande' })).not.toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { BlindReceiptScreen } from './BlindReceiptScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const STORE = IDS.mobile;

async function seed(custody: 'SHARED' | 'EXCLUSIVE_USER', dispatched = false): Promise<void> {
  const db = getDb();
  await seedSalesFixtures(db, { posCustody: custody });
  await db.projections.put({
    key: `location:LOCATION:${STORE}`,
    dataset: 'location',
    entity_type: 'LOCATION',
    entity_id: STORE,
    scope_type: 'GLOBAL',
    scope_id: null,
    row_version: 1,
    seq: 1,
    data: {
      id: STORE,
      site_id: IDS.site,
      code: 'MAG-YDE',
      name: 'Magasin central',
      location_type: 'STORE',
      is_virtual: false,
      custody_mode: 'SHARED',
      custodian_user_id: null,
      designated_device_id: null,
      status: 'ACTIVE',
    },
  });
  if (dispatched) {
    await db.projections.put({
      key: 'transfers:STOCK_TRANSFER:t-connu',
      dataset: 'transfers',
      entity_type: 'STOCK_TRANSFER',
      entity_id: 't-connu',
      scope_type: 'LOCATION',
      scope_id: IDS.pos,
      row_version: 1,
      seq: 1,
      data: {
        id: 't-connu',
        doc_number: 'TRF-2026-000020',
        transfer_kind: 'STANDARD',
        from_location_id: STORE,
        to_location_id: IDS.pos,
        status: 'DISPATCHED',
        dispatched_at: '2026-10-10T07:00:00.000Z',
        carrier_name: null,
        notes: null,
        occurred_at: '2026-10-10T07:00:00.000Z',
        version: 2,
        lines: [],
      },
    });
  }
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <BlindReceiptScreen />
    </MemoryRouter>,
  );
}

describe('Réception sans document (ECR-STK-03, BR-STK-024)', () => {
  beforeEach(async () => {
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne sur un emplacement exclusif : charge utile stricte, ajoutée au disponible', async () => {
    await seed('EXCLUSIVE_USER');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('En provenance de'), STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(line).getByLabelText('Quantité'), '2');
    await user.selectOptions(within(line).getByLabelText('Unité'), 'PLATEAU');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la réception' }));
    expect(await screen.findByText(/Réception enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.receive',
      aggregate_type: 'STOCK_TRANSFER',
      captured_offline: true,
    });
    expect(command?.payload).toEqual({
      fromLocationId: STORE,
      toLocationId: IDS.pos,
      lines: [{ productId: IDS.eggs, unitCode: 'PLATEAU', receivedQtyBase: 60 }],
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(-60);
  });

  it('produit désactivé : toujours recevable, signalé comme tel (BR-CAT-006)', async () => {
    await seed('EXCLUSIVE_USER');
    const db = getDb();
    const chicken = await db.projections.get(`product:PRODUCT:${IDS.chicken}`);
    if (!chicken) throw new Error('produit de la fixture absent');
    await db.projections.put({ ...chicken, data: { ...chicken.data, status: 'INACTIVE' } });
    renderScreen();
    const line = await screen.findByRole('listitem', { name: 'Ligne 1' });
    expect(within(line).getByText('Poulet de chair (désactivé)')).toBeInTheDocument();
  });

  it('en ligne sur un emplacement partagé : refusée sur l’appareil', async () => {
    await seed('SHARED');
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/partagé/);
    expect(screen.getByRole('button', { name: 'Enregistrer la réception' })).toBeDisabled();
  });

  it('transfert expédié connu : à recevoir avec son document ; produit en double refusé', async () => {
    await seed('EXCLUSIVE_USER', true);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('En provenance de'), STORE);
    expect(screen.getByRole('alert')).toHaveTextContent(/TRF-2026-000020/);
    expect(screen.getByRole('link', { name: 'le recevoir avec son document' })).toHaveAttribute(
      'href',
      '/stock/receptions/t-connu',
    );
    await user.click(screen.getByRole('button', { name: '+ Ajouter une ligne' }));
    for (const name of ['Ligne 1', 'Ligne 2']) {
      const line = screen.getByRole('listitem', { name });
      await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
      await user.type(within(line).getByLabelText('Quantité'), '1');
    }
    expect(screen.getAllByText(/Ce produit figure déjà/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Enregistrer la réception' })).toBeDisabled();
  });

  /** Réception sans document non rapprochée de l'emplacement (jeu `transfers`, statut `UNMATCHED`). */
  async function seedPendingReceipt(): Promise<void> {
    await getDb().projections.put({
      key: 'transfers:STOCK_TRANSFER:r-attente',
      dataset: 'transfers',
      entity_type: 'STOCK_TRANSFER',
      entity_id: 'r-attente',
      scope_type: 'LOCATION',
      scope_id: IDS.pos,
      row_version: 1,
      seq: 1,
      data: {
        id: 'r-attente',
        doc_number: 'TRF-2026-000031',
        transfer_kind: 'BLIND_RECEIPT',
        from_location_id: STORE,
        to_location_id: IDS.pos,
        status: 'UNMATCHED',
        dispatched_at: null,
        carrier_name: null,
        notes: null,
        occurred_at: '2026-10-10T08:00:00.000Z',
        version: 1,
        lines: [
          {
            id: 'rl-1',
            product_id: IDS.eggs,
            lot_id: null,
            unit_code: 'U',
            requested_qty_base: null,
            dispatched_qty_base: null,
            received_qty_base: '57.000',
          },
        ],
      },
    });
  }

  it('AV-520 : réception en attente — rapprochement manuel d’un transfert expédié de la même paire (en ligne)', async () => {
    await seed('EXCLUSIVE_USER', true);
    await seedPendingReceipt();
    const user = userEvent.setup();
    renderScreen();
    const section = within(
      await screen.findByRole('region', { name: 'Réceptions sans document en attente' }),
    );
    const item = within(section.getByRole('listitem', { name: 'TRF-2026-000031' }));
    expect(item.getByText(/57 .*Œufs de table/)).toBeInTheDocument();
    await user.click(item.getByRole('button', { name: 'Rapprocher d’un transfert' }));
    // Le bouton de confirmation reste inactif tant qu'aucun transfert n'est choisi.
    expect(item.getByRole('button', { name: 'Rapprocher' })).toBeDisabled();
    await user.selectOptions(item.getByLabelText('Transfert expédié'), 't-connu');
    await user.click(item.getByRole('button', { name: 'Rapprocher' }));

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.match_blind',
      aggregate_type: 'STOCK_TRANSFER',
      aggregate_id: 'r-attente',
      captured_offline: false,
    });
    expect(command?.payload).toEqual({ transferId: 't-connu' });
  });

  it('AV-520 : annulation d’une réception en attente — motif exigé', async () => {
    await seed('EXCLUSIVE_USER');
    await seedPendingReceipt();
    const user = userEvent.setup();
    renderScreen();
    const item = within(await screen.findByRole('listitem', { name: 'TRF-2026-000031' }));
    await user.click(item.getByRole('button', { name: 'Annuler la réception' }));
    const confirm = item.getByRole('button', { name: 'Annuler cette réception' });
    expect(confirm).toBeDisabled();
    await user.type(
      item.getByLabelText('Motif de l’annulation'),
      '  Saisie sur le mauvais emplacement ',
    );
    await user.click(confirm);

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.cancel_blind',
      aggregate_id: 'r-attente',
    });
    expect(command?.payload).toEqual({ reason: 'Saisie sur le mauvais emplacement' });
  });

  it('AV-520 : sans transfert expédié connu, le rapprochement l’explique ; hors ligne, les deux actions sont inactives', async () => {
    await seed('EXCLUSIVE_USER');
    await seedPendingReceipt();
    const user = userEvent.setup();
    renderScreen();
    const item = within(await screen.findByRole('listitem', { name: 'TRF-2026-000031' }));
    await user.click(item.getByRole('button', { name: 'Rapprocher d’un transfert' }));
    expect(item.getByText(/Aucun transfert expédié de cette source/)).toBeInTheDocument();
    cleanup();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    const offline = within(await screen.findByRole('listitem', { name: 'TRF-2026-000031' }));
    expect(offline.getByRole('button', { name: 'Rapprocher d’un transfert' })).toBeDisabled();
    expect(offline.getByRole('button', { name: 'Annuler la réception' })).toBeDisabled();
    expect(
      screen.getByText('Rapprochement et annulation : en ligne seulement.'),
    ).toBeInTheDocument();
  });

  it('AV-520 : sans réception en attente, la section n’apparaît pas', async () => {
    await seed('EXCLUSIVE_USER');
    renderScreen();
    await screen.findByLabelText('En provenance de');
    expect(
      screen.queryByRole('region', { name: 'Réceptions sans document en attente' }),
    ).toBeNull();
  });
});

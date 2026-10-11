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
});

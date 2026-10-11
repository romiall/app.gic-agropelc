import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { TransferScreen } from './TransferScreen.js';

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
const REQUEST = '01900000-0000-7000-8000-0000000000c9';
const REQUEST_LINE = '01900000-0000-7000-8000-0000000000ca';
const OTHER_SITE_STORE = '01900000-0000-7000-8000-0000000000cb';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/stock/transferts" element={<TransferScreen key="liste" />} />
        <Route path="/stock/transferts/:transferId" element={<TransferScreen key="detail" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Transférer (ECR-STK-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      {
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
      },
      {
        key: `transfers:STOCK_TRANSFER:${REQUEST}`,
        dataset: 'transfers',
        entity_type: 'STOCK_TRANSFER',
        entity_id: REQUEST,
        scope_type: 'LOCATION',
        scope_id: IDS.pos,
        row_version: 1,
        seq: 1,
        data: {
          id: REQUEST,
          doc_number: 'TRF-2026-000012',
          transfer_kind: 'STANDARD',
          from_location_id: IDS.pos,
          to_location_id: STORE,
          status: 'REQUESTED',
          dispatched_at: null,
          carrier_name: null,
          notes: null,
          occurred_at: '2026-10-10T07:00:00.000Z',
          version: 1,
          lines: [
            {
              id: REQUEST_LINE,
              product_id: IDS.eggs,
              lot_id: null,
              unit_code: 'U',
              requested_qty_base: '60.000',
              dispatched_qty_base: null,
              received_qty_base: null,
            },
          ],
        },
      },
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : expédition directe en conditionnement, convertie, retirée aussitôt du disponible', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.selectOptions(await screen.findByLabelText('Vers'), STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(line).getByLabelText('Quantité'), '2');
    await user.selectOptions(within(line).getByLabelText('Unité'), 'PLATEAU');
    await user.type(screen.getByLabelText('Transporteur (facultatif)'), 'Paul');
    await user.click(screen.getByRole('button', { name: 'Expédier' }));
    expect(await screen.findByText(/Expédition enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.dispatch',
      aggregate_type: 'STOCK_TRANSFER',
      captured_offline: true,
      payload: {
        fromLocationId: IDS.pos,
        toLocationId: STORE,
        lines: [{ productId: IDS.eggs, unitCode: 'PLATEAU', quantityBase: 60 }],
        carrierName: 'Paul',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(60);
  });

  it('en ligne : quantité supérieure au disponible bloquée', async () => {
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.selectOptions(await screen.findByLabelText('Vers'), STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.chicken);
    await user.type(within(line).getByLabelText('Quantité'), '5');
    expect(screen.getByRole('alert')).toHaveTextContent(/Poulet de chair/);
    expect(screen.getByRole('button', { name: 'Expédier' })).toBeDisabled();
  });

  it('demande reçue : quantités préremplies, expédition partielle, demande signalée en attente', async () => {
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    await user.click(
      await screen.findByRole('link', { name: 'Expédier la demande TRF-2026-000012' }),
    );
    const quantity = await screen.findByLabelText('Expédié (U)');
    expect(quantity).toHaveValue('60');
    await user.clear(quantity);
    await user.type(quantity, '50');
    await user.click(screen.getByRole('button', { name: 'Expédier la demande' }));
    expect(
      await screen.findByText(/Expédition en cours d’envoi|Expédition enregistrée/),
    ).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.dispatch',
      aggregate_id: REQUEST,
      payload: {
        transferId: REQUEST,
        lines: [
          { transferLineId: REQUEST_LINE, productId: IDS.eggs, unitCode: 'U', quantityBase: 50 },
        ],
      },
    });
    await user.click(screen.getByRole('link', { name: 'Autre expédition' }));
    expect(await screen.findByText('Expédition en attente d’envoi')).toBeInTheDocument();
  });

  it('demande reçue refusée avec un motif, puis signalée en attente sans nouvelle expédition', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/stock/transferts/${REQUEST}`);
    await user.click(await screen.findByRole('button', { name: 'Refuser la demande' }));
    await user.type(screen.getByLabelText('Motif du refus (facultatif)'), '  Rupture au PDV ');
    await user.click(screen.getByRole('button', { name: 'Confirmer le refus' }));
    expect(await screen.findByText(/Refus enregistré sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.decline',
      aggregate_type: 'STOCK_TRANSFER',
      aggregate_id: REQUEST,
      payload: { transferId: REQUEST, comment: 'Rupture au PDV' },
    });
    // Rien ne quitte le disponible pour un refus.
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBeUndefined();
    await user.click(screen.getByRole('link', { name: 'Autre expédition' }));
    expect(await screen.findByText('Refus en attente d’envoi')).toBeInTheDocument();
    cleanup();
    renderAt(`/stock/transferts/${REQUEST}`);
    expect(await screen.findByText(/déjà refusée depuis ce téléphone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expédier la demande' })).not.toBeInTheDocument();
  });

  it('hors ligne : mouvement interne vers un emplacement du même site, sortie et entrée aussitôt comptées', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().projections.put({
      key: `location:LOCATION:${OTHER_SITE_STORE}`,
      dataset: 'location',
      entity_type: 'LOCATION',
      entity_id: OTHER_SITE_STORE,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: {
        id: OTHER_SITE_STORE,
        site_id: '01900000-0000-7000-8000-0000000000cc',
        code: 'MAG-DLA',
        name: 'Magasin de Douala',
        location_type: 'STORE',
        is_virtual: false,
        custody_mode: 'SHARED',
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      },
    });
    const user = userEvent.setup();
    renderAt('/stock/transferts');
    // L'expédition propose aussi les emplacements des autres sites.
    expect(
      within(await screen.findByLabelText('Vers')).getByRole('option', {
        name: 'Magasin de Douala',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Déplacer dans le même site' }));
    expect(screen.getByRole('heading', { name: 'Mouvement interne' })).toBeInTheDocument();
    const destination = screen.getByLabelText('Vers');
    expect(
      within(destination).queryByRole('option', { name: 'Magasin de Douala' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Transporteur (facultatif)')).not.toBeInTheDocument();
    await user.selectOptions(destination, STORE);
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), IDS.eggs);
    await user.type(within(line).getByLabelText('Quantité'), '30');
    await user.type(screen.getByLabelText('Note (facultatif)'), 'Rangement');
    await user.click(screen.getByRole('button', { name: 'Déplacer' }));
    expect(await screen.findByText(/Mouvement enregistré sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.move_internal',
      aggregate_type: 'STOCK_TRANSFER',
      captured_offline: true,
      payload: {
        fromLocationId: IDS.pos,
        toLocationId: STORE,
        lines: [{ productId: IDS.eggs, unitCode: 'U', quantityBase: 30 }],
        notes: 'Rangement',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(30);
    expect(refs.pending.get(`${STORE}:${IDS.eggs}`)).toBe(-30);
  });
});

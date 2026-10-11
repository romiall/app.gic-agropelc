import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { IncubationScreen } from './IncubationScreen.js';
import { batchViews } from './incubation.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
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
  }),
}));

const FARM = '01900000-0000-7000-8000-0000000008a1';
const INCUBATOR = '01900000-0000-7000-8000-0000000008a2';
const HATCHER = '01900000-0000-7000-8000-0000000008a3';
const STORE = '01900000-0000-7000-8000-0000000008a4';
const HATCH_EGG = '01900000-0000-7000-8000-0000000008a5';
const CHICK = '01900000-0000-7000-8000-0000000008a6';
const COLLECTION_LOT = '01900000-0000-7000-8000-0000000008a7';
const BATCH_A = '01900000-0000-7000-8000-0000000008a8';
const BATCH_B = '01900000-0000-7000-8000-0000000008a9';

function projection(
  dataset: string,
  type: string,
  id: string,
  data: object,
  key = `${dataset}:${type}:${id}`,
) {
  return {
    key,
    dataset,
    entity_type: type,
    entity_id: id,
    scope_type: 'GLOBAL',
    scope_id: null,
    row_version: 1,
    seq: 1,
    data: { id, ...data } as Record<string, unknown>,
  };
}

const location = (id: string, name: string, type: string) =>
  projection('location', 'LOCATION', id, {
    site_id: FARM,
    code: name.toUpperCase(),
    name,
    location_type: type,
    is_virtual: false,
    custody_mode: 'SHARED',
    custodian_user_id: null,
    designated_device_id: null,
    status: 'ACTIVE',
  });

const batch = (id: string, code: string, overrides: object) =>
  projection('production', 'INCUBATION_BATCH', id, {
    batch_code: code,
    stock_lot_id: `${id}-lot`,
    site_id: FARM,
    species: 'POULE',
    egg_product_id: HATCH_EGG,
    chick_product_id: CHICK,
    incubator_location_id: INCUBATOR,
    hatcher_location_id: null,
    egg_source: 'INTERNAL',
    eggs_set_qty: 500,
    set_at: '2026-09-20T08:00:00.000Z',
    expected_candling_date: '2026-09-27',
    expected_transfer_date: '2026-10-08',
    expected_hatch_date: '2026-10-11',
    infertile_qty: 0,
    early_dead_qty: 0,
    accidental_loss_qty: 0,
    transferred_qty: null,
    status: 'INCUBATING',
    ...overrides,
  });

const setting = (key: string, value: unknown) =>
  projection('setting', 'SETTING', key, {
    key,
    value,
    scope_type: 'GLOBAL',
    scope_id: null,
    valid_from: '2026-01-01T00:00:00.000Z',
  });

function renderScreen() {
  return render(
    <MemoryRouter>
      <IncubationScreen />
    </MemoryRouter>,
  );
}

describe('Incubation (ECR-PRD-06)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('site', 'SITE', FARM, {
        code: 'FERME-1',
        name: 'Ferme de Mfou',
        site_type: 'FERME',
        zone_id: IDS.zone,
        status: 'ACTIVE',
      }),
      location(INCUBATOR, 'Incubateur 1', 'INCUBATOR'),
      location(HATCHER, 'Éclosoir 1', 'HATCHER'),
      location(STORE, 'Salle des œufs', 'STORE'),
      projection('product', 'PRODUCT', HATCH_EGG, {
        code: 'OEUF-COUV',
        name: 'Œufs à couver',
        category_id: IDS.zone,
        base_unit_code: 'U',
        is_sellable: false,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
        stock_family: 'PRODUCTION_COMMERCIALISABLE',
        lot_tracking: 'OPTIONAL',
      }),
      projection('product', 'PRODUCT', CHICK, {
        code: 'POUSSIN',
        name: 'Poussins d’un jour',
        category_id: IDS.zone,
        base_unit_code: 'U',
        is_sellable: true,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
        stock_family: 'BIOLOGIQUE',
        lot_tracking: 'REQUIRED',
        species: 'POULET_CHAIR',
      }),
      setting('production.hatching_egg_product_code', 'OEUF-COUV'),
      setting('production.incubation_durations', {
        POULE: { candlingDay: 7, transferDay: 18, hatchDay: 21 },
      }),
      projection(
        'stock',
        'STOCK_BALANCE',
        HATCH_EGG,
        {
          location_id: STORE,
          product_id: HATCH_EGG,
          qty_on_hand: '600',
          qty_reserved: '0',
          qty_allocated: '0',
          lots: [{ lot_id: COLLECTION_LOT, lot_code: 'COL-1', qty_on_hand: '600' }],
        },
        `stock:STOCK_BALANCE:${STORE}:${HATCH_EGG}`,
      ),
      batch(BATCH_A, 'INC-MFO-2026-001', {}),
      batch(BATCH_B, 'INC-MFO-2026-002', {
        eggs_set_qty: 400,
        infertile_qty: 20,
        early_dead_qty: 10,
        hatcher_location_id: HATCHER,
        status: 'IN_HATCHER',
      }),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : lot démarré depuis la salle des œufs, puis mirage qui attend le démarrage', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Démarrer un lot' }));
    const start = within(screen.getByRole('region', { name: 'Démarrer un lot' }));
    expect(start.getByText('Œufs à couver : Œufs à couver')).toBeInTheDocument();
    await user.selectOptions(start.getByLabelText('Espèce'), 'POULE');
    await user.selectOptions(start.getByLabelText('Poussins produits'), CHICK);
    await user.selectOptions(start.getByLabelText('Œufs pris sur'), STORE);
    await user.selectOptions(start.getByLabelText('Lot d’œufs'), COLLECTION_LOT);
    await user.type(start.getByLabelText('Œufs mis à couver'), '300');
    await user.click(start.getByRole('button', { name: 'Démarrer l’incubation' }));
    expect(await screen.findByText(/Saisie enregistrée sur ce téléphone/)).toBeInTheDocument();

    const list = within(screen.getByRole('region', { name: 'Lots en cours' }));
    const pending = list.getByRole('listitem', {
      name: 'Lot démarré sur ce téléphone (numéro à venir)',
    });
    expect(pending).toHaveTextContent(/Mis à couver 300/);
    await user.click(within(pending).getByRole('button', { name: 'Mirage' }));
    await user.type(within(pending).getByLabelText('Infertiles'), '12');
    const save = within(pending).getByRole('button', { name: 'Enregistrer le mirage' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(2));

    const [started, candled] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(started).toMatchObject({
      command_type: 'production.incubation.start',
      aggregate_type: 'INCUBATION_BATCH',
      payload: {
        species: 'POULE',
        eggProductId: HATCH_EGG,
        chickProductId: CHICK,
        incubatorLocationId: INCUBATOR,
        eggSource: 'INTERNAL',
        eggsSet: 300,
        sourceLocationId: STORE,
        sourceStockLotId: COLLECTION_LOT,
      },
    });
    expect(candled).toMatchObject({
      command_type: 'production.incubation.record_candling',
      aggregate_type: 'INCUBATION_EVENT',
      depends_on: [started?.command_id],
      payload: { batchId: started?.aggregate_id, infertile: 12, earlyDead: 0 },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${STORE}:${HATCH_EGG}`)).toBe(300);
  });

  it('en ligne : mirage et éclosion contrôlés par le bilan du domaine, transfert vers l’éclosoir', async () => {
    const user = userEvent.setup();
    renderScreen();
    const incubating = await screen.findByRole('listitem', { name: 'INC-MFO-2026-001' });
    await user.click(within(incubating).getByRole('button', { name: 'Mirage' }));
    await user.type(within(incubating).getByLabelText('Infertiles'), '600');
    expect(within(incubating).getByText(/Mirage : 600 œufs retirés pour 500/)).toBeInTheDocument();
    await user.clear(within(incubating).getByLabelText('Infertiles'));
    await user.type(within(incubating).getByLabelText('Infertiles'), '30');
    await user.type(within(incubating).getByLabelText('Mortalité embryonnaire'), '5');
    await user.click(within(incubating).getByRole('button', { name: 'Enregistrer le mirage' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    // Les compteurs tiennent compte du mirage en attente.
    expect(
      await screen.findByText(/Mis à couver 500 · retirés au mirage 35 · pertes 0 · restants 465/),
    ).toBeInTheDocument();

    const hatching = screen.getByRole('listitem', { name: 'INC-MFO-2026-002' });
    const openHatch = within(hatching).getByRole('button', { name: 'Éclosion' });
    await waitFor(() => expect(openHatch).toBeEnabled());
    await user.click(openHatch);
    await user.type(within(hatching).getByLabelText('Poussins viables'), '300');
    await user.type(within(hatching).getByLabelText('Poussins non viables'), '20');
    await user.type(within(hatching).getByLabelText('Non éclos'), '40');
    expect(
      within(hatching).getByText(/Éclosion : 360 œufs comptés pour 370 restants/),
    ).toBeInTheDocument();
    await user.clear(within(hatching).getByLabelText('Non éclos'));
    await user.type(within(hatching).getByLabelText('Non éclos'), '50');
    const save = within(hatching).getByRole('button', { name: 'Enregistrer l’éclosion' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(2));

    const again = screen.getByRole('listitem', { name: 'INC-MFO-2026-001' });
    const open = within(again).getByRole('button', { name: 'Transférer vers l’éclosoir' });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    await user.selectOptions(within(again).getByLabelText('Éclosoir'), HATCHER);
    const transfer = within(again).getByRole('button', { name: 'Enregistrer le transfert' });
    await waitFor(() => expect(transfer).toBeEnabled());
    await user.click(transfer);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(3));

    const commands = await getDb().outbox.orderBy('device_seq').toArray();
    expect(commands.map((command) => [command.command_type, command.payload])).toEqual([
      ['production.incubation.record_candling', { batchId: BATCH_A, infertile: 30, earlyDead: 5 }],
      [
        'production.incubation.record_hatch',
        { batchId: BATCH_B, unhatched: 50, hatchedViable: 300, hatchedNonviable: 20 },
      ],
      [
        'production.incubation.transfer_to_hatcher',
        { batchId: BATCH_A, hatcherLocationId: HATCHER },
      ],
    ]);
    // Après l'éclosion en attente, le lot n'est plus proposé à l'éclosion.
    const refs = await loadSalesReferences(getDb());
    expect(batchViews(refs).find((view) => view.id === BATCH_B)?.status).toBe('CLOSED');
  });
});

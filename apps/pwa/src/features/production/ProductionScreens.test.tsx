import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { DailyEntryScreen } from './DailyEntryScreen.js';
import { EggCollectionScreen } from './EggCollectionScreen.js';
import { LotsScreen } from './LotsScreen.js';
import { OutputScreen } from './OutputScreen.js';
import { checkEggs, EMPTY_EGGS } from './eggs.js';

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

const BUILDING = '01900000-0000-7000-8000-0000000005a1';
const STORE = '01900000-0000-7000-8000-0000000005a2';
const BROILERS = '01900000-0000-7000-8000-0000000005a3';
const LAYERS = '01900000-0000-7000-8000-0000000005a4';
const BROILER_STOCK_LOT = '01900000-0000-7000-8000-0000000005a5';
const LAYER_STOCK_LOT = '01900000-0000-7000-8000-0000000005a6';
const FEED = '01900000-0000-7000-8000-0000000005a7';

function projection(dataset: string, type: string, id: string, data: object, key?: string) {
  return {
    key: key ?? `${dataset}:${type}:${id}`,
    dataset,
    entity_type: type,
    entity_id: id,
    scope_type: 'SITE',
    scope_id: IDS.site,
    row_version: 1,
    seq: 1,
    data: { id, ...data } as Record<string, unknown>,
  };
}

const location = (id: string, name: string, type: string) =>
  projection('location', 'LOCATION', id, {
    site_id: IDS.site,
    code: name.toUpperCase(),
    name,
    location_type: type,
    is_virtual: false,
    custody_mode: 'SHARED',
    custodian_user_id: null,
    designated_device_id: null,
    status: 'ACTIVE',
  });

const lot = (id: string, code: string, type: string, stockLot: string) =>
  projection('production', 'PRODUCTION_LOT', id, {
    lot_code: code,
    lot_type: type,
    product_id: IDS.chicken,
    stock_lot_id: stockLot,
    site_id: IDS.site,
    main_location_id: BUILDING,
    strain: null,
    status: 'ACTIVE',
    start_date: '2026-09-20',
    planned_end_date: null,
    initial_quantity: 500,
    occurred_at: '2026-09-20T08:00:00.000Z',
  });

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/production/lots" element={<LotsScreen />} />
        <Route path="/production/lots/:lotId" element={<DailyEntryScreen />} />
        <Route path="/production/collecte" element={<EggCollectionScreen />} />
        <Route path="/production/sortie" element={<OutputScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Production (ECR-PRD-01, ECR-PRD-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      location(BUILDING, 'Bâtiment 1', 'BUILDING'),
      location(STORE, 'Magasin aliment', 'STORE'),
      lot(BROILERS, 'PC-2026-001', 'POULET_CHAIR', BROILER_STOCK_LOT),
      lot(LAYERS, 'PON-2026-002', 'PONDEUSE', LAYER_STOCK_LOT),
      projection('product', 'PRODUCT', FEED, {
        code: 'ALIM-DEM',
        name: 'Aliment démarrage',
        category_id: IDS.zone,
        base_unit_code: 'KG',
        is_sellable: false,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
        stock_family: 'INTRANT',
        is_consumable: true,
        lot_tracking: 'NONE',
      }),
      projection(
        'stock',
        'STOCK_BALANCE',
        `${BUILDING}:${IDS.chicken}`,
        {
          location_id: BUILDING,
          product_id: IDS.chicken,
          qty_on_hand: '1300.000',
          qty_reserved: '0',
          qty_allocated: '0',
          lots: [
            { lot_id: BROILER_STOCK_LOT, lot_code: 'PC-2026-001', qty_on_hand: '500.000' },
            { lot_id: LAYER_STOCK_LOT, lot_code: 'PON-2026-002', qty_on_hand: '800.000' },
          ],
        },
        `stock:STOCK_BALANCE:${BUILDING}:${IDS.chicken}`,
      ),
      projection(
        'stock',
        'STOCK_BALANCE',
        `${STORE}:${FEED}`,
        {
          location_id: STORE,
          product_id: FEED,
          qty_on_hand: '200.000',
          qty_reserved: '0',
          qty_allocated: '0',
          lots: [],
        },
        `stock:STOCK_BALANCE:${STORE}:${FEED}`,
      ),
      projection('setting', 'SETTING', 'set-grades', {
        key: 'production.egg_grade_product_codes',
        value: ['OEUF'],
        scope_type: 'GLOBAL',
        scope_id: null,
        valid_from: '2026-01-01T00:00:00.000Z',
      }),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
    await getDb().navigation.clear();
  });

  async function rememberRoles(roles: readonly string[]) {
    await getDb().navigation.put({
      user_id: IDS.user,
      roles: [...roles],
      sections: [],
      saved_at: '2026-10-10T08:00:00.000Z',
    });
  }

  it('sortie vers commercialisation hors ligne : têtes du lot expédiées, effectif aussitôt réduit', async () => {
    await rememberRoles(['RESP_FERME']);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/production/lots/${BROILERS}`);
    await user.click(await screen.findByRole('link', { name: 'Sortie vers commercialisation →' }));
    expect(await screen.findByText('Effectif sur cet emplacement : 500 têtes')).toBeInTheDocument();
    // Le responsable de ferme ne déclare pas le lot prêt à la vente.
    expect(
      screen.queryByRole('button', { name: 'Déclarer prêt à la vente' }),
    ).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Enregistrer la sortie' });
    await user.type(screen.getByLabelText('Nombre de têtes (U)'), '20');
    expect(submit).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Vers'), IDS.pos);
    await user.type(screen.getByLabelText('Transporteur (facultatif)'), 'Moto Paul');
    await user.click(submit);
    expect(await screen.findByText(/Sortie enregistrée sur ce téléphone/)).toBeInTheDocument();
    expect(await screen.findByText('Effectif sur cet emplacement : 480 têtes')).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.dispatch',
      aggregate_type: 'STOCK_TRANSFER',
      captured_offline: true,
      payload: {
        fromLocationId: BUILDING,
        toLocationId: IDS.pos,
        lines: [
          { productId: IDS.chicken, unitCode: 'U', quantityBase: 20, lotId: BROILER_STOCK_LOT },
        ],
        carrierName: 'Moto Paul',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${BUILDING}:${IDS.chicken}`)).toBe(20);
  });

  it('responsable de production en ligne : lot prêt à la vente ; plus de têtes que l’effectif bloqué', async () => {
    await rememberRoles(['RESP_PRODUCTION']);
    const user = userEvent.setup();
    renderAt(`/production/sortie?lot=${BROILERS}`);
    await user.selectOptions(await screen.findByLabelText('Vers'), IDS.pos);
    const quantity = screen.getByLabelText('Nombre de têtes (U)');
    const dispatch = screen.getByRole('button', { name: 'Enregistrer la sortie' });
    await user.type(quantity, '501');
    expect(screen.getByRole('alert')).toHaveTextContent(/le serveur refuserait/);
    expect(dispatch).toBeDisabled();
    await user.clear(quantity);
    await user.type(quantity, '500');
    expect(dispatch).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Déclarer prêt à la vente' }));
    expect(await screen.findByText(/Changement de statut en cours d’envoi/)).toBeInTheDocument();
    // Aucune sortie partie : seul le changement de statut est dans l'outbox.
    const commands = await getDb().outbox.toArray();
    expect(commands.map((entry) => entry.command_type)).toEqual(['production.lot.set_status']);
    const [command] = commands;
    expect(command).toMatchObject({
      command_type: 'production.lot.set_status',
      aggregate_type: 'PRODUCTION_LOT',
      aggregate_id: BROILERS,
      payload: { status: 'SELLING' },
    });
  });

  it('hors ligne : lots actifs, mortalité et aliment saisis, effectif et journal aussitôt à jour', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt('/production/lots');
    const broilers = await screen.findByRole('link', { name: /PC-2026-001/ });
    expect(broilers).toHaveTextContent('500 têtes');
    expect(broilers).toHaveTextContent('20 jours');
    await user.click(broilers);

    await user.type(await screen.findByLabelText('Nombre de morts'), '3');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la mortalité' }));
    expect(await screen.findByText(/Mortalité enregistrée sur ce téléphone/)).toBeInTheDocument();
    const journal = within(screen.getByRole('region', { name: 'Journal du jour' }));
    expect(await journal.findByText('3 mort(s)')).toBeInTheDocument();
    expect(screen.getByText(/· 497 têtes/)).toBeInTheDocument();
    expect(screen.getByText('Effectif sur cet emplacement : 497 têtes')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Aliment et intrants' }));
    await user.selectOptions(screen.getByLabelText('Aliment ou intrant'), FEED);
    await user.selectOptions(screen.getByLabelText('Pris sur'), STORE);
    await user.type(screen.getByLabelText('Quantité'), '25');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la consommation' }));
    expect(await journal.findByText('Aliment démarrage : 25 KG')).toBeInTheDocument();

    const [mortality, input] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(mortality).toMatchObject({
      command_type: 'production.mortality.record',
      aggregate_type: 'STOCK_LOSS',
      captured_offline: true,
      payload: { productionLotId: BROILERS, locationId: BUILDING, quantity: 3 },
    });
    expect(input).toMatchObject({
      command_type: 'production.input.record',
      aggregate_type: 'CONSUMPTION',
      payload: {
        productionLotId: BROILERS,
        locationId: STORE,
        productId: FEED,
        quantityBase: 25,
        unitCode: 'KG',
        quantity: 25,
        costType: 'ALIMENT',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${STORE}:${FEED}`)).toBe(25);
  });

  it('en ligne : plus de morts que l’effectif bloqué ; pesée et observation', async () => {
    const user = userEvent.setup();
    renderAt(`/production/lots/${BROILERS}`);
    await user.type(await screen.findByLabelText('Nombre de morts'), '501');
    expect(screen.getByRole('alert')).toHaveTextContent(/le serveur refuserait/);
    expect(screen.getByRole('button', { name: 'Enregistrer la mortalité' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Pesée' }));
    await user.type(screen.getByLabelText('Nombre de sujets pesés'), '20');
    await user.type(screen.getByLabelText('Poids moyen (g)'), '1250,5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la pesée' }));
    await screen.findByText(/Pesée : 20 sujets, 1250.5 g en moyenne/);

    await user.click(screen.getByRole('radio', { name: 'Observation' }));
    await user.type(screen.getByLabelText('Observation', { selector: 'textarea' }), 'RAS');
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’observation' }));
    await screen.findByText('RAS');
    const commands = await getDb().outbox.orderBy('device_seq').toArray();
    expect(commands.map((command) => command.payload)).toEqual([
      { productionLotId: BROILERS, sampleSize: 20, avgWeightG: 1250.5, source: 'MANUAL' },
      { productionLotId: BROILERS, observationType: 'SANITAIRE', text: 'RAS', severity: 'INFO' },
    ]);
  });

  it('brouillon conservé en changeant de nature ; cause exigeant un commentaire', async () => {
    await getDb().projections.put(
      projection('reason_code', 'REASON_CODE', 'cause-chaleur', {
        category: 'LOSS',
        code: 'CHALEUR',
        label: 'Coup de chaleur',
        loss_category: 'MORTALITE',
        requires_comment: true,
        is_active: true,
      }),
    );
    const user = userEvent.setup();
    renderAt(`/production/lots/${BROILERS}`);
    await user.type(await screen.findByLabelText('Nombre de morts'), '4');
    await user.click(screen.getByRole('radio', { name: 'Pesée' }));
    await user.click(screen.getByRole('radio', { name: 'Mortalité' }));
    expect(screen.getByLabelText('Nombre de morts')).toHaveValue('4');

    await user.selectOptions(screen.getByLabelText('Cause (facultatif)'), 'cause-chaleur');
    expect(screen.getByText('Cette cause exige un commentaire.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Enregistrer la mortalité' });
    expect(submit).toBeDisabled();
    const comment = screen.getByLabelText('Commentaire (exigé par cette cause)');
    expect(comment).toHaveAttribute('aria-invalid', 'true');
    await user.type(comment, 'Panne de ventilation');
    expect(submit).toBeEnabled();
  });

  it('collecte d’œufs : bilan exigé, calibres paramétrés, œufs à couver sans produit refusés', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/production/collecte?lot=${LAYERS}`);
    await user.type(await screen.findByLabelText('Œufs collectés'), '100');
    await user.type(screen.getByLabelText('Cassés'), '2');
    await user.type(screen.getByLabelText('Non conformes'), '3');
    expect(screen.getByText(/Reste 95 œufs à répartir/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Enregistrer la collecte' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Œufs de table'), '95');
    await user.selectOptions(screen.getByLabelText('Stockés sur'), STORE);
    await user.click(submit);
    expect(await screen.findByText(/Collecte enregistrée sur ce téléphone/)).toBeInTheDocument();
    const [collection] = await getDb().outbox.toArray();
    expect(collection).toMatchObject({
      command_type: 'production.egg_collection.record',
      aggregate_type: 'EGG_COLLECTION',
      payload: {
        productionLotId: LAYERS,
        collectionDate: '2026-10-10',
        storageLocationId: STORE,
        collected: 100,
        broken: 2,
        nonconforming: 3,
        hatching: 0,
        grades: [{ productId: IDS.eggs, quantity: 95 }],
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${STORE}:${IDS.eggs}`)).toBe(-95);

    const check = checkEggs(
      { ...EMPTY_EGGS, collected: '10', hatching: '10' },
      { grades: [], gradesConfigured: true, hatchingProduct: undefined },
    );
    expect(check.issues).toContain('HATCHING_PRODUCT_MISSING');
  });
});

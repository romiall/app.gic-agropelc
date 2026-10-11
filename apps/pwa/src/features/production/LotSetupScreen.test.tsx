import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import type { ProductData, ProductionLotData } from '../sales/types.js';
import { rearingHeadcount } from './daily.js';
import { LotSetupScreen } from './LotSetupScreen.js';
import {
  allowedKinds,
  checkEntry,
  checkLotDraft,
  EMPTY_ENTRY,
  entryLots,
  lotProducts,
  receiptAvailable,
  receiptProducts,
  sourceLocations,
  stockSources,
  type EntryLot,
} from './lot-setup.js';

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

const FARM = '01900000-0000-7000-8000-0000000006a1';
const BUILDING = '01900000-0000-7000-8000-0000000006a2';
const STORE = '01900000-0000-7000-8000-0000000006a3';
const CHICK = '01900000-0000-7000-8000-0000000006a4';
const BROILER = '01900000-0000-7000-8000-0000000006a5';
const SUPPLIER_LOT = '01900000-0000-7000-8000-0000000006a6';
const LOT_A = '01900000-0000-7000-8000-0000000006a7';
const LOT_B = '01900000-0000-7000-8000-0000000006a8';
const STOCK_LOT_A = '01900000-0000-7000-8000-0000000006a9';
const STOCK_LOT_B = '01900000-0000-7000-8000-0000000006aa';
const BUILDING_2 = '01900000-0000-7000-8000-0000000006ab';
const SUPPLIER_LOT_2 = '01900000-0000-7000-8000-0000000006ac';
const OTHER_USER = '01900000-0000-7000-8000-0000000000e9';

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

const product = (id: string, code: string, name: string) =>
  projection('product', 'PRODUCT', id, {
    code,
    name,
    category_id: IDS.zone,
    base_unit_code: 'U',
    is_sellable: true,
    pricing_mode: 'PER_UNIT',
    status: 'ACTIVE',
    stock_family: 'BIOLOGIQUE',
    lot_tracking: 'REQUIRED',
    species: 'POULET_CHAIR',
  });

const lot = (id: string, code: string, status: string, stockLot: string) =>
  projection('production', 'PRODUCTION_LOT', id, {
    lot_code: code,
    lot_type: 'POULET_CHAIR',
    product_id: BROILER,
    stock_lot_id: stockLot,
    site_id: FARM,
    main_location_id: BUILDING,
    parent_lot_id: null,
    strain: null,
    status,
    start_date: status === 'PLANNED' ? null : '2026-09-20',
    planned_end_date: null,
    initial_quantity: null,
    occurred_at: '2026-09-20T08:00:00.000Z',
  });

const balance = (locationId: string, productId: string, lots: { id: string; qty: string }[]) =>
  projection(
    'stock',
    'STOCK_BALANCE',
    productId,
    {
      location_id: locationId,
      product_id: productId,
      qty_on_hand: String(lots.reduce((sum, l) => sum + Number(l.qty), 0)),
      qty_reserved: '0',
      qty_allocated: '0',
      lots: lots.map((l) => ({ lot_id: l.id, lot_code: `L-${l.qty}`, qty_on_hand: l.qty })),
    },
    `stock:STOCK_BALANCE:${locationId}:${productId}`,
  );

function renderScreen() {
  return render(
    <MemoryRouter>
      <LotSetupScreen />
    </MemoryRouter>,
  );
}

describe('Nouveau lot ou entrée (ECR-PRD-04)', () => {
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
      location(BUILDING, 'Bâtiment 1', 'BUILDING'),
      location(BUILDING_2, 'Bâtiment 2', 'BUILDING'),
      location(STORE, 'Magasin ferme', 'STORE'),
      product(CHICK, 'POUSSIN', 'Poussins d’un jour'),
      product(BROILER, 'PC', 'Poulets de chair'),
      lot(LOT_A, 'LOT-MFO-2026-001', 'ACTIVE', STOCK_LOT_A),
      lot(LOT_B, 'LOT-MFO-2026-002', 'PLANNED', STOCK_LOT_B),
      balance(STORE, CHICK, [{ id: SUPPLIER_LOT, qty: '1000' }]),
      balance(BUILDING, BROILER, [{ id: STOCK_LOT_A, qty: '500' }]),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : lot créé puis mise en place depuis le stock, qui attend la création', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    const create = within(await screen.findByRole('region', { name: 'Nouveau lot' }));
    // Seuls les produits biologiques de l'espèce du type de lot sont proposés.
    const animals = create.getByLabelText('Animaux du lot');
    expect(within(animals).queryByText('Œufs de table')).not.toBeInTheDocument();
    await user.selectOptions(animals, BROILER);
    await user.type(create.getByLabelText('Souche (facultatif)'), 'Cobb 500');
    await user.click(create.getByRole('button', { name: 'Créer le lot' }));
    expect(await screen.findByText(/Lot enregistré sur ce téléphone/)).toBeInTheDocument();

    const entry = within(await screen.findByRole('region', { name: 'Entrée dans un lot' }));
    expect(entry.getByLabelText('Lot')).toHaveDisplayValue(
      'Nouveau lot Poulet de chair (numéro à venir)',
    );
    await user.selectOptions(entry.getByLabelText('Animaux en stock'), `${STORE}|${CHICK}`);
    await user.selectOptions(entry.getByLabelText('Lot de stock d’origine'), SUPPLIER_LOT);
    await user.type(entry.getByLabelText('Nombre de têtes'), '800');
    await user.type(entry.getByLabelText('Poids moyen (g, facultatif)'), '42,5');
    const record = entry.getByRole('button', { name: 'Enregistrer l’entrée' });
    await waitFor(() => expect(record).toBeEnabled());
    await user.click(record);
    expect(await screen.findByText(/Entrée enregistrée sur ce téléphone/)).toBeInTheDocument();
    // Le disponible du magasin est net de l'entrée en attente : 1 000 − 800.
    expect(await entry.findByText('Disponibles à l’origine : 200')).toBeInTheDocument();
    expect(
      within(entry.getByLabelText('Animaux en stock')).getByRole('option', {
        name: 'Poussins d’un jour — Magasin ferme (200)',
      }),
    ).toBeInTheDocument();
    await user.type(entry.getByLabelText('Nombre de têtes'), '300');
    expect(entry.getByText(/Plus de têtes que l’origine connue du téléphone/)).toBeInTheDocument();

    const [created, placed] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(created).toMatchObject({
      command_type: 'production.lot.create',
      aggregate_type: 'PRODUCTION_LOT',
      payload: {
        lotType: 'POULET_CHAIR',
        productId: BROILER,
        mainLocationId: BUILDING,
        strain: 'Cobb 500',
      },
    });
    expect(placed).toMatchObject({
      command_type: 'production.lot.record_entry',
      aggregate_type: 'LOT_ENTRY',
      depends_on: [created?.command_id],
      payload: {
        productionLotId: created?.aggregate_id,
        sourceKind: 'INTERNAL_STOCK',
        quantity: 800,
        sourceLocationId: STORE,
        sourceProductId: CHICK,
        sourceStockLotId: SUPPLIER_LOT,
        avgWeightG: 42.5,
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${STORE}:${CHICK}`)).toBe(800);
  });

  it('en ligne : transfert entre lots borné par l’effectif d’origine, retiré de son effectif', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Entrée dans un lot' }));
    const entry = within(screen.getByRole('region', { name: 'Entrée dans un lot' }));
    // Une destination choisie pour un lot ne suit pas le changement de lot.
    await user.selectOptions(entry.getByLabelText('Vers le bâtiment ou la case'), BUILDING_2);
    await user.selectOptions(entry.getByLabelText('Lot'), LOT_B);
    expect(entry.getByLabelText('Vers le bâtiment ou la case')).toHaveValue('');
    await user.click(entry.getByRole('radio', { name: 'Depuis un autre lot' }));
    await user.selectOptions(entry.getByLabelText('Lot d’origine'), LOT_A);
    // Le Bâtiment 2, où le lot d'origine n'a aucune tête, n'est pas proposé.
    const from = entry.getByLabelText('Bâtiment ou case d’origine');
    expect(within(from).queryByRole('option', { name: /Bâtiment 2/ })).not.toBeInTheDocument();
    await user.selectOptions(from, BUILDING);
    expect(entry.getByText('Disponibles à l’origine : 500')).toBeInTheDocument();
    await user.type(entry.getByLabelText('Nombre de têtes'), '600');
    expect(entry.getByRole('alert')).toHaveTextContent(/le serveur refuserait/);
    const record = entry.getByRole('button', { name: 'Enregistrer l’entrée' });
    expect(record).toBeDisabled();
    await user.clear(entry.getByLabelText('Nombre de têtes'));
    await user.type(entry.getByLabelText('Nombre de têtes'), '100');
    await user.click(record);
    await screen.findByText(/Entrée (en cours d’envoi|enregistrée)/);

    const [command] = await getDb().outbox.toArray();
    expect((command?.payload as { toLocationId?: string }).toLocationId).toBeUndefined();
    expect(command).toMatchObject({
      command_type: 'production.lot.record_entry',
      depends_on: [],
      payload: {
        productionLotId: LOT_B,
        sourceKind: 'TRANSFER',
        quantity: 100,
        sourceProductionLotId: LOT_A,
        sourceLocationId: BUILDING,
      },
    });
    const refs = await loadSalesReferences(getDb());
    const lotA = refs.productionLots.find((candidate) => candidate.id === LOT_A);
    expect(lotA && rearingHeadcount(refs, lotA)).toBe(400);
    expect(refs.pending.get(`${BUILDING}:${BROILER}`)).toBe(100);
  });

  it('origines : solde mêlé à un lot de production, réception entamée, bâtiment sans tête', async () => {
    const db = getDb();
    // Bâtiment 1 : 500 têtes du lot A (production) et 50 d'un lot fournisseur ; un reste sans lot.
    await db.projections.put(
      balance(BUILDING, BROILER, [
        { id: STOCK_LOT_A, qty: '500' },
        { id: SUPPLIER_LOT_2, qty: '50' },
      ]),
    );
    await db.projections.put(balance(BUILDING_2, BROILER, [{ id: STOCK_LOT_A, qty: '20' }]));
    const refs = await loadSalesReferences(db);
    const [target] = entryLots(refs, IDS.user).filter((candidate) => candidate.id === LOT_B);
    if (!target) throw new Error('lot B absent');
    const mixed = stockSources(refs, target).find((source) => source.locationId === BUILDING);
    expect(mixed).toMatchObject({ quantity: 50, fifo: false });
    expect(mixed?.lots.map((stockLot) => stockLot.lotId)).toEqual([SUPPLIER_LOT_2]);
    const draft = { ...EMPTY_ENTRY, quantityText: '10', stockSource: `${BUILDING}|${BROILER}` };
    expect(checkEntry(draft, true).issues).toEqual(['SOURCE_REQUIRED']);
    expect(checkEntry({ ...draft, sourceStockLotId: SUPPLIER_LOT_2 }, true).issues).toEqual([]);
    // Reste sans lot à côté du lot de production : source écartée (le serveur prendrait le lot A).
    const untracked = {
      ...balance(BUILDING_2, BROILER, [{ id: STOCK_LOT_A, qty: '20' }]).data,
      qty_on_hand: '30',
    };
    const refsUntracked = {
      ...refs,
      stock: new Map([[`${BUILDING_2}:${BROILER}`, untracked as never]]),
    };
    expect(stockSources(refsUntracked, target)).toEqual([]);

    // Lot A : têtes au Bâtiment 1 et au Bâtiment 2 ; un bâtiment sans solde n'est pas proposé.
    const lotA = refs.productionLots.find((candidate) => candidate.id === LOT_A);
    if (!lotA) throw new Error('lot A absent');
    expect(sourceLocations(refs, lotA).map((entry) => [entry.location.id, entry.heads])).toEqual([
      [BUILDING, 500],
      [BUILDING_2, 20],
    ]);

    // Réception de 1 000 poussins dont 600 déjà mis en place (solde du lot fournisseur : 400).
    const receipt = {
      location_id: STORE,
      lines: [
        {
          id: 'l1',
          po_line_id: null,
          product_id: CHICK,
          qty_delivered_base: '1000',
          qty_rejected_base: '0',
          qty_accepted_base: '1000',
          stock_lot_id: SUPPLIER_LOT,
        },
        {
          id: 'l2',
          po_line_id: null,
          product_id: IDS.eggs,
          qty_delivered_base: '30',
          qty_rejected_base: '0',
          qty_accepted_base: '30',
          stock_lot_id: null,
        },
      ],
    };
    const placed = {
      ...refs,
      stock: new Map([
        [
          `${STORE}:${CHICK}`,
          balance(STORE, CHICK, [{ id: SUPPLIER_LOT, qty: '400' }]).data as never,
        ],
      ]),
      // Une vente de 100 poussins en attente, sans lot désigné (le serveur la prend au plus ancien).
      pendingOut: new Map([[`${STORE}:${CHICK}`, 100]]),
      pendingLots: new Map<string, number>(),
    };
    expect(receiptAvailable(placed, receipt, CHICK)).toBe(300);
    // Sans le solde sur l'appareil : l'accepté, moins l'attente.
    expect(receiptAvailable({ ...placed, stock: new Map() }, receipt, CHICK)).toBe(900);
    // Les œufs ne sont pas des animaux de l'espèce du lot.
    expect(receiptProducts(placed, receipt, target)).toEqual([CHICK]);
    const emptied = { ...placed, pendingOut: new Map([[`${STORE}:${CHICK}`, 400]]) };
    expect(receiptProducts(emptied, receipt, target)).toEqual([]);
    // Réception épuisée (lot fournisseur à 0) : une autre réception en attente sur le même
    // emplacement (entrée) ne la regonfle pas.
    const exhausted = {
      ...placed,
      stock: new Map([
        [
          `${STORE}:${CHICK}`,
          balance(STORE, CHICK, [{ id: SUPPLIER_LOT, qty: '0' }]).data as never,
        ],
      ]),
      pendingOut: new Map<string, number>(),
    };
    expect(receiptAvailable(exhausted, receipt, CHICK)).toBe(0);
    // Mise en place en attente qui désigne le lot fournisseur : retranchée de ce lot seulement.
    const designated = {
      ...placed,
      pendingOut: new Map([[`${STORE}:${CHICK}`, 150]]),
      pendingLots: new Map([[`${STORE}:${CHICK}:${SUPPLIER_LOT}`, 150]]),
    };
    expect(receiptAvailable(designated, receipt, CHICK)).toBe(250);
  });

  it('stock libre : attente par lot désigné, et attente du lot de production non retirée deux fois', async () => {
    const db = getDb();
    // Bâtiment 1 : 100 têtes du lot A (production) et 50 du lot fournisseur 2.
    await db.projections.put(
      balance(BUILDING, BROILER, [
        { id: STOCK_LOT_A, qty: '100' },
        { id: SUPPLIER_LOT_2, qty: '50' },
      ]),
    );
    // Magasin : deux lots fournisseurs de 500 poussins.
    await db.projections.put(
      balance(STORE, CHICK, [
        { id: SUPPLIER_LOT, qty: '500' },
        { id: SUPPLIER_LOT_2, qty: '500' },
      ]),
    );
    const base = await loadSalesReferences(db);
    const [target] = entryLots(base, IDS.user).filter((candidate) => candidate.id === LOT_B);
    if (!target) throw new Error('lot B absent');
    // 30 morts en attente sur le lot A au bâtiment 1 : le lot fournisseur 2 garde ses 50 têtes.
    const deaths = {
      ...base,
      pending: new Map([[`${BUILDING}:${BROILER}`, 30]]),
      pendingLots: new Map([[`${BUILDING}:${BROILER}:${STOCK_LOT_A}`, 30]]),
    };
    expect(
      stockSources(deaths, target).find((source) => source.locationId === BUILDING),
    ).toMatchObject({ quantity: 50, lots: [{ lotId: SUPPLIER_LOT_2, quantity: 50 }] });
    // Mise en place de 500 en attente sur le lot fournisseur 1 : il disparaît, le 2 reste à 500.
    const placedLot = {
      ...base,
      pending: new Map([[`${STORE}:${CHICK}`, 500]]),
      pendingLots: new Map([[`${STORE}:${CHICK}:${SUPPLIER_LOT}`, 500]]),
    };
    expect(
      stockSources(placedLot, target).find((source) => source.locationId === STORE)?.lots,
    ).toEqual([{ lotId: SUPPLIER_LOT_2, lotCode: 'L-500', quantity: 500 }]);
  });

  it('lots créés sur une tablette partagée : seuls ceux de l’utilisateur reçoivent ses entrées', async () => {
    const refs = await loadSalesReferences(getDb());
    const create = (author: string, id: string) =>
      ({
        command_id: `c-${id}`,
        device_seq: 1,
        command_type: 'production.lot.create',
        command_version: 1,
        author_user_id: author,
        aggregate_type: 'PRODUCTION_LOT',
        aggregate_id: id,
        base_version: null,
        depends_on: [],
        occurred_at: '2026-10-10T08:00:00.000Z',
        client_created_at: '2026-10-10T08:00:00.000Z',
        captured_offline: true,
        backdated_reason: null,
        attachment_ids: [],
        payload: { lotType: 'POULET_CHAIR', productId: BROILER, mainLocationId: BUILDING },
        status: 'LOCAL_ONLY',
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
        server_refs: null,
      }) as const;
    const lots = entryLots(
      { ...refs, outbox: [create(IDS.user, 'mien'), create(OTHER_USER, 'autre')] },
      IDS.user,
    ).map((candidate) => candidate.id);
    expect(lots).toContain('mien');
    expect(lots).not.toContain('autre');
  });
});

describe('Nouveau lot : règles du domaine', () => {
  const p = (id: string, species: string | null, overrides: Partial<ProductData> = {}) =>
    ({
      id,
      code: id,
      name: id,
      category_id: 'c',
      base_unit_code: 'U',
      lot_tracking: 'REQUIRED',
      stock_family: 'BIOLOGIQUE',
      is_sellable: true,
      pricing_mode: 'PER_UNIT',
      status: 'ACTIVE',
      species,
      ...overrides,
    }) as ProductData;

  it('produit de l’espèce du type de lot, biologique, actif et suivi par lot ; dates ordonnées', () => {
    const products = [
      p('poule', 'PONDEUSE'),
      p('porc', 'PORC'),
      p('sans-lot', 'PORC', { lot_tracking: 'NONE' }),
      p('inactif', 'PORC', { status: 'INACTIVE' }),
    ];
    expect(lotProducts(products, 'PORC_ENGRAISSEMENT').map((x) => x.id)).toEqual(['porc']);
    expect(lotProducts(products, 'REPRODUCTEUR_VOLAILLE').map((x) => x.id)).toEqual(['poule']);
    const draft = {
      siteId: 'f',
      lotType: 'PONDEUSE' as const,
      productId: 'poule',
      mainLocationId: 'b',
      parentLotId: '',
      supplierId: '',
      strain: '',
      plannedStartDate: '2026-11-01',
      plannedEndDate: '2026-10-01',
      notes: '',
    };
    expect(checkLotDraft(draft)).toEqual(['DATES_INVALID']);
  });

  it('naissance seulement pour des porcelets rattachés à des truies ; sevrage vers l’engraissement', () => {
    const sows = {
      id: 'truies',
      lot_code: 'LOT-T',
      lot_type: 'PORC_NAISSAGE',
      product_id: 'porc',
      stock_lot_id: 's',
      site_id: 'f',
      main_location_id: 'b',
      parent_lot_id: null,
      strain: null,
      status: 'ACTIVE',
      start_date: '2026-01-01',
      planned_end_date: null,
      initial_quantity: null,
      occurred_at: '2026-01-01T00:00:00.000Z',
    } as ProductionLotData;
    const target = (lotType: EntryLot['lotType'], parentLotId: string | null): EntryLot => ({
      id: 'cible',
      lotCode: 'LOT-C',
      lotType,
      productId: 'porc',
      siteId: 'f',
      mainLocationId: 'b',
      parentLotId,
      status: 'PLANNED',
      createCommandId: null,
    });
    expect(allowedKinds(target('PORC_NAISSAGE', 'truies'), [sows])).toContain('BIRTH');
    // Truies seulement planifiées : naissance refusée en ligne, admise hors ligne (en conflit).
    const planned = { ...sows, status: 'PLANNED' };
    expect(allowedKinds(target('PORC_NAISSAGE', 'truies'), [planned])).not.toContain('BIRTH');
    expect(allowedKinds(target('PORC_NAISSAGE', 'truies'), [planned], false)).toContain('BIRTH');
    expect(allowedKinds(target('PORC_NAISSAGE', null), [sows])).not.toContain('BIRTH');
    expect(allowedKinds(target('PORC_ENGRAISSEMENT', null), [sows])).toContain('WEANING');
    expect(allowedKinds(target('POULET_CHAIR', null), [sows])).toEqual([
      'INTERNAL_STOCK',
      'PURCHASE',
    ]);
  });
});

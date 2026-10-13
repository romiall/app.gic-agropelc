import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { loadSalesReferences } from '../sales/references.js';
import { allocationRow, IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { checkLoss } from './loss.js';
import { LossScreen } from './LossScreen.js';
import { parseReceived } from './receive.js';

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

describe('Déclarer une perte (ECR-STK-04)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put({
      key: 'reason_code:REASON_CODE:r-casse',
      dataset: 'reason_code',
      entity_type: 'REASON_CODE',
      entity_id: 'r-casse',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: {
        id: 'r-casse',
        category: 'LOSS',
        code: 'CHUTE',
        label: 'Chute en manutention',
        loss_category: 'CASSE',
        requires_comment: false,
        is_active: true,
      },
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : perte en conditionnement convertie en unité de base, retirée du disponible local', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '2');
    await user.selectOptions(screen.getByLabelText('Unité'), 'PLATEAU');
    await user.click(screen.getByLabelText('Casse'));
    await user.selectOptions(screen.getByLabelText('Motif'), 'r-casse');
    await user.click(screen.getByRole('button', { name: 'Déclarer la perte' }));
    expect(await screen.findByText(/Perte enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.loss.declare',
      aggregate_type: 'STOCK_LOSS',
      captured_offline: true,
      payload: {
        locationId: IDS.pos,
        productId: IDS.eggs,
        quantityBase: 60,
        unitCode: 'PLATEAU',
        quantity: 2,
        category: 'CASSE',
        reasonCodeId: 'r-casse',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(60);
  });

  it('éclosoir : le lot d’incubation se désigne (présélectionné s’il est seul)', async () => {
    const db = getDb();
    const HATCHER = '01900000-0000-7000-8000-0000000008f1';
    const projection = (dataset: string, type: string, id: string, data: object, key?: string) => ({
      key: key ?? `${dataset}:${type}:${id}`,
      dataset,
      entity_type: type,
      entity_id: id,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: { id, ...data } as Record<string, unknown>,
    });
    const eggs = (lots: { id: string; qty: string }[]) =>
      projection(
        'stock',
        'STOCK_BALANCE',
        IDS.eggs,
        {
          location_id: HATCHER,
          product_id: IDS.eggs,
          qty_on_hand: String(lots.reduce((sum, lot) => sum + Number(lot.qty), 0)),
          qty_reserved: '0',
          qty_allocated: '0',
          lots: lots.map((lot) => ({ lot_id: lot.id, lot_code: lot.id, qty_on_hand: lot.qty })),
        },
        `stock:STOCK_BALANCE:${HATCHER}:${IDS.eggs}`,
      );
    await db.projections.bulkPut([
      projection('location', 'LOCATION', HATCHER, {
        site_id: IDS.site,
        code: 'ECL-1',
        name: 'Éclosoir 1',
        location_type: 'HATCHER',
        is_virtual: false,
        custody_mode: 'SHARED',
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      }),
      eggs([
        { id: 'INC-1', qty: '100' },
        { id: 'INC-2', qty: '80' },
      ]),
    ]);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Emplacement'), HATCHER);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '10');
    await user.click(screen.getByLabelText('Casse'));
    await user.selectOptions(screen.getByLabelText('Motif'), 'r-casse');
    // Deux lots d'incubation : le lot se désigne avant de déclarer.
    expect(screen.getByText(/désignez le lot d’incubation touché/)).toBeInTheDocument();
    expect(screen.getByLabelText('Lot')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Lot')).toHaveAccessibleDescription(
      /désignez le lot d’incubation touché/,
    );
    const declare = screen.getByRole('button', { name: 'Déclarer la perte' });
    expect(declare).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Lot'), 'INC-2');
    await user.click(declare);
    expect(await screen.findByText(/Perte enregistrée sur ce téléphone/)).toBeInTheDocument();
    const [command] = await getDb().outbox.toArray();
    expect(command?.payload).toMatchObject({ locationId: HATCHER, lotId: 'INC-2' });
  });

  it('incubateur avec un lot démarré par un autre utilisateur, en attente : pas de présélection, perte possible sur le lot choisi', async () => {
    const db = getDb();
    const INCUBATOR = '01900000-0000-7000-8000-0000000008f2';
    const projection = (dataset: string, type: string, id: string, data: object, key?: string) => ({
      key: key ?? `${dataset}:${type}:${id}`,
      dataset,
      entity_type: type,
      entity_id: id,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: { id, ...data } as Record<string, unknown>,
    });
    await db.projections.bulkPut([
      projection('location', 'LOCATION', INCUBATOR, {
        site_id: IDS.site,
        code: 'INC-1',
        name: 'Incubateur 1',
        location_type: 'INCUBATOR',
        is_virtual: false,
        custody_mode: 'SHARED',
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      }),
      // Lot A synchronisé : son lot de stock est connu de l'appareil.
      projection(
        'stock',
        'STOCK_BALANCE',
        IDS.eggs,
        {
          location_id: INCUBATOR,
          product_id: IDS.eggs,
          qty_on_hand: '200',
          qty_reserved: '0',
          qty_allocated: '0',
          lots: [{ lot_id: 'LOT-A', lot_code: 'INC-A', qty_on_hand: '200' }],
        },
        `stock:STOCK_BALANCE:${INCUBATOR}:${IDS.eggs}`,
      ),
    ]);
    // Lot B démarré sur ce téléphone par un autre utilisateur, pas encore envoyé (il ne part qu'à sa
    // reconnexion) : son lot de stock sera créé par le serveur.
    await db.outbox.add({
      command_id: '01900000-0000-7000-8000-0000000008f3',
      device_seq: 1,
      command_type: 'production.incubation.start',
      command_version: 1,
      author_user_id: '01900000-0000-7000-8000-0000000000e9',
      aggregate_type: 'INCUBATION_BATCH',
      aggregate_id: '01900000-0000-7000-8000-0000000008f4',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T08:00:00.000Z',
      client_created_at: '2026-10-10T08:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: { incubatorLocationId: INCUBATOR, eggProductId: IDS.eggs, eggsSet: 100 },
      status: 'LOCAL_ONLY',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Emplacement'), INCUBATOR);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '10');
    await user.click(screen.getByLabelText('Casse'));
    await user.selectOptions(screen.getByLabelText('Motif'), 'r-casse');
    // Le seul lot connu n'est pas présélectionné : la casse peut venir du lot récent.
    const lot = screen.getByLabelText('Lot');
    expect(lot).toHaveValue('');
    expect(screen.getByText(/n’a pas encore de lot de stock/)).toHaveAttribute('role', 'status');
    expect(lot).toHaveAccessibleDescription(/n’a pas encore de lot de stock/);
    const declare = screen.getByRole('button', { name: 'Déclarer la perte' });
    expect(declare).toBeDisabled();
    // Lot choisi explicitement : la perte part (pas de blocage jusqu'au retour de l'autre utilisateur).
    await user.selectOptions(lot, 'LOT-A');
    expect(declare).toBeEnabled();
    await user.click(declare);
    expect(await screen.findByText(/Perte enregistrée sur ce téléphone/)).toBeInTheDocument();
    const loss = (await getDb().outbox.toArray()).find(
      (command) => command.command_type === 'inventory.loss.declare',
    );
    expect(loss?.payload).toMatchObject({ locationId: INCUBATOR, lotId: 'LOT-A' });
  });

  it('éclosoir : lot d’incubation transféré en attente proposé sous son numéro, sans présélection de l’autre lot', async () => {
    const db = getDb();
    const INCUBATOR = '01900000-0000-7000-8000-0000000008f5';
    const HATCHER = '01900000-0000-7000-8000-0000000008f6';
    const BATCH = '01900000-0000-7000-8000-0000000008f7';
    const projection = (dataset: string, type: string, id: string, data: object, key?: string) => ({
      key: key ?? `${dataset}:${type}:${id}`,
      dataset,
      entity_type: type,
      entity_id: id,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: { id, ...data } as Record<string, unknown>,
    });
    const place = (id: string, name: string, type: string) =>
      projection('location', 'LOCATION', id, {
        site_id: IDS.site,
        code: name,
        name,
        location_type: type,
        is_virtual: false,
        custody_mode: 'SHARED',
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      });
    await db.projections.bulkPut([
      place(INCUBATOR, 'Incubateur 2', 'INCUBATOR'),
      place(HATCHER, 'Éclosoir 2', 'HATCHER'),
      // L'éclosoir porte le lot A ; le lot B (téléchargé, en incubateur au jeu) y est transféré
      // hors ligne : le stock de l'éclosoir ne le porte pas encore.
      projection(
        'stock',
        'STOCK_BALANCE',
        IDS.eggs,
        {
          location_id: HATCHER,
          product_id: IDS.eggs,
          qty_on_hand: '150',
          qty_reserved: '0',
          qty_allocated: '0',
          lots: [{ lot_id: 'LOT-A', lot_code: 'INC-A', qty_on_hand: '150' }],
        },
        `stock:STOCK_BALANCE:${HATCHER}:${IDS.eggs}`,
      ),
      projection('production', 'INCUBATION_BATCH', BATCH, {
        batch_code: 'INC-B',
        stock_lot_id: 'LOT-B',
        site_id: IDS.site,
        species: 'POULE',
        egg_product_id: IDS.eggs,
        chick_product_id: IDS.chicken,
        incubator_location_id: INCUBATOR,
        hatcher_location_id: null,
        egg_source: 'INTERNAL',
        eggs_set_qty: 300,
        set_at: '2026-09-20T08:00:00.000Z',
        expected_candling_date: '2026-09-27',
        expected_transfer_date: '2026-10-08',
        expected_hatch_date: '2026-10-11',
        infertile_qty: 0,
        early_dead_qty: 0,
        accidental_loss_qty: 0,
        transferred_qty: null,
        status: 'INCUBATING',
      }),
    ]);
    await db.outbox.add({
      command_id: '01900000-0000-7000-8000-0000000008f8',
      device_seq: 1,
      command_type: 'production.incubation.transfer_to_hatcher',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'INCUBATION_EVENT',
      aggregate_id: '01900000-0000-7000-8000-0000000008f9',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T08:00:00.000Z',
      client_created_at: '2026-10-10T08:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: { batchId: BATCH, hatcherLocationId: HATCHER },
      status: 'LOCAL_ONLY',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Emplacement'), HATCHER);
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    const lot = screen.getByLabelText('Lot');
    // Deux lots proposés : celui du solde, et le lot transféré en attente ; aucun présélectionné.
    expect(lot).toHaveValue('');
    expect(
      within(lot).getByRole('option', { name: 'INC-B · stock à mettre à jour' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Quantité'), '10');
    await user.click(screen.getByLabelText('Casse'));
    await user.selectOptions(screen.getByLabelText('Motif'), 'r-casse');
    await user.selectOptions(lot, 'LOT-B');
    await user.click(screen.getByRole('button', { name: 'Déclarer la perte' }));
    expect(await screen.findByText(/Perte enregistrée sur ce téléphone/)).toBeInTheDocument();
    const loss = (await getDb().outbox.toArray()).find(
      (command) => command.command_type === 'inventory.loss.declare',
    );
    expect(loss?.payload).toMatchObject({ locationId: HATCHER, lotId: 'LOT-B' });
  });

  it('au-delà du disponible : bloquée en ligne (BR-STK-017), signalée hors ligne (BR-STK-018)', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    // 4 poulets en stock.
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '5');
    await user.click(screen.getByLabelText('Casse'));
    expect(screen.getByRole('alert')).toHaveTextContent(/le serveur refuserait la perte/);
    expect(screen.getByRole('button', { name: 'Déclarer la perte' })).toBeDisabled();
    unmount();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '5');
    await user.click(screen.getByLabelText('Casse'));
    expect(screen.getByText(/sera tout de même enregistrée et signalée/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déclarer la perte' })).toBeEnabled();
  });

  it('hors ligne, détenteur d’un quota : perte au-delà du reste signalée, jamais refusée (AV-231)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().projections.put(
      allocationRow({ quantity_remaining: '30.000', valid_until: null }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '31');
    await user.click(screen.getByLabelText('Casse'));
    await user.selectOptions(screen.getByLabelText('Motif'), 'r-casse');
    const signal = screen.getByText(/la sortie est enregistrée et le serveur la signalera/);
    expect(signal).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('Quantité').getAttribute('aria-describedby')).toContain(signal.id);
    expect(screen.getByRole('button', { name: 'Déclarer la perte' })).toBeEnabled();
    // Au-delà du stock aussi : un seul message, celui de la garde.
    const quantity = screen.getByLabelText('Quantité');
    await user.clear(quantity);
    await user.type(quantity, '301');
    expect(
      screen.getByText(/la sortie est enregistrée et le serveur la signalera/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sera tout de même enregistrée et signalée/)).not.toBeInTheDocument();
  });

  it('en ligne, emplacement partagé entièrement alloué : la perte reste possible sur le physique', async () => {
    const db = getDb();
    const key = `stock:STOCK_BALANCE:${IDS.pos}:${IDS.eggs}`;
    const balance = await db.projections.get(key);
    if (!balance) throw new Error('solde de la fixture absent');
    await db.projections.put({
      ...balance,
      data: { ...balance.data, qty_allocated: '300.000' },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '5');
    await user.click(screen.getByLabelText('Casse'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déclarer la perte' })).toBeEnabled();
  });

  it('quantité hors de la borne numeric(14,3) : refusée sur l’appareil', () => {
    const draft = {
      productId: IDS.eggs,
      unitCode: 'PLATEAU',
      quantityText: '9999999999',
      category: 'CASSE' as const,
      reasonCodeId: '',
      lotId: '',
      comment: '',
    };
    expect(checkLoss(draft, { unitCode: 'PLATEAU', factorToBase: '30' }, []).issues).toEqual([
      'QUANTITY_INVALID',
    ]);
    expect(parseReceived('100000000000')).toBeNull();
    expect(parseReceived('99999999999.999')).toBe(99_999_999_999.999);
  });

  it('perte inexpliquée : commentaire obligatoire', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '1');
    await user.click(screen.getByLabelText('Perte inexpliquée'));
    expect(
      screen.getByText('Un commentaire est obligatoire pour cette perte.'),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Déclarer la perte' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Commentaire'), 'Constaté à l’ouverture');
    expect(submit).toBeEnabled();
  });
});

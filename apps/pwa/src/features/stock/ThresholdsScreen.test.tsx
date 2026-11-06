import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { ThresholdsScreen } from './ThresholdsScreen.js';
import { checkThreshold, parseThreshold, thresholdRows } from './thresholds.js';
import { loadSalesReferences } from '../sales/references.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-11-06T09:00:00.000Z'));
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

const STORE = '01900000-0000-7000-8000-0000000007a1';
const FEED = '01900000-0000-7000-8000-0000000007a2';
const MEDS = '01900000-0000-7000-8000-0000000007a3';
const THRESHOLD = '01900000-0000-7000-8000-0000000007a4';

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

const product = (id: string, name: string) =>
  projection('product', 'PRODUCT', id, {
    code: name.slice(0, 4).toUpperCase(),
    name,
    category_id: IDS.zone,
    base_unit_code: 'KG',
    is_sellable: false,
    pricing_mode: 'PER_UNIT',
    status: 'ACTIVE',
    stock_family: 'INTRANT',
    is_consumable: true,
    lot_tracking: 'NONE',
  });

const balance = (productId: string, quantity: string) =>
  projection(
    'stock',
    'STOCK_BALANCE',
    `${STORE}:${productId}`,
    {
      location_id: STORE,
      product_id: productId,
      qty_on_hand: quantity,
      qty_reserved: '0',
      qty_allocated: '0',
      lots: [],
    },
    `stock:STOCK_BALANCE:${STORE}:${productId}`,
  );

describe('Seuils d’alerte (ECR-STK-09, AV-526)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('location', 'LOCATION', STORE, {
        site_id: IDS.site,
        code: 'MAG',
        name: 'Magasin ferme',
        location_type: 'STORE',
        is_virtual: false,
        custody_mode: 'SHARED',
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      }),
      product(FEED, 'Aliment démarrage'),
      product(MEDS, 'Vitamines'),
      balance(FEED, '200.000'),
      balance(MEDS, '10.000'),
      projection('stock', 'STOCK_THRESHOLD', THRESHOLD, {
        location_id: STORE,
        product_id: MEDS,
        min_qty_base: '20.000',
        target_qty_base: '50.000',
        is_active: true,
      }),
    ]);
  });

  afterEach(async () => {
    cleanup();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('parseThreshold et checkThreshold : nombres positifs ou nuls, trois décimales, cible au moins égale au minimum', () => {
    expect(parseThreshold('12,5')).toBe(12.5);
    expect(parseThreshold('1 000')).toBe(1000);
    expect(parseThreshold('0')).toBe(0);
    expect(parseThreshold('')).toBeNull();
    expect(parseThreshold('-1')).toBeNull();
    expect(parseThreshold('1,2345')).toBeNull();
    expect(parseThreshold('1000000001')).toBeNull();
    expect(checkThreshold('50', '30').issues).toEqual(['TARGET_BELOW_MIN']);
    expect(checkThreshold('', '30').issues).toEqual(['MIN_INVALID']);
    expect(checkThreshold('10', '30').values).toEqual({ min: 10, target: 30 });
  });

  it('thresholdRows : produits en stock et produits avec seuil, par nom', async () => {
    const refs = await loadSalesReferences(getDb());
    const rows = thresholdRows(refs, STORE);
    expect(rows.map((row) => row.product.name)).toEqual(['Aliment démarrage', 'Vitamines']);
    expect(rows[0]!.threshold).toBeNull();
    expect(rows[1]!.threshold?.min_qty_base).toBe('20.000');
    expect(rows[1]!.onHand).toBe(10);
  });

  it('liste les produits et leur seuil, « Pas de seuil » pour un produit sans réglage', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ThresholdsScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Emplacement'), STORE);
    const feed = (await screen.findByText('Aliment démarrage')).closest('li')!;
    expect(within(feed).getByText('Pas de seuil')).toBeInTheDocument();
    expect(within(feed).getByRole('button', { name: 'Fixer' })).toBeInTheDocument();
    const meds = screen.getByText('Vitamines').closest('li')!;
    expect(within(meds).getByText(/Minimum 20 · cible 50/)).toBeInTheDocument();
    expect(within(meds).getByRole('button', { name: 'Modifier' })).toBeInTheDocument();
  });

  it('fixer un seuil : la cible sous le minimum est refusée, puis la commande part dans l’outbox', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ThresholdsScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Emplacement'), STORE);
    const feed = (await screen.findByText('Aliment démarrage')).closest('li')!;
    await user.click(within(feed).getByRole('button', { name: 'Fixer' }));
    const sheet = within(await screen.findByRole('dialog'));
    await user.type(sheet.getByLabelText('Minimum d’alerte'), '50');
    await user.type(sheet.getByLabelText('Cible de réapprovisionnement'), '30');
    expect(sheet.getByText('La cible doit être au moins égale au minimum.')).toBeInTheDocument();
    const save = sheet.getByRole('button', { name: 'Enregistrer le seuil' });
    expect(save).toBeDisabled();
    await user.clear(sheet.getByLabelText('Cible de réapprovisionnement'));
    await user.type(sheet.getByLabelText('Cible de réapprovisionnement'), '200');
    expect(save).toBeEnabled();
    await user.click(save);
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.threshold.set',
      aggregate_type: 'STOCK_THRESHOLD',
      payload: { locationId: STORE, productId: FEED, minQtyBase: 50, targetQtyBase: 200 },
    });
    expect(
      await screen.findByText(/Seuil enregistré sur ce téléphone|Seuil en cours d’envoi/),
    ).toBeInTheDocument();
  });

  it('modifier un seuil : les valeurs actuelles sont reprises', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ThresholdsScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Emplacement'), STORE);
    const meds = (await screen.findByText('Vitamines')).closest('li')!;
    await user.click(within(meds).getByRole('button', { name: 'Modifier' }));
    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByLabelText('Minimum d’alerte')).toHaveValue('20');
    expect(sheet.getByLabelText('Cible de réapprovisionnement')).toHaveValue('50');
    expect(sheet.getByText('Le seuil actuel reste à l’historique')).toBeInTheDocument();
  });
});

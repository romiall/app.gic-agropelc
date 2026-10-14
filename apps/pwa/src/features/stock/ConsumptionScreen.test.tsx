import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { allocationRow, IDS, seedSalesFixtures, stockRow } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { ConsumptionScreen } from './ConsumptionScreen.js';

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

const CARTON = '01900000-0000-7000-8000-0000000008c1';
const PACK = '01900000-0000-7000-8000-0000000008c2';

function projection(dataset: string, type: string, id: string, data: object) {
  return {
    key: `${dataset}:${type}:${id}`,
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

function renderScreen() {
  return render(
    <MemoryRouter>
      <ConsumptionScreen />
    </MemoryRouter>,
  );
}

describe('Consommer un intrant (ECR-STK-08)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('product', 'PRODUCT', CARTON, {
        code: 'CARTON-30',
        name: 'Carton de 30 œufs',
        category_id: IDS.zone,
        base_unit_code: 'U',
        is_sellable: false,
        is_consumable: true,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
        stock_family: 'EMBALLAGE_CONSOMMABLE',
        lot_tracking: 'NONE',
      }),
      projection('product_unit', 'PRODUCT_UNIT', PACK, {
        product_id: CARTON,
        unit_code: 'PAQUET',
        factor_to_base: '25.000000',
        is_sales_unit: true,
        is_active: true,
      }),
      stockRow(IDS.pos, CARTON, '100'),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : consommation en conditionnement imputée au site, retirée du disponible', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    const product = await screen.findByLabelText('Intrant');
    // Les œufs et le poulet, en stock mais non consommables, ne sont pas proposés.
    expect(within(product).queryByText('Œufs de table')).not.toBeInTheDocument();
    expect(within(product).queryByText('Poulet de chair')).not.toBeInTheDocument();
    await user.selectOptions(product, CARTON);
    await user.type(screen.getByLabelText('Quantité'), '1');
    await user.selectOptions(screen.getByLabelText('Unité'), 'PAQUET');
    const submit = screen.getByRole('button', { name: 'Enregistrer la consommation' });
    expect(submit).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Nature du coût'), 'AUTRE_INTRANT');
    await user.click(submit);
    expect(
      await screen.findByText(/Consommation enregistrée sur ce téléphone/),
    ).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.consumption.record',
      aggregate_type: 'STOCK_CONSUMPTION',
      captured_offline: true,
      payload: {
        locationId: IDS.pos,
        productId: CARTON,
        quantityBase: 25,
        unitCode: 'PAQUET',
        quantity: 1,
        costObjectType: 'SITE',
        costObjectId: IDS.site,
        costType: 'AUTRE_INTRANT',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${CARTON}`)).toBe(25);
  });

  it('hors ligne, détenteur d’un quota : au-delà du reste refusée, sans annonce « enregistrée » (BR-STK-013)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().projections.put(
      allocationRow({ product_id: CARTON, quantity_remaining: '30.000', valid_until: null }),
    );
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Intrant'), CARTON);
    await user.selectOptions(screen.getByLabelText('Nature du coût'), 'ALIMENT');
    const quantity = screen.getByLabelText('Quantité');
    await user.type(quantity, '31');
    const refusal = screen.getByText(
      'Carton de 30 œufs : quota dépassé, il vous reste 30 U, 31 U demandé(s).',
    );
    expect(refusal).toHaveAttribute('role', 'status');
    expect(quantity).toHaveAttribute('aria-invalid', 'true');
    expect(quantity.getAttribute('aria-describedby')).toContain(refusal.id);
    const submit = screen.getByRole('button', { name: 'Enregistrer la consommation' });
    expect(submit).toBeDisabled();
    // Au-delà du stock aussi : refusée, jamais annoncée « enregistrée ».
    await user.clear(quantity);
    await user.type(quantity, '101');
    expect(
      screen.getByText(/quota dépassé, il vous reste 30 U, 101 U demandé/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sera tout de même enregistrée/)).not.toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '30');
    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.queryByText(/quota dépassé/)).not.toBeInTheDocument();
  });

  it('en ligne, détenteur d’un quota : pas de garde hors ligne, seul le disponible compte', async () => {
    await getDb().projections.put(
      allocationRow({ product_id: CARTON, quantity_remaining: '30.000', valid_until: null }),
    );
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Intrant'), CARTON);
    await user.selectOptions(screen.getByLabelText('Nature du coût'), 'ALIMENT');
    await user.type(screen.getByLabelText('Quantité'), '31');
    expect(screen.queryByText(/quota dépassé/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Enregistrer la consommation' })).toBeEnabled(),
    );
  });

  it('en ligne : au-delà du stock, consommation bloquée', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Intrant'), CARTON);
    await user.type(screen.getByLabelText('Quantité'), '101');
    await user.selectOptions(screen.getByLabelText('Nature du coût'), 'ALIMENT');
    expect(screen.getByRole('alert')).toHaveTextContent(/le serveur refuserait/);
    expect(screen.getByRole('button', { name: 'Enregistrer la consommation' })).toBeDisabled();
  });
});

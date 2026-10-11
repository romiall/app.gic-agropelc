import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { RequestScreen } from './RequestScreen.js';

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

const FEED = '01900000-0000-7000-8000-0000000006a1';
const SACK = '01900000-0000-7000-8000-0000000006a2';

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

const request = (id: string, requestedBy: string, doc: string, status: string) =>
  projection('procurement', 'PURCHASE_REQUEST', id, {
    doc_number: doc,
    site_id: IDS.site,
    requested_by: requestedBy,
    justification: `Réassort ${doc}`,
    needed_by_date: null,
    status,
    estimated_total_xaf: null,
    occurred_at: '2026-10-08T08:00:00.000Z',
    lines: [],
  });

function renderScreen() {
  return render(
    <MemoryRouter>
      <RequestScreen />
    </MemoryRouter>,
  );
}

describe('Demande d’achat (ECR-APP-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('product', 'PRODUCT', FEED, {
        code: 'ALIM-DEM',
        name: 'Aliment démarrage',
        category_id: IDS.zone,
        base_unit_code: 'KG',
        is_sellable: false,
        is_purchasable: true,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
        stock_family: 'INTRANT',
        lot_tracking: 'NONE',
      }),
      projection('product_unit', 'PRODUCT_UNIT', SACK, {
        product_id: FEED,
        unit_code: 'SAC',
        factor_to_base: '50.000000',
        is_sales_unit: false,
        is_purchase_unit: true,
        is_active: true,
      }),
      request('da-1', IDS.user, 'DA-YDE-2026-000001', 'APPROVED'),
      request('da-2', '01900000-0000-7000-8000-0000000000ab', 'DA-YDE-2026-000002', 'SUBMITTED'),
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : demande en conditionnement d’achat, prix estimé par unité de base, listée en attente', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    const mine = within(await screen.findByRole('region', { name: 'Mes demandes' }));
    expect(mine.getByText('DA-YDE-2026-000001')).toBeInTheDocument();
    expect(mine.getByText('Approuvée')).toBeInTheDocument();
    expect(mine.queryByText('DA-YDE-2026-000002')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Justification'), 'Stock d’aliment bas');
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), FEED);
    await user.type(within(line).getByLabelText('Quantité'), '2');
    await user.selectOptions(within(line).getByLabelText('Unité'), 'SAC');
    await user.type(within(line).getByLabelText('Prix estimé par KG (F, facultatif)'), '400');
    fireEvent.change(screen.getByLabelText('Souhaitée pour le (facultatif)'), {
      target: { value: '2026-10-15' },
    });
    await user.click(screen.getByRole('button', { name: 'Soumettre la demande' }));
    expect(await screen.findByText(/Demande enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'procurement.request.submit',
      aggregate_type: 'PURCHASE_REQUEST',
      captured_offline: true,
    });
    expect(command?.payload).toEqual({
      siteId: IDS.site,
      neededByDate: '2026-10-15',
      justification: 'Stock d’aliment bas',
      lines: [
        {
          productId: FEED,
          quantityBase: 100,
          unitCode: 'SAC',
          quantity: 2,
          estimatedUnitPriceXaf: 400,
        },
      ],
    });
    expect(await mine.findByText('En attente d’envoi')).toBeInTheDocument();
  });

  it('date passée et prix non entier refusés', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(await screen.findByLabelText('Justification'), 'Réassort');
    const line = screen.getByRole('listitem', { name: 'Ligne 1' });
    await user.selectOptions(within(line).getByLabelText('Produit'), FEED);
    await user.type(within(line).getByLabelText('Quantité'), '10');
    await user.type(within(line).getByLabelText('Prix estimé par KG (F, facultatif)'), '12,5');
    expect(within(line).getByText('Prix estimé : nombre entier de francs.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Souhaitée pour le (facultatif)'), {
      target: { value: '2026-10-01' },
    });
    expect(screen.getByText('La date souhaitée ne peut pas être passée.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Soumettre la demande' })).toBeDisabled();
  });
});

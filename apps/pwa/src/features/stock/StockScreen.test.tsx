import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { routeOfAction } from '../../app/screens.js';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { stockKey } from '../sales/stock.js';
import type { LocationData, StockTransferData } from '../sales/types.js';
import { StockScreen } from './StockScreen.js';
import { inTransitTo, receivingTransferIds, stockRows } from './stock-view.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
    deviceId: undefined,
  }),
}));

const USER = '01900000-0000-7000-8000-000000000001';

function renderAt(path = '/stock') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StockScreen />
    </MemoryRouter>,
  );
}

describe('Stock par emplacement (ECR-STK-01)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    // Seuil du poulet : 4 en stock, minimum 10, cible 20 → sous le seuil, 16 à commander.
    await db.projections.put({
      key: 'stock:STOCK_THRESHOLD:th-1',
      dataset: 'stock',
      entity_type: 'STOCK_THRESHOLD',
      entity_id: 'th-1',
      scope_type: 'LOCATION',
      scope_id: IDS.pos,
      row_version: 1,
      seq: 1,
      data: {
        id: 'th-1',
        location_id: IDS.pos,
        product_id: IDS.chicken,
        min_qty_base: '10.000',
        target_qty_base: '20.000',
        is_active: true,
      },
    });
    // Vente de 30 œufs en attente d'envoi : le disponible en tient compte.
    await db.outbox.put({
      command_id: '01900000-0000-7000-8000-0000000000a9',
      device_seq: 1,
      command_type: 'sales.sale.record',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'SALE',
      aggregate_id: '01900000-0000-7000-8000-0000000000aa',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T09:00:00.000Z',
      client_created_at: '2026-10-10T09:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: { fromLocationId: IDS.pos, lines: [{ productId: IDS.eggs, quantityBase: 30 }] },
      status: 'LOCAL_ONLY',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
  });

  afterEach(async () => {
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('soldes, disponible net des opérations en attente, seuil et réapprovisionnement suggéré', async () => {
    renderAt();
    const eggs = await screen.findByRole('listitem', { name: 'Œufs de table' });
    expect(within(eggs).getByText('300 U')).toBeInTheDocument();
    expect(within(eggs).getByText('270 U')).toBeInTheDocument();
    expect(within(eggs).getByText(/en attente : 30 U/)).toBeInTheDocument();
    // Quotas des appareils non servis (S-05) : rien n'est affiché comme un fait.
    expect(within(eggs).queryByText('Quotas')).not.toBeInTheDocument();
    const chicken = screen.getByRole('listitem', { name: 'Poulet de chair' });
    expect(within(chicken).getByText('Sous le seuil')).toBeInTheDocument();
    expect(within(chicken).getByText(/réapprovisionnement suggéré : 16 U/)).toBeInTheDocument();
  });

  it('unités en libellés courts accordés (MP-09, AV-249), repli sur le nom du catalogue', async () => {
    const db = getDb();
    const withUnit = async (productId: string, unit: string) => {
      const key = `product:PRODUCT:${productId}`;
      const row = (await db.projections.get(key))!;
      await db.projections.put({ ...row, data: { ...row.data, base_unit_code: unit } });
    };
    await withUnit(IDS.eggs, 'PLATEAU');
    await withUnit(IDS.chicken, 'BIDON');
    await db.projections.put({
      key: 'catalog:UNIT:u-bidon',
      dataset: 'catalog',
      entity_type: 'UNIT',
      entity_id: 'u-bidon',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: {
        id: 'u-bidon',
        code: 'BIDON',
        name: 'Bidon de 20 L',
        is_count: true,
        is_active: true,
      },
    });
    renderAt();
    const eggs = await screen.findByRole('listitem', { name: 'Œufs de table' });
    expect(within(eggs).getByText('300 plateaux')).toBeInTheDocument();
    expect(within(eggs).getByText(/en attente : 30 plateaux/)).toBeInTheDocument();
    const chicken = screen.getByRole('listitem', { name: 'Poulet de chair' });
    expect(
      within(chicken).getByText(/réapprovisionnement suggéré : 16 Bidon de 20 L/),
    ).toBeInTheDocument();
    expect(within(chicken).getByText(/Seuil : 10 Bidon de 20 L/)).toBeInTheDocument();
  });

  it('seuil lu sur le solde physique (ADR-033 §10) ; transit dont la réception est saisie exclu', () => {
    const location = { id: 'loc', custody_mode: 'SHARED', is_virtual: false } as LocationData;
    const refs = {
      stock: new Map([
        [
          stockKey('loc', 'p'),
          {
            location_id: 'loc',
            product_id: 'p',
            qty_on_hand: '100.000',
            qty_reserved: '0.000',
            qty_allocated: '80.000',
            lots: [],
          },
        ],
      ]),
      pending: new Map<string, number>(),
      products: [{ id: 'p', name: 'Produit', base_unit_code: 'U' }],
      thresholds: [
        {
          location_id: 'loc',
          product_id: 'p',
          min_qty_base: '30.000',
          target_qty_base: '50.000',
          is_active: true,
        },
      ],
      transfers: new Map(),
      outbox: [],
    } as unknown as Parameters<typeof stockRows>[0];
    const [row] = stockRows(refs, location);
    // Disponible net des quotas : 20 ; physique : 100, au-dessus du minimum de 30.
    expect(row?.available).toBe(20);
    expect(row?.threshold?.state).toBe('OK');

    const transfer = {
      id: 't',
      status: 'DISPATCHED',
      to_location_id: 'loc',
      lines: [{ product_id: 'p', dispatched_qty_base: '60.000', received_qty_base: null }],
    } as unknown as StockTransferData;
    const transfers = new Map([['t', transfer]]);
    expect(inTransitTo(transfers, 'loc').get('p')).toBe(60);
    const receiving = receivingTransferIds([
      {
        command_type: 'inventory.transfer.receive',
        status: 'LOCAL_ONLY',
        payload: { transferId: 't' },
      } as unknown as OutboxCommand,
    ]);
    expect(inTransitTo(transfers, 'loc', receiving).get('p')).toBeUndefined();
  });

  it('action « Alertes de stock » : écran filtré sur les produits sous le seuil', async () => {
    expect(routeOfAction({ code: 'STOCK_ALERTS', route: null })).toBe('/stock?alertes=1');
    renderAt('/stock?alertes=1');
    expect(await screen.findByRole('listitem', { name: 'Poulet de chair' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Œufs de table' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Seulement les produits sous le seuil/));
    expect(screen.getByRole('listitem', { name: 'Œufs de table' })).toBeInTheDocument();
  });

  it('opérations du stock en tête d’écran : toutes si les rôles sont inconnus, celles du rôle sinon', async () => {
    const db = getDb();
    await db.navigation.clear();
    renderAt();
    // Rôles inconnus de l'appareil : tout reste proposé.
    const all = within(await screen.findByRole('navigation', { name: 'Opérations du stock' }));
    expect(all.getByRole('link', { name: 'Transférer' })).toHaveAttribute(
      'href',
      '/stock/transferts',
    );
    expect(all.getByRole('link', { name: 'Registre des mouvements' })).toBeInTheDocument();

    // Vendeur de PDV : il déclare une perte et fait l'inventaire, il ne transfère pas.
    await db.navigation.put({
      user_id: USER,
      full_name: 'Vendeur',
      roles: ['VENDEUR_PDV'],
      sections: [],
      saved_at: '2026-10-10T09:00:00.000Z',
    });
    await waitFor(() =>
      expect(all.queryByRole('link', { name: 'Transférer' })).not.toBeInTheDocument(),
    );
    expect(all.getByRole('link', { name: 'Déclarer une perte' })).toHaveAttribute(
      'href',
      '/stock/perte',
    );
    expect(all.getByRole('link', { name: 'Inventaire' })).toBeInTheDocument();
    expect(all.queryByRole('link', { name: 'Registre des mouvements' })).not.toBeInTheDocument();
    await db.navigation.clear();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { ReceiveTransferScreen } from './ReceiveTransferScreen.js';
import { inTransitTo } from './stock-view.js';

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

const TRANSFER_ID = '01900000-0000-7000-8000-0000000000b9';
const LINE_ID = '01900000-0000-7000-8000-0000000000ba';
const STORE = '01900000-0000-7000-8000-0000000000bb';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/stock/receptions" element={<ReceiveTransferScreen />} />
        <Route path="/stock/receptions/:transferId" element={<ReceiveTransferScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Recevoir un transfert (ECR-STK-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put({
      key: `transfers:STOCK_TRANSFER:${TRANSFER_ID}`,
      dataset: 'transfers',
      entity_type: 'STOCK_TRANSFER',
      entity_id: TRANSFER_ID,
      scope_type: 'LOCATION',
      scope_id: IDS.pos,
      row_version: 1,
      seq: 1,
      data: {
        id: TRANSFER_ID,
        doc_number: 'TRF-2026-000007',
        transfer_kind: 'STANDARD',
        from_location_id: STORE,
        to_location_id: IDS.pos,
        status: 'DISPATCHED',
        dispatched_at: '2026-10-10T07:00:00.000Z',
        carrier_name: 'Jean',
        notes: null,
        occurred_at: '2026-10-10T07:00:00.000Z',
        version: 2,
        lines: [
          {
            id: LINE_ID,
            product_id: IDS.eggs,
            lot_id: null,
            unit_code: 'U',
            requested_qty_base: '60.000',
            dispatched_qty_base: '60.000',
            received_qty_base: null,
          },
        ],
      },
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('transit entrant compté pour le seuil, puis réception hors ligne avec écart, ajoutée au disponible', async () => {
    const before = await loadSalesReferences(getDb());
    expect(inTransitTo(before.transfers, IDS.pos).get(IDS.eggs)).toBe(60);

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    const { unmount } = renderAt('/stock/receptions');
    await user.click(
      await screen.findByRole('link', { name: 'Recevoir le transfert TRF-2026-000007' }),
    );
    const line = await screen.findByRole('listitem', { name: 'Œufs de table' });
    const received = within(line).getByLabelText('Reçu (U)');
    expect(received).toHaveValue('60');
    await user.clear(received);
    await user.type(received, '54');
    expect(within(line).getByText(/Manque : 6 U/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer la réception' }));
    expect(await screen.findByText(/Réception enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.transfer.receive',
      aggregate_type: 'STOCK_TRANSFER',
      aggregate_id: TRANSFER_ID,
      captured_offline: true,
      payload: {
        transferId: TRANSFER_ID,
        lines: [{ transferLineId: LINE_ID, receivedQtyBase: 54 }],
      },
    });
    const after = await loadSalesReferences(getDb());
    expect(after.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(-54);
    unmount();

    // Le transfert n'est pas proposé une seconde fois.
    renderAt('/stock/receptions');
    expect(await screen.findByText('Réception en attente d’envoi')).toBeInTheDocument();
  });

  it('en ligne : un reçu supérieur à l’expédié est bloqué sur l’appareil', async () => {
    const user = userEvent.setup();
    renderAt(`/stock/receptions/${TRANSFER_ID}`);
    const received = await screen.findByLabelText('Reçu (U)');
    await user.clear(received);
    await user.type(received, '61');
    expect(screen.getByText(/dépasse l’expédié : corrigez-la/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la réception' })).toBeDisabled();
  });
});

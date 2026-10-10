import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { resetConnectivityForTests } from '../../platform/connectivity.js';
import { CollectScreen } from './CollectScreen.js';
import { duesFromRecentSales, previewAllocation, sortDues } from './collect.js';
import { IDS, SALE_ID, saleRow, seedSalesFixtures } from './fixtures.js';
import type { SaleData } from './types.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const request = vi.mocked(authorizedRequest);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/encaisser" element={<CollectScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Encaisser une créance (ECR-VEN-06)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    request.mockReset();
    request.mockResolvedValue({ ok: false, reason: 'OFFLINE' });
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put(saleRow());
  });

  afterEach(async () => {
    // Démonter avant de rétablir les simulations : un rendu tardif (lecture suivie) ne doit pas
    // appeler le client API simulé une fois réinitialisé.
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('affectation prévue : échéance la plus ancienne d’abord, le reste en avoir', () => {
    const dues = sortDues([
      {
        saleId: 'b',
        docNumber: 'B',
        dueDate: '2026-11-01',
        occurredAt: '2026-10-02',
        balanceXaf: 3000,
      },
      {
        saleId: 'a',
        docNumber: 'A',
        dueDate: '2026-10-20',
        occurredAt: '2026-10-01',
        balanceXaf: 2000,
      },
    ]);
    expect(dues.map((due) => due.saleId)).toEqual(['a', 'b']);
    const preview = previewAllocation(6000, dues);
    expect(preview.lines.map((line) => [line.due.saleId, line.amountXaf])).toEqual([
      ['a', 2000],
      ['b', 3000],
    ]);
    expect(preview.creditXaf).toBe(1000);
    expect(previewAllocation(0, dues)).toEqual({ lines: [], creditXaf: 0 });
  });

  it('hors ligne : créances des ventes récentes de l’appareil, encaissement mis dans l’outbox', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}`);
    expect(await screen.findByText('Encours du client : 12 000 F CFA')).toBeInTheDocument();
    expect(screen.getByText(/seules les ventes des 7 derniers jours/)).toBeInTheDocument();
    expect(screen.getByText(/VTE-2026-000123/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Montant reçu (F CFA)'), '1500');
    expect(screen.getByText('− 1 500 F CFA')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’encaissement' }));
    expect(
      await screen.findByText(
        'Encaissement enregistré sur ce téléphone, il sera envoyé dès le retour du réseau.',
      ),
    ).toBeInTheDocument();
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'sales.payment.record',
      aggregate_type: 'CUSTOMER_PAYMENT',
      captured_offline: true,
      payload: { customerId: IDS.customer, methodCode: 'ESPECES', amountXaf: 1500 },
    });
  });

  it('en ligne : toutes les créances du client, lues sur le serveur', async () => {
    request.mockResolvedValue({
      ok: true,
      data: {
        receivables: [
          {
            saleId: 'old',
            docNumber: 'VTE-2026-000001',
            customerId: IDS.customer,
            occurredAt: '2026-08-01T10:00:00.000Z',
            dueDate: '2026-08-31',
            balanceDueXaf: 10000,
          },
        ],
      },
    });
    renderAt(`/encaisser?client=${IDS.customer}`);
    expect(await screen.findByText(/VTE-2026-000001/)).toBeInTheDocument();
    expect(screen.getByText('Toutes les créances du client (lues en ligne).')).toBeInTheDocument();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        `/api/v1/receivables?customer_id=${IDS.customer}`,
        { method: 'GET' },
      ),
    );
  });

  it('créances des ventes récentes : client, non annulées, avec un reste dû', () => {
    const sale = (overrides: Partial<SaleData>) =>
      ({ ...(saleRow().data as unknown as SaleData), ...overrides }) as SaleData;
    expect(
      duesFromRecentSales(
        [
          sale({}),
          sale({ id: 'x', status: 'CANCELLED' }),
          sale({ id: 'y', balance_due_xaf: 0 }),
          sale({ id: 'z', customer_id: 'autre' }),
        ],
        IDS.customer,
      ).map((due) => due.saleId),
    ).toEqual([SALE_ID]);
  });
});

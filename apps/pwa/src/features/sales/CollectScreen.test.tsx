import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { resetConnectivityForTests } from '../../platform/connectivity.js';
import { CollectScreen } from './CollectScreen.js';
import {
  afterPendingPayments,
  allocationsOf,
  duesFromRecentSales,
  previewAllocation,
  previewTargetedAllocation,
  sortDues,
} from './collect.js';
import { IDS, posCashAccountRow, SALE_ID, saleRow, seedSalesFixtures } from './fixtures.js';
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

  it('créance sans échéance en dernier ; encaissements en attente imputés avant l’aperçu', () => {
    const dues = sortDues([
      { saleId: 'n', docNumber: 'N', dueDate: null, occurredAt: '2026-09-01', balanceXaf: 500 },
      {
        saleId: 'd',
        docNumber: 'D',
        dueDate: '2026-12-01',
        occurredAt: '2026-10-05',
        balanceXaf: 800,
      },
    ]);
    expect(dues.map((due) => due.saleId)).toEqual(['d', 'n']);
    expect(
      afterPendingPayments(dues, [{ amountXaf: 1000, targets: null }]).map((due) => [
        due.saleId,
        due.balanceXaf,
      ]),
    ).toEqual([['n', 300]]);
    // Encaissement ciblé en attente : il ne règle que sa vente, dans la limite de son reste.
    expect(
      afterPendingPayments(dues, [
        { amountXaf: 1000, targets: [{ saleId: 'n', amountXaf: 400 }] },
        { amountXaf: 900, targets: [{ saleId: 'n', amountXaf: 900 }] },
      ]).map((due) => [due.saleId, due.balanceXaf]),
    ).toEqual([['d', 800]]);
  });

  it('affectation ciblée : la vente désignée seule, le surplus en avoir ; vente absente : null', () => {
    const dues = sortDues([
      {
        saleId: 'a',
        docNumber: 'A',
        dueDate: '2026-10-01',
        occurredAt: '2026-09-01',
        balanceXaf: 500,
      },
      {
        saleId: 'b',
        docNumber: 'B',
        dueDate: '2026-11-01',
        occurredAt: '2026-10-01',
        balanceXaf: 800,
      },
    ]);
    const full = previewTargetedAllocation(1000, dues, 'b');
    expect(full?.lines.map((line) => [line.due.saleId, line.amountXaf])).toEqual([['b', 800]]);
    expect(full?.creditXaf).toBe(200);
    expect(allocationsOf(full!)).toEqual([{ saleId: 'b', amountXaf: 800 }]);
    const partial = previewTargetedAllocation(300, dues, 'b');
    expect(allocationsOf(partial!)).toEqual([{ saleId: 'b', amountXaf: 300 }]);
    expect(partial?.creditXaf).toBe(0);
    expect(previewTargetedAllocation(300, dues, 'z')).toBeNull();
    expect(previewTargetedAllocation(0, dues, 'b')).toEqual({ lines: [], creditXaf: 0 });
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
    expect(screen.getByText('Réglé : 1 500 F CFA')).toBeInTheDocument();
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

  it('« Encaisser le reste dû » : montant prérempli au reste de la vente, affecté à elle seule', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}&vente=${SALE_ID}`);
    expect(
      await screen.findByText(
        /Encaissement affecté à la vente VTE-2026-000123 \(reste dû 2 000 F CFA\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Montant reçu (F CFA)')).toHaveValue('2000');
    expect(screen.getByText('Affectation prévue (vente désignée)')).toBeInTheDocument();
    expect(screen.getByText('Réglé : 2 000 F CFA')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’encaissement' }));
    await screen.findByText(
      'Encaissement enregistré sur ce téléphone, il sera envoyé dès le retour du réseau.',
    );
    const [command] = await getDb().outbox.toArray();
    expect(command?.payload).toMatchObject({
      customerId: IDS.customer,
      amountXaf: 2000,
      allocations: [{ saleId: SALE_ID, amountXaf: 2000 }],
    });
  });

  it('vente ciblée : un montant plus fort laisse le surplus en avoir ; « Répartir » revient à l’automatique', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}&vente=${SALE_ID}`);
    const field = await screen.findByLabelText('Montant reçu (F CFA)');
    await user.clear(field);
    await user.type(field, '2500');
    expect(screen.getByText('Reste en avoir du client : 500 F CFA')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Répartir sur toutes les créances' }));
    expect(screen.queryByText(/Encaissement affecté à la vente/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Montant reçu (F CFA)')).toHaveValue('2500');
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’encaissement' }));
    await screen.findByText(
      'Encaissement enregistré sur ce téléphone, il sera envoyé dès le retour du réseau.',
    );
    const [command] = await getDb().outbox.toArray();
    expect(command?.payload).toMatchObject({ amountXaf: 2500 });
    expect(command?.payload).not.toHaveProperty('allocations');
  });

  it('« Répartir » garde le montant prérempli', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}&vente=${SALE_ID}`);
    await user.click(
      await screen.findByRole('button', { name: 'Répartir sur toutes les créances' }),
    );
    expect(screen.getByLabelText('Montant reçu (F CFA)')).toHaveValue('2000');
    expect(screen.getByText('Affectation prévue (la plus ancienne d’abord)')).toBeInTheDocument();
  });

  it('vente ciblée sans reste dû connu : avertissement, affectation automatique, rien de prérempli', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderAt(`/encaisser?client=${IDS.customer}&vente=01900000-0000-7000-8000-0000000000ff`);
    expect(
      await screen.findByText(/La vente désignée n’a plus de reste dû connu/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Montant reçu (F CFA)')).toHaveValue('');
    expect(screen.queryByText(/Encaissement affecté à la vente/)).not.toBeInTheDocument();
  });

  it('vente ciblée en ligne : rien n’est envoyé avant la lecture des créances', async () => {
    request.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}&vente=${SALE_ID}`);
    expect(await screen.findByText('Lecture des créances…')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant reçu (F CFA)'), '2000');
    expect(screen.getByRole('button', { name: 'Enregistrer l’encaissement' })).toBeDisabled();
    expect(screen.queryByText(/La vente désignée n’a plus de reste dû/)).not.toBeInTheDocument();
  });

  it('site du PDV, caisse fermée : en ligne, encaissement en espèces bloqué, invite « Ouvrir la caisse »', async () => {
    await getDb().projections.put(posCashAccountRow());
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}`);
    expect(
      await screen.findByText(
        'Caisse du point de vente fermée : ouvrez-la avant d’encaisser en espèces.',
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant reçu (F CFA)'), '1500');
    expect(
      screen.getByText(/Encaissement en espèces impossible sans caisse ouverte/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer l’encaissement' })).toBeDisabled();
  });

  it('site laissé au serveur : celui de la vente réglée, un PDV, espèces bloquées en ligne', async () => {
    // Plus aucun stock de l'utilisateur : le site de l'encaissement n'est plus déduit de son PDV.
    await getDb().projections.where('dataset').equals('stock').delete();
    await getDb().projections.put(posCashAccountRow());
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}`);
    expect(await screen.findByText(/VTE-2026-000123/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant reçu (F CFA)'), '1500');
    expect(
      screen.getByText(/Encaissement en espèces impossible sans caisse ouverte/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer l’encaissement' })).toBeDisabled();
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
          sale({ id: 'w', status: 'CANCELLATION_REQUESTED' }),
          sale({ id: 'y', balance_due_xaf: 0 }),
          sale({ id: 'z', customer_id: 'autre' }),
        ],
        IDS.customer,
      ).map((due) => due.saleId),
    ).toEqual([SALE_ID]);
  });
});

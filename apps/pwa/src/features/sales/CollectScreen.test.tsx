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

const KEPT = '01900000-0000-7000-8000-0000000008a1';
const ABSORBED = '01900000-0000-7000-8000-0000000008a2';
const SALE_KEPT = '01900000-0000-7000-8000-0000000008e3';
const SALE_ABSORBED = '01900000-0000-7000-8000-0000000008e4';
const NEVER = { __never: true } as const;

/** Résumé client tel que `GET /customers` le rend (CustomerSummary du module crm). */
function summary(id: string, displayName: string, over: Record<string, unknown> = {}) {
  return {
    id,
    stage: 'CUSTOMER',
    pipelineStepId: null,
    customerType: 'RESTAURANT',
    displayName,
    contactName: null,
    businessActivity: null,
    categoryId: null,
    phonePrimary: '+237 677 00 11 22',
    phoneSecondary: null,
    email: null,
    addressText: null,
    zoneId: IDS.zone,
    position: null,
    sourceCode: 'TERRAIN',
    acquiredByUserId: IDS.user,
    acquiredAt: '2026-01-10T08:00:00.000Z',
    ownerUserId: null,
    homeSiteId: null,
    convertedAt: null,
    firstSaleId: null,
    conversionReverted: false,
    lostReasonCodeId: null,
    mergedIntoId: null,
    duplicateOfId: null,
    creditAllowed: true,
    creditLimitXaf: 100000,
    paymentTermsDays: 30,
    lastSaleAt: null,
    version: 3,
    ...over,
  };
}

/** Fiche client de `GET /customers/{id}` (enveloppe du contrôleur crm). */
function customerDetail(customer: unknown, absorbed: readonly string[] = []) {
  return {
    customer,
    absorbed_customer_ids: absorbed,
    assignments: [],
    stage_history: [],
    recent_visits: [],
    recent_interactions: [],
    sales: { outstandingXaf: null, receivables: null, recent_orders: null, recent_sales: null },
  };
}

/** Ligne de `GET /receivables` (contrôleur sales : `resource` ajouté, `occurredAt` en ISO). */
function line(
  saleId: string,
  docNumber: string,
  customerId: string,
  balance: number,
  dueDate: string,
) {
  return {
    saleId,
    docNumber,
    customerId,
    siteId: IDS.site,
    commercialUserId: null,
    sellerUserId: IDS.user,
    zoneId: IDS.zone,
    occurredAt: '2026-05-02T09:00:00.000Z',
    dueDate,
    netTotalXaf: balance,
    amountPaidXaf: 0,
    balanceDueXaf: balance,
    daysOverdue: 40,
    overdue: true,
    bucket: '31-60',
    resource: { ownerUserId: IDS.user, siteId: IDS.site, zoneId: IDS.zone },
  };
}

/** Routes en ligne : une réponse par chemin, `{ __status }` pour un échec, `NEVER` pour une attente. */
function serveOnline(routes: Record<string, unknown>) {
  request.mockImplementation((_db, path) => {
    const data = routes[String(path)];
    if (data === NEVER) return new Promise(() => {}) as ReturnType<typeof authorizedRequest>;
    if (data === undefined) {
      return Promise.resolve({
        ok: false,
        reason: 'HTTP_ERROR',
        status: 404,
        body: null,
      }) as ReturnType<typeof authorizedRequest>;
    }
    if (typeof data === 'object' && data !== null && '__status' in data) {
      return Promise.resolve({
        ok: false,
        reason: 'HTTP_ERROR',
        status: (data as { __status: number }).__status,
        body: null,
      }) as ReturnType<typeof authorizedRequest>;
    }
    return Promise.resolve({ ok: true, data }) as ReturnType<typeof authorizedRequest>;
  });
}

function readsOf(path: string): number {
  return request.mock.calls.filter(([, called]) => called === path).length;
}

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

  it('vente ciblée, montant prérempli : le défaut d’un moyen de paiement est expliqué (MP-11)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${IDS.customer}&vente=${SALE_ID}`);
    expect(await screen.findByLabelText('Montant reçu (F CFA)')).toHaveValue('2000');
    await user.selectOptions(screen.getByLabelText('Moyen de paiement'), 'Orange Money');
    expect(
      screen.getByText('La référence de la transaction est obligatoire pour ce moyen de paiement.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer l’encaissement' })).toBeDisabled();
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

  it('client désigné par le lien et absent de l’appareil : lu en ligne, ses créances et celles de ses comptes absorbés (P8E-09)', async () => {
    serveOnline({
      [`/api/v1/customers/${KEPT}`]: customerDetail(summary(KEPT, 'Restaurant Chez Mado'), [
        ABSORBED,
      ]),
      [`/api/v1/receivables?customer_id=${KEPT}`]: {
        as_of: '2026-10-10',
        summary: {},
        receivables: [line(SALE_KEPT, 'VTE-2026-000003', KEPT, 50000, '2026-09-25')],
      },
      [`/api/v1/receivables?customer_id=${ABSORBED}`]: {
        as_of: '2026-10-10',
        summary: {},
        receivables: [line(SALE_ABSORBED, 'VTE-2026-000004', ABSORBED, 8000, '2026-06-01')],
      },
    });
    renderAt(`/encaisser?client=${KEPT}&vente=${SALE_KEPT}`);
    expect(await screen.findByText('Restaurant Chez Mado')).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Encaissement affecté à la vente VTE-2026-000003 \(reste dû 50 000 F CFA\)/,
      ),
    ).toBeInTheDocument();
    // Le compte absorbé fait partie des créances du client : total, aperçu et vente absorbée.
    expect(screen.getByText(/^Total des créances : 58\s000 F CFA$/)).toBeInTheDocument();
    expect(screen.getByText(/VTE-2026-000004/)).toBeInTheDocument();
    expect(screen.getByLabelText('Montant reçu (F CFA)')).toHaveValue('50000');
    expect(screen.queryByText('Choisissez le client qui règle.')).toBeNull();
  });

  it('lien vers un compte fusionné : le compte conservé est encaissé, vente absorbée comprise', async () => {
    serveOnline({
      [`/api/v1/customers/${ABSORBED}`]: customerDetail(
        summary(ABSORBED, 'Chez Mado (ancien compte)', { stage: 'MERGED', mergedIntoId: KEPT }),
      ),
      [`/api/v1/customers/${KEPT}`]: customerDetail(summary(KEPT, 'Restaurant Chez Mado'), [
        ABSORBED,
      ]),
      [`/api/v1/receivables?customer_id=${KEPT}`]: { as_of: '2026-10-10', receivables: [] },
      [`/api/v1/receivables?customer_id=${ABSORBED}`]: {
        as_of: '2026-10-10',
        receivables: [line(SALE_ABSORBED, 'VTE-2026-000004', ABSORBED, 8000, '2026-06-01')],
      },
    });
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${ABSORBED}&vente=${SALE_ABSORBED}`);
    expect(await screen.findByText('Restaurant Chez Mado')).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Encaissement affecté à la vente VTE-2026-000004 \(reste dû 8 000 F CFA\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ancien compte/)).toBeNull();
    // Le compte absorbé n'est jamais lu pour lui-même avant la bascule : une seule fois, comme compte du conservé.
    expect(readsOf(`/api/v1/receivables?customer_id=${ABSORBED}`)).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Enregistrer l’encaissement' }));
    await screen.findByText(/Encaissement/);
    const [command] = await getDb().outbox.toArray();
    expect(command?.payload).toMatchObject({
      customerId: KEPT,
      amountXaf: 8000,
      allocations: [{ saleId: SALE_ABSORBED, amountXaf: 8000 }],
    });
  });

  it('client trouvé en ligne par la recherche : sa fiche est lue pour ses comptes absorbés (P8E-09)', async () => {
    serveOnline({
      '/api/v1/customers?q=Chez&limit=20': {
        customers: [summary(KEPT, 'Restaurant Chez Mado')],
        next_cursor: null,
      },
      [`/api/v1/customers/${KEPT}`]: customerDetail(summary(KEPT, 'Restaurant Chez Mado'), [
        ABSORBED,
      ]),
      [`/api/v1/receivables?customer_id=${KEPT}`]: {
        receivables: [line(SALE_KEPT, 'VTE-2026-000003', KEPT, 50000, '2026-09-25')],
      },
      [`/api/v1/receivables?customer_id=${ABSORBED}`]: {
        receivables: [line(SALE_ABSORBED, 'VTE-2026-000004', ABSORBED, 8000, '2026-06-01')],
      },
    });
    const user = userEvent.setup();
    renderAt('/encaisser');
    await user.type(
      await screen.findByLabelText('Rechercher un client (nom ou téléphone)'),
      'Chez',
    );
    await user.click(await screen.findByRole('button', { name: /Restaurant Chez Mado/ }));
    expect(await screen.findByText(/^Total des créances : 58\s000 F CFA$/)).toBeInTheDocument();
    expect(readsOf(`/api/v1/customers/${KEPT}`)).toBe(1);
  });

  it('client de l’appareil ayant absorbé un compte connu de l’appareil : ses créances sont lues aussi', async () => {
    await getDb().projections.put({
      key: `customers:CUSTOMER:${ABSORBED}`,
      dataset: 'customers',
      entity_type: 'CUSTOMER',
      entity_id: ABSORBED,
      scope_type: 'USER',
      scope_id: IDS.user,
      data: {
        id: ABSORBED,
        stage: 'MERGED',
        display_name: 'Ancien compte',
        contact_name: null,
        category_id: null,
        phone_primary: null,
        zone_id: IDS.zone,
        owner_user_id: IDS.user,
        home_site_id: IDS.site,
        merged_into_id: IDS.customer,
        credit_allowed: true,
        credit_limit_xaf: 50000,
        payment_terms_days: 30,
        outstanding_xaf: 0,
        version: 1,
      },
      seq: 1,
      row_version: 1,
    });
    serveOnline({
      [`/api/v1/receivables?customer_id=${IDS.customer}`]: {
        receivables: [line(SALE_KEPT, 'VTE-2026-000003', IDS.customer, 50000, '2026-09-25')],
      },
      [`/api/v1/receivables?customer_id=${ABSORBED}`]: {
        receivables: [line(SALE_ABSORBED, 'VTE-2026-000004', ABSORBED, 8000, '2026-06-01')],
      },
    });
    renderAt(`/encaisser?client=${IDS.customer}`);
    expect(await screen.findByText(/^Total des créances : 58\s000 F CFA$/)).toBeInTheDocument();
    expect(screen.getByText(/VTE-2026-000004/)).toBeInTheDocument();
    expect(
      request.mock.calls.some(([, path]) => String(path).startsWith('/api/v1/customers')),
    ).toBe(false);
    cleanup();

    // Une lecture en échec parmi les comptes : les créances ne sont pas présentées comme complètes.
    serveOnline({
      [`/api/v1/receivables?customer_id=${IDS.customer}`]: {
        receivables: [line(SALE_KEPT, 'VTE-2026-000003', IDS.customer, 50000, '2026-09-25')],
      },
      [`/api/v1/receivables?customer_id=${ABSORBED}`]: { __status: 500 },
    });
    renderAt(`/encaisser?client=${IDS.customer}`);
    expect(await screen.findByText('Boutique Mvog-Mbi')).toBeInTheDocument();
    await waitFor(() =>
      expect(readsOf(`/api/v1/receivables?customer_id=${ABSORBED}`)).toBeGreaterThan(0),
    );
    expect(screen.queryByText('Toutes les créances du client (lues en ligne).')).toBeNull();
    expect(screen.queryByText(/VTE-2026-000003/)).toBeNull();
  });

  it('client de l’appareil : aucune lecture de sa fiche en ligne', async () => {
    serveOnline({
      [`/api/v1/receivables?customer_id=${IDS.customer}`]: { receivables: [] },
    });
    renderAt(`/encaisser?client=${IDS.customer}`);
    expect(await screen.findByText('Boutique Mvog-Mbi')).toBeInTheDocument();
    await waitFor(() => expect(readsOf(`/api/v1/receivables?customer_id=${IDS.customer}`)).toBe(1));
    expect(
      request.mock.calls.some(([, path]) => String(path).startsWith('/api/v1/customers')),
    ).toBe(false);
  });

  it('client désigné : lecture annoncée tant qu’elle dure, pas d’invite ni de « client inconnu »', async () => {
    serveOnline({ [`/api/v1/customers/${KEPT}`]: NEVER });
    renderAt(`/encaisser?client=${KEPT}`);
    expect((await screen.findAllByText('Lecture du client…')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Choisissez le client qui règle.')).toBeNull();
    expect(screen.queryByText('Client inconnu de cet appareil')).toBeNull();
    expect(screen.queryByText('Vente payée en totalité')).toBeNull();
    expect(readsOf(`/api/v1/receivables?customer_id=${KEPT}`)).toBe(0);
  });

  it('client désigné illisible : panne relançable, refus sans relance, puis lecture réussie', async () => {
    serveOnline({ [`/api/v1/customers/${KEPT}`]: { __status: 500 } });
    const user = userEvent.setup();
    renderAt(`/encaisser?client=${KEPT}`);
    expect(
      await screen.findByText(/Le client désigné n’a pas pu être lu \(réseau ou droits\)/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Lecture du client…')).toBeNull();
    expect(screen.queryByText('Vente payée en totalité')).toBeNull();
    serveOnline({
      [`/api/v1/customers/${KEPT}`]: customerDetail(summary(KEPT, 'Restaurant Chez Mado')),
      [`/api/v1/receivables?customer_id=${KEPT}`]: { receivables: [] },
    });
    await user.click(screen.getByRole('button', { name: 'Relire le client' }));
    expect(await screen.findByText('Restaurant Chez Mado')).toBeInTheDocument();
    expect(screen.queryByText(/n’a pas pu être lu/)).toBeNull();

    // Refus (droits, hors portée) : pas de relance. Panne de réseau : relance.
    cleanup();
    serveOnline({ [`/api/v1/customers/${KEPT}`]: { __status: 404 } });
    renderAt(`/encaisser?client=${KEPT}`);
    expect(await screen.findByText(/n’a pas pu être lu/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Relire le client' })).toBeNull();
    cleanup();
    request.mockResolvedValue({ ok: false, reason: 'OFFLINE' });
    renderAt(`/encaisser?client=${KEPT}`);
    expect(await screen.findByText(/n’a pas pu être lu/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Relire le client' })).toBeInTheDocument();
  });

  it('hors ligne : le client désigné inconnu de l’appareil n’est pas lu, invite à choisir le client', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderAt(`/encaisser?client=${KEPT}`);
    expect(await screen.findByText('Choisissez le client qui règle.')).toBeInTheDocument();
    expect(screen.queryByText('Lecture du client…')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('sans client désigné : invite à choisir le client', async () => {
    renderAt('/encaisser');
    expect(await screen.findByText('Choisissez le client qui règle.')).toBeInTheDocument();
  });

  it('hors ligne : un encaissement accepté reste retranché tant que les ventes ne sont pas relues (MP-11)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().outbox.put({
      command_id: '01900000-0000-7000-8000-0000000009b1',
      device_seq: 1,
      author_user_id: '01900000-0000-7000-8000-000000000001',
      command_type: 'sales.payment.record',
      command_version: 1,
      aggregate_type: 'CUSTOMER_PAYMENT',
      aggregate_id: '01900000-0000-7000-8000-0000000009b2',
      payload: {
        customerId: IDS.customer,
        methodCode: 'ESPECES',
        amountXaf: 2000,
        allocations: [{ saleId: SALE_ID, amountXaf: 2000 }],
      },
      occurred_at: '2026-10-14T08:00:00.000Z',
      client_created_at: '2026-10-14T08:00:00.000Z',
      captured_offline: true,
      depends_on: [],
      status: 'SYNCED',
      synced_at: '2026-10-14T08:00:05.000Z',
      attempts: 1,
    } as never);
    renderAt(`/encaisser?client=${IDS.customer}`);
    // Le jeu `sales_recent` n'a pas été tiré depuis l'acceptation : la vente réglée n'est plus due.
    expect(await screen.findByText('Aucune créance connue pour ce client.')).toBeInTheDocument();
  });

  it('en ligne : créances relues quand l’encaissement en attente du client est accepté (MP-11)', async () => {
    request.mockResolvedValue({ ok: true, data: { receivables: [] } });
    await getDb().outbox.put({
      command_id: '01900000-0000-7000-8000-0000000009a1',
      device_seq: 1,
      author_user_id: '01900000-0000-7000-8000-000000000001',
      command_type: 'sales.payment.record',
      command_version: 1,
      aggregate_type: 'CUSTOMER_PAYMENT',
      aggregate_id: '01900000-0000-7000-8000-0000000009a2',
      payload: { customerId: IDS.customer, methodCode: 'ESPECES', amountXaf: 2000 },
      occurred_at: '2026-10-14T08:00:00.000Z',
      client_created_at: '2026-10-14T08:00:00.000Z',
      captured_offline: false,
      depends_on: [],
      status: 'PENDING_SYNC',
      attempts: 0,
    } as never);
    renderAt(`/encaisser?client=${IDS.customer}`);
    const reads = () =>
      request.mock.calls.filter((call) => String(call[1]).startsWith('/api/v1/receivables')).length;
    await waitFor(() => expect(reads()).toBe(1));
    await getDb().outbox.update('01900000-0000-7000-8000-0000000009a1', {
      status: 'SYNCED',
      synced_at: '2026-10-14T08:00:05.000Z',
    });
    await waitFor(() => expect(reads()).toBe(2));
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

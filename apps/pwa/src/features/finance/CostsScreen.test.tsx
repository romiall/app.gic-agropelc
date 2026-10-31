import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { reportSyncOutcome, resetConnectivityForTests } from '../../platform/connectivity.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import type { CostEntry, FinanceOverview, LossSummary, LotChoice, LotMargins } from './costs.js';
import { CostsScreen } from './CostsScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T12:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
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

const request = vi.mocked(authorizedRequest);
const LOT = '01900000-0000-7000-8000-0000000007a1';
const OTHER_LOT = '01900000-0000-7000-8000-0000000007a2';
const UNKNOWN_LOT = '01900000-0000-7000-8000-0000000007a3';
const ACTIVE_LOT = '01900000-0000-7000-8000-0000000007a4';
const ACTIVE_LOT_2 = '01900000-0000-7000-8000-0000000007a5';
const LOSS_REASON = '01900000-0000-7000-8000-0000000007b1';
const UNKNOWN_REASON = '01900000-0000-7000-8000-0000000007b2';
const UNKNOWN_PRODUCT = '01900000-0000-7000-8000-0000000007c1';
const MONTH = '/api/v1/finance/overview?from=2026-10-01&to=2026-10-10';
const LOSSES = (group: string, from = '2026-10-01') =>
  `/api/v1/losses/summary?from=${from}&to=2026-10-10&group_by=${group}`;

const LOT_CODES = (status: string) => `/api/v1/production/lots?status=${status}&limit=200`;
const ENTRIES = (lotId: string) =>
  `/api/v1/costs?cost_object_type=PRODUCTION_LOT&cost_object_id=${lotId}&limit=200`;

const DENIED = { __status: 403 } as const;
const BROKEN = { __status: 500 } as const;
const NEVER = { __never: true } as const;

type Routes = Record<string, unknown>;

const overview: FinanceOverview = {
  from: '2026-10-01',
  to: '2026-10-10',
  as_of: '2026-10-10',
  revenue: {
    grossRevenueXaf: 1_200_000,
    cancelledXaf: 50_000,
    netRevenueXaf: 1_150_000,
    costOfSalesXaf: 700_000,
    grossMarginXaf: 450_000,
    saleCount: 12,
  },
  collected: { amountXaf: 900_000, paymentsCount: 9 },
  receivables: {
    outstandingXaf: 250_000,
    openCount: 3,
    overdueXaf: 100_000,
    overdueCount: 1,
    buckets: { '0-30': 100_000, '31-60': 0, '61-90': 0, '>90': 0 },
  },
  expenses: {
    totalXaf: 140_000,
    count: 2,
    byCategory: [{ code: 'TRANSPORT', label: 'Transport', amountXaf: 140_000, count: 2 }],
    pendingXaf: 30_000,
    unjustifiedXaf: 5_000,
  },
  payables: { balanceXaf: 700_000, overdueXaf: 300_000, advanceXaf: 20_000, netXaf: 680_000 },
  cash: { totalXaf: 2_000_000, byAccountType: { BANQUE: 1_500_000, CAISSE_CENTRALE: 500_000 } },
};

const losses: LossSummary = {
  from: '2026-10-01',
  to: '2026-10-10',
  group_by: 'product',
  lines: [
    {
      productId: IDS.chicken,
      productionLotId: null,
      category: null,
      reasonCodeId: null,
      declarations: 2,
      quantityBase: 30,
      valueXaf: 90_000,
      pendingQuantityBase: 4,
      pendingValueXaf: 12_000,
    },
  ],
  total_value_xaf: 90_000,
};

const lots: LotChoice[] = [
  {
    id: LOT,
    lotCode: 'BP-2026-07',
    lotType: 'POULET_CHAIR',
    productId: IDS.chicken,
    siteId: IDS.site,
    status: 'CLOSED',
    startDate: '2026-07-01',
    occurredAt: '2026-07-01T08:00:00.000Z',
  },
  {
    id: OTHER_LOT,
    lotCode: 'BP-2026-08',
    lotType: 'POULET_CHAIR',
    productId: IDS.chicken,
    siteId: IDS.site,
    status: 'CLOSED',
    startDate: '2026-08-01',
    occurredAt: '2026-08-01T08:00:00.000Z',
  },
];

// AT-026 avec la dépense directe de 140 000 (ADR-044) : coût 5 600 000, CA 10 741 500, marge 5 141 500 ;
// coût figé des ventes 5 300 000 (distinct du coût net), marge brute des ventes 5 441 500.
const lotMargins: LotMargins = {
  id: LOT,
  lotCode: 'BP-2026-07',
  productId: IDS.chicken,
  status: 'CLOSED',
  costs: {
    breakdown: [
      { costType: 'ANIMAUX', netXaf: 1_500_000 },
      { costType: 'ALIMENT', netXaf: 3_960_000 },
      { costType: 'DEPENSE_DIRECTE', netXaf: 140_000 },
    ],
    netXaf: 5_600_000,
    remainingXaf: 0,
    costPerHeadXaf: null,
  },
  sales: {
    netRevenueXaf: 10_741_500,
    slaughterProductsRevenueXaf: 0,
    costOfSalesXaf: 5_300_000,
    soldQuantity: 2_310,
    lotMarginXaf: 5_141_500,
    grossMarginXaf: 5_441_500,
  },
};

/** Masquage réel du contrôleur (RC-05) : objets conservés, toutes les clés `…Xaf` à null. */
function masked(lot: LotMargins): LotMargins {
  return {
    ...lot,
    costs: {
      breakdown: lot.costs.breakdown.map((line) => ({ ...line, netXaf: null })),
      netXaf: null,
      remainingXaf: null,
      costPerHeadXaf: null,
    },
    sales: {
      netRevenueXaf: null,
      slaughterProductsRevenueXaf: null,
      costOfSalesXaf: null,
      soldQuantity: lot.sales.soldQuantity,
      lotMarginXaf: null,
      grossMarginXaf: null,
    },
  };
}

const noSales: LotMargins['sales'] = {
  netRevenueXaf: 0,
  slaughterProductsRevenueXaf: 0,
  costOfSalesXaf: 0,
  soldQuantity: 0,
  lotMarginXaf: -1_000,
  grossMarginXaf: 0,
};

const entries: CostEntry[] = [
  {
    id: 'e1',
    costType: 'ANIMAUX',
    direction: 'DEBIT',
    amountXaf: 1_500_000,
    sourceType: 'STOCK_MOVE',
    sourceId: 's1',
    reversesEntryId: null,
    occurredAt: '2026-07-01T08:00:00.000Z',
    comment: null,
  },
  {
    id: 'e3',
    costType: 'DEPENSE_DIRECTE',
    direction: 'CREDIT',
    amountXaf: 10_000,
    sourceType: 'EXPENSE',
    sourceId: 'x1',
    reversesEntryId: 'e2',
    occurredAt: '2026-07-21T23:30:00.000Z',
    comment: 'Erreur de montant',
  },
];

function baseRoutes(): Routes {
  return {
    [MONTH]: overview,
    [LOSSES('product')]: losses,
    '/api/v1/production/lots?status=CLOSED&limit=50': { lots, next_cursor: null },
    '/api/v1/production/lots?status=ACTIVE&limit=50': { lots: [], next_cursor: null },
    [`/api/v1/production/lots/${LOT}`]: { lot: lotMargins },
    [ENTRIES(LOT)]: { cost_entries: entries, next_cursor: null },
  };
}

function serve(routes: Routes) {
  request.mockImplementation((_db, path) => {
    const data = routes[path];
    if (data === NEVER) return new Promise(() => {}) as ReturnType<typeof authorizedRequest>;
    const status =
      data && typeof data === 'object' && '__status' in data
        ? (data as { __status: number }).__status
        : data
          ? null
          : 500;
    return Promise.resolve(
      status === null
        ? { ok: true, data }
        : { ok: false, reason: 'HTTP_ERROR', status, message: `route : ${path}` },
    ) as ReturnType<typeof authorizedRequest>;
  });
}

function readsOf(path: string): number {
  return request.mock.calls.filter(([, called]) => called === path).length;
}

async function rememberRoles(roles: readonly string[]) {
  await getDb().navigation.put({
    user_id: IDS.user,
    roles: [...roles],
    sections: [],
    saved_at: '2026-10-10T08:00:00.000Z',
  });
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <CostsScreen />
    </MemoryRouter>,
  );
}

describe('Coûts et marges (ECR-FIN-06, P8E-08)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    request.mockReset();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
    const key = `product:PRODUCT:${IDS.chicken}`;
    const product = await db.projections.get(key);
    await db.projections.put({ ...product!, data: { ...product!.data, base_unit_code: 'TETE' } });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    resetConnectivityForTests();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.navigation.clear();
  });

  it('vue d’ensemble du mois en cours : ventes et marge brute, encaissé, dépenses, soldes à la date de lecture', async () => {
    await rememberRoles(['FINANCE']);
    renderScreen();
    expect(await screen.findByText('Du 1 octobre 2026 au 10 octobre 2026')).toBeInTheDocument();
    const block = screen.getByRole('region', { name: 'Vue d’ensemble de la période' });
    // Tuiles d'indicateur (libellé, valeur, précision) à la place des phrases d'avant.
    const tile = (label: string) => within(block).getByText(label).closest('.tile') as HTMLElement;
    await within(block).findByText('Chiffre d’affaires net');
    const revenue = tile('Chiffre d’affaires net');
    expect(within(revenue).getByText(/^1\s150\s000 F CFA$/)).toBeInTheDocument();
    expect(
      within(revenue).getByText(/^Brut 1\s200\s000 F CFA · annulé 50\s000 F CFA · 12 ventes$/),
    ).toBeInTheDocument();
    const margin = tile('Marge brute des ventes');
    expect(within(margin).getByText(/^450\s000 F CFA$/)).toBeInTheDocument();
    expect(within(margin).getByText(/^Coût des ventes 700\s000 F CFA$/)).toBeInTheDocument();
    const collected = tile('Encaissé');
    expect(within(collected).getByText(/^900\s000 F CFA$/)).toBeInTheDocument();
    expect(
      within(collected).getByText('9 encaissements, annulations déduites'),
    ).toBeInTheDocument();
    const expenses = tile('Dépenses');
    expect(within(expenses).getByText(/^140\s000 F CFA$/)).toBeInTheDocument();
    expect(
      within(expenses).getByText('2 dépenses enregistrées, approuvées ou payées'),
    ).toBeInTheDocument();
    expect(within(block).getByText(/^Transport : 140\s000 F CFA \(2\)$/)).toBeInTheDocument();
    expect(
      within(block).getByText(
        /^En attente de validation : 30\s000 F CFA · refusées après paiement : 5\s000 F CFA$/,
      ),
    ).toBeInTheDocument();
    expect(within(block).getByText('Soldes au 10 octobre 2026')).toBeInTheDocument();
    const receivables = tile('Créances clients');
    expect(within(receivables).getByText(/^250\s000 F CFA$/)).toBeInTheDocument();
    expect(
      within(receivables).getByText(/^3 ventes ouvertes · échu 100\s000 F CFA \(1 vente\)$/),
    ).toBeInTheDocument();
    const payables = tile('Dettes fournisseurs');
    expect(within(payables).getByText(/^700\s000 F CFA$/)).toBeInTheDocument();
    expect(
      within(payables).getByText(
        /^échu 300\s000 F CFA · avances 20\s000 F CFA · net 680\s000 F CFA$/,
      ),
    ).toBeInTheDocument();
    expect(within(tile('Trésorerie')).getByText(/^2\s000\s000 F CFA$/)).toBeInTheDocument();
    expect(within(block).getByText(/^Banque : 1\s500\s000 F CFA$/)).toBeInTheDocument();
    expect(within(block).getByText(/^Caisse centrale : 500\s000 F CFA$/)).toBeInTheDocument();
    expect(
      screen.getByText(/^Les marges par produit, point de vente et commercial viendront/),
    ).toBeInTheDocument();
  });

  it('blocs non lisibles avec ses droits : annoncés, jamais affichés à zéro', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [MONTH]: {
        ...overview,
        revenue: null,
        collected: null,
        receivables: null,
        cash: null,
      },
    });
    renderScreen();
    const block = await screen.findByRole('region', { name: 'Vue d’ensemble de la période' });
    expect(await within(block).findAllByText('Non visible avec vos droits.')).toHaveLength(2);
    expect(
      within(block).getByText('Créances clients : non visibles avec vos droits.'),
    ).toBeInTheDocument();
    expect(
      within(block).getByText('Trésorerie : non visible avec vos droits.'),
    ).toBeInTheDocument();
    expect(within(block).queryByText(/^Chiffre d’affaires/)).toBeNull();
    // Valorisation absente : coût et marge brute non visibles, le CA reste.
    cleanup();
    serve({
      ...baseRoutes(),
      [MONTH]: {
        ...overview,
        revenue: {
          ...overview.revenue!,
          saleCount: 1,
          costOfSalesXaf: null,
          grossMarginXaf: null,
        },
        collected: { amountXaf: 900_000, paymentsCount: 1 },
        receivables: { ...overview.receivables!, openCount: 1 },
        expenses: { ...overview.expenses!, count: 1, pendingXaf: 0, unjustifiedXaf: 0 },
      },
    });
    renderScreen();
    expect(await screen.findByText('Coût des ventes non visible')).toBeInTheDocument();
    expect(
      screen.getByText(/^Brut 1\s200\s000 F CFA · annulé 50\s000 F CFA · 1 vente$/),
    ).toBeInTheDocument();
    expect(screen.getByText('1 encaissement, annulations déduites')).toBeInTheDocument();
    expect(screen.getByText('1 dépense enregistrée, approuvée ou payée')).toBeInTheDocument();
    expect(
      screen.getByText(/^1 vente ouverte · échu 100\s000 F CFA \(1 vente\)$/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Vue d’ensemble de la période' })).queryByText(
        /^En attente de validation/,
      ),
    ).toBeNull();
  });

  it('période : semaine en cours, autre période ; une période invalide ne lit rien', async () => {
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText('Du 1 octobre 2026 au 10 octobre 2026');
    serve({
      ...baseRoutes(),
      '/api/v1/finance/overview?from=2026-10-05&to=2026-10-10': overview,
      [LOSSES('product', '2026-10-05')]: losses,
      '/api/v1/finance/overview?from=2026-09-11&to=2026-10-10': overview,
      [LOSSES('product', '2026-09-11')]: losses,
    });
    await user.selectOptions(screen.getByLabelText('Période étudiée'), 'WEEK');
    expect(await screen.findByText('Du 5 octobre 2026 au 10 octobre 2026')).toBeInTheDocument();
    expect(readsOf('/api/v1/finance/overview?from=2026-10-05&to=2026-10-10')).toBe(1);
    // Autre période : 30 derniers jours proposés, modifiables.
    await user.selectOptions(screen.getByLabelText('Période étudiée'), 'CUSTOM');
    expect(screen.getByLabelText('Du')).toHaveValue('2026-09-11');
    expect(screen.getByLabelText('Au')).toHaveValue('2026-10-10');
    const before = request.mock.calls.length;
    await user.clear(screen.getByLabelText('Au'));
    await user.type(screen.getByLabelText('Au'), '2026-10-12');
    expect(
      await screen.findByText('La période ne peut pas finir après aujourd’hui.'),
    ).toBeInTheDocument();
    const overviewBlock = screen.getByRole('region', { name: 'Vue d’ensemble de la période' });
    expect(
      within(overviewBlock).getByText('Choisissez une période valide pour lire ces chiffres.'),
    ).toBeInTheDocument();
    expect(within(overviewBlock).queryByText(/^Soldes au/)).toBeNull();
    const lossBlock = screen.getByRole('region', { name: 'Pertes de la période' });
    expect(
      within(lossBlock).getByText('Choisissez une période valide pour lire ces chiffres.'),
    ).toBeInTheDocument();
    expect(within(lossBlock).queryByRole('listitem')).toBeNull();
    expect(screen.getByRole('region', { name: 'Coûts et marges d’un lot' })).toBeInTheDocument();
    expect(
      request.mock.calls.slice(before).some(([, path]) => String(path).includes('2026-10-12')),
    ).toBe(false);
    // Le regroupement choisi survit à la période invalide.
    await user.selectOptions(within(lossBlock).getByLabelText('Regrouper les pertes'), 'reason');
    // Période close avant aujourd'hui : les soldes restent lus à la date de lecture.
    serve({
      ...baseRoutes(),
      '/api/v1/finance/overview?from=2026-09-11&to=2026-10-05': {
        ...overview,
        from: '2026-09-11',
        to: '2026-10-05',
      },
      '/api/v1/losses/summary?from=2026-09-11&to=2026-10-05&group_by=reason': {
        ...losses,
        group_by: 'reason',
        lines: [],
        total_value_xaf: 0,
      },
    });
    await user.clear(screen.getByLabelText('Au'));
    await user.type(screen.getByLabelText('Au'), '2026-10-05');
    expect(await screen.findByText('Du 11 septembre 2026 au 5 octobre 2026')).toBeInTheDocument();
    expect(await within(overviewBlock).findByText('Soldes au 10 octobre 2026')).toBeInTheDocument();
    expect(within(lossBlock).getByLabelText('Regrouper les pertes')).toHaveValue('reason');
    expect(
      await within(lossBlock).findByText('Aucune perte déclarée sur la période.'),
    ).toBeInTheDocument();
    // « Du » invalide : seule la période est en défaut, la section des lots reste.
    await user.clear(screen.getByLabelText('Du'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Coûts et marges d’un lot' })).toBeInTheDocument();
  });

  it('pertes : par produit avec quantités et attente, par lot et par motif nommés, valeurs masquées', async () => {
    await rememberRoles(['FINANCE']);
    const db = getDb();
    await db.projections.bulkPut([
      {
        key: `production:PRODUCTION_LOT:${LOT}`,
        dataset: 'production',
        entity_type: 'PRODUCTION_LOT',
        entity_id: LOT,
        scope_type: 'GLOBAL',
        scope_id: null,
        data: { id: LOT, lot_code: 'BP-2026-07', product_id: IDS.chicken, status: 'CLOSED' },
        seq: 1,
        row_version: 1,
      },
      {
        key: `reason_code:REASON_CODE:${LOSS_REASON}`,
        dataset: 'reason_code',
        entity_type: 'REASON_CODE',
        entity_id: LOSS_REASON,
        scope_type: 'GLOBAL',
        scope_id: null,
        data: {
          id: LOSS_REASON,
          category: 'LOSS',
          code: 'BEC',
          label: 'Bec cassé',
          loss_category: 'CASSE',
          requires_comment: false,
          is_active: true,
        },
        seq: 1,
        row_version: 1,
      },
    ]);
    serve({
      ...baseRoutes(),
      [LOSSES('product')]: {
        ...losses,
        lines: [
          ...losses.lines,
          {
            ...losses.lines[0]!,
            productId: UNKNOWN_PRODUCT,
            declarations: 1,
            quantityBase: 5,
            valueXaf: 1_000,
            pendingQuantityBase: 0,
          },
        ],
      },
      [LOSSES('lot')]: {
        ...losses,
        group_by: 'lot',
        lines: [
          { ...losses.lines[0]!, productId: null, productionLotId: LOT, pendingQuantityBase: 0 },
          {
            ...losses.lines[0]!,
            productId: null,
            productionLotId: OTHER_LOT,
            pendingQuantityBase: 0,
          },
          {
            ...losses.lines[0]!,
            productId: null,
            productionLotId: UNKNOWN_LOT,
            pendingQuantityBase: 0,
          },
        ],
      },
      // Lot clôturé absent de l'appareil : son code est lu sur le serveur.
      [LOT_CODES('ACTIVE')]: { lots: [], next_cursor: null },
      [LOT_CODES('SELLING')]: { lots: [], next_cursor: null },
      [LOT_CODES('CLOSED')]: { lots: [lots[1]], next_cursor: null },
      [LOSSES('reason')]: {
        ...losses,
        group_by: 'reason',
        lines: [
          {
            ...losses.lines[0]!,
            productId: null,
            category: 'CASSE',
            reasonCodeId: LOSS_REASON,
            valueXaf: null,
            pendingValueXaf: null,
          },
          {
            ...losses.lines[0]!,
            productId: null,
            category: null,
            reasonCodeId: UNKNOWN_REASON,
            valueXaf: null,
            pendingValueXaf: null,
            pendingQuantityBase: 0,
          },
          {
            ...losses.lines[0]!,
            productId: null,
            category: 'MORTALITE',
            reasonCodeId: null,
            valueXaf: null,
            pendingValueXaf: null,
            pendingQuantityBase: 0,
          },
        ],
        total_value_xaf: null,
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const block = await screen.findByRole('region', { name: 'Pertes de la période' });
    const chicken = await within(block).findByRole('listitem', { name: 'Poulet de chair' });
    expect(within(chicken).getByText(/^· 90\s000 F CFA$/)).toBeInTheDocument();
    expect(within(chicken).getByText('Perdu : 30 têtes (2 déclarations)')).toBeInTheDocument();
    // Produit inconnu de l'appareil : identifiant court, quantité sans unité.
    const unknown = within(block).getByRole('listitem', { name: '…07c1' });
    expect(within(unknown).getByText('Perdu : 5 (1 déclaration)')).toBeInTheDocument();
    expect(within(unknown).queryByText(/^En attente/)).toBeNull();
    expect(within(block).queryByText(/^Par lot :/)).toBeNull();
    expect(
      within(chicken).getByText(/^En attente de validation : 4 têtes \(12\s000 F CFA\)$/),
    ).toBeInTheDocument();
    expect(within(block).getByText(/^Valeur des pertes : 90\s000 F CFA$/)).toBeInTheDocument();

    // Les codes des lots ne sont lus que pour le regroupement par lot.
    expect(readsOf(LOT_CODES('CLOSED'))).toBe(0);
    await user.selectOptions(within(block).getByLabelText('Regrouper les pertes'), 'lot');
    const byLot = await within(block).findByRole('listitem', { name: 'BP-2026-07' });
    // Par lot : déclarations seulement, une quantité mêlerait des unités.
    expect(within(byLot).getByText('2 déclarations')).toBeInTheDocument();
    expect(await within(block).findByRole('listitem', { name: 'BP-2026-08' })).toBeInTheDocument();
    expect(within(block).getByRole('listitem', { name: 'lot …07a3' })).toBeInTheDocument();
    expect(
      within(block).getByText('Par lot : seules les pertes rattachées à un lot sont comptées.'),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(
        /^Valeur des pertes rattachées à un lot : 90\s000 F CFA \(pertes sans lot exclues\)$/,
      ),
    ).toBeInTheDocument();

    await user.selectOptions(within(block).getByLabelText('Regrouper les pertes'), 'reason');
    const byReason = await within(block).findByRole('listitem', { name: 'Casse · Bec cassé' });
    expect(within(byReason).getByText(/^· non visible$/)).toBeInTheDocument();
    expect(within(block).getByRole('listitem', { name: 'motif …07b2' })).toBeInTheDocument();
    expect(within(block).getByRole('listitem', { name: 'Mortalité' })).toBeInTheDocument();
    expect(
      within(block).getByText('Montants réservés aux rôles qui voient les valorisations.'),
    ).toBeInTheDocument();

    // Aucune perte rattachée à un lot : message propre au regroupement par lot.
    serve({
      ...baseRoutes(),
      [LOSSES('lot')]: { ...losses, group_by: 'lot', lines: [], total_value_xaf: 0 },
    });
    await user.selectOptions(within(block).getByLabelText('Regrouper les pertes'), 'lot');
    expect(
      await within(block).findByText('Aucune perte rattachée à un lot sur la période.'),
    ).toBeInTheDocument();
  });

  it('marge d’un lot clôturé (AT-026) : coûts par nature, CA, deux marges, écritures de coût', async () => {
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    const block = await screen.findByRole('region', { name: 'Coûts et marges d’un lot' });
    const lotSelect = within(block).getByLabelText('Lot');
    // Le plus récent d'abord (noms des produits lus sur l'appareil).
    await within(lotSelect).findByRole('option', { name: 'BP-2026-08 · Poulet de chair' });
    expect(
      within(lotSelect)
        .getAllByRole('option', { name: /^BP-2026/ })
        .map((option) => option.textContent),
    ).toEqual(['BP-2026-08 · Poulet de chair', 'BP-2026-07 · Poulet de chair']);
    await user.selectOptions(lotSelect, LOT);
    const card = await within(block).findByRole('group', { name: 'Lot BP-2026-07' });
    expect(within(card).getByText(/^Dépenses directes : 140\s000 F CFA$/)).toBeInTheDocument();
    expect(within(card).queryByText(/^Coût restant par tête/)).toBeNull();
    expect(within(card).queryByText('Aucune vente pour ce lot.')).toBeNull();
    expect(
      within(card).getByText(/^Coût net 5\s600\s000 F CFA · coût restant 0 F CFA$/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        /^Chiffre d’affaires net 10\s741\s500 F CFA, dont produits d’abattage 0 F CFA \(2\s?310 têtes vendues\)$/,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        /^Marge du lot \(chiffre d’affaires net − coût net du lot\) : 5\s141\s500 F CFA$/,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        /^Coût des ventes 5\s300\s000 F CFA · marge brute des ventes \(chiffre d’affaires net − coût des ventes\) : 5\s441\s500 F CFA$/,
      ),
    ).toBeInTheDocument();
    // Direction : fiche du lot ouverte depuis l'écran.
    expect(
      within(card).getByRole('link', { name: 'Ouvrir la fiche du lot BP-2026-07' }),
    ).toHaveAttribute('href', `/production/fiche?lot=${LOT}`);

    await user.click(
      within(card).getByRole('button', { name: 'Voir les écritures de coût de BP-2026-07' }),
    );
    const list = await within(card).findAllByText(/^\d+ (juillet) 2026 · /);
    // La plus récente d'abord ; un crédit est négatif ; une correction est signalée ; 23:30 UTC = 22 juillet.
    expect(list.map((item) => item.textContent)).toEqual([
      expect.stringMatching(
        /^22 juillet 2026 · Dépenses directes : − 10\s000 F CFA \(dépense\) · corrige une écriture antérieure · Erreur de montant$/,
      ),
      expect.stringMatching(
        /^1 juillet 2026 · Animaux : 1\s500\s000 F CFA \(mouvement de stock\)$/,
      ),
    ]);
  });

  it('Finance : pas de lien vers la fiche du lot ; montants masqués ; aucun lot en cours', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [`/api/v1/production/lots/${LOT}`]: { lot: masked(lotMargins) },
      [`/api/v1/production/lots/${OTHER_LOT}`]: {
        lot: masked({ ...lotMargins, id: OTHER_LOT, lotCode: 'BP-2026-08', sales: noSales }),
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const block = await screen.findByRole('region', { name: 'Coûts et marges d’un lot' });
    const lotSelect = within(block).getByLabelText('Lot');
    await within(lotSelect).findAllByRole('option', { name: /^BP-2026/ });
    await user.selectOptions(lotSelect, LOT);
    const card = await within(block).findByRole('group', { name: 'Lot BP-2026-07' });
    expect(
      within(card).getByText('Montants réservés aux rôles qui voient les valorisations.'),
    ).toBeInTheDocument();
    // Ventes masquées mais présentes : le nombre de têtes reste, les montants sont « non visibles ».
    expect(
      within(card).getByText(
        /^Chiffre d’affaires net non visible, dont produits d’abattage non visible \(2\s?310 têtes vendues\)$/,
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        'Marge du lot (chiffre d’affaires net − coût net du lot) : non visible',
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByText('Aucune vente pour ce lot.')).toBeNull();
    expect(within(card).queryByRole('link')).toBeNull();
    // Lot sans vente (montant masqué compté nul) : annoncé comme tel.
    await user.selectOptions(lotSelect, OTHER_LOT);
    const other = await within(block).findByRole('group', { name: 'Lot BP-2026-08' });
    expect(within(other).getByText('Aucune vente pour ce lot.')).toBeInTheDocument();
    await user.selectOptions(within(block).getByLabelText('Lots'), 'ACTIVE');
    expect(await within(block).findByText('Aucun lot dans ce statut.')).toBeInTheDocument();
    expect(within(block).getByLabelText('Lot')).toBeDisabled();
    expect(within(block).queryByRole('group')).toBeNull();
  });

  it('lot en cours : coût par tête, liste tronquée, lot gardé après relecture, écritures remises à zéro, tronquées et gardées sous l’échec', async () => {
    await rememberRoles(['FINANCE']);
    const active = (id: string, lotCode: string): LotChoice => ({
      ...lots[0]!,
      id,
      lotCode,
      status: 'ACTIVE',
      occurredAt: '2026-09-15T08:00:00.000Z',
    });
    const pages: Routes = {};
    for (let page = 0; page < 6; page += 1) {
      const path =
        page === 0 ? ENTRIES(ACTIVE_LOT) : `${ENTRIES(ACTIVE_LOT)}&cursor=n${String(page)}`;
      pages[path] = {
        cost_entries: [{ ...entries[0]!, id: `p${String(page)}`, comment: `page ${String(page)}` }],
        next_cursor: `n${String(page + 1)}`,
      };
    }
    const routes: Routes = {
      ...baseRoutes(),
      ...pages,
      '/api/v1/production/lots?status=ACTIVE&limit=50': {
        lots: [active(ACTIVE_LOT, 'BP-2026-09'), active(ACTIVE_LOT_2, 'BP-2026-10')],
        next_cursor: 'suite',
      },
      [`/api/v1/production/lots/${ACTIVE_LOT}`]: {
        lot: {
          ...lotMargins,
          id: ACTIVE_LOT,
          lotCode: 'BP-2026-09',
          status: 'ACTIVE',
          costs: { ...lotMargins.costs, remainingXaf: 1_200_000, costPerHeadXaf: 600 },
          sales: noSales,
        },
      },
      [`/api/v1/production/lots/${ACTIVE_LOT_2}`]: {
        lot: { ...lotMargins, id: ACTIVE_LOT_2, lotCode: 'BP-2026-10', status: 'ACTIVE' },
      },
    };
    serve(routes);
    const user = userEvent.setup();
    renderScreen();
    const block = await screen.findByRole('region', { name: 'Coûts et marges d’un lot' });
    await user.selectOptions(within(block).getByLabelText('Lots'), 'ACTIVE');
    expect(
      await within(block).findByText('Seuls les 50 lots les plus récents sont proposés.'),
    ).toBeInTheDocument();
    const lotSelect = within(block).getByLabelText('Lot');
    await within(lotSelect).findByRole('option', { name: 'BP-2026-09 · Poulet de chair' });
    await user.selectOptions(lotSelect, ACTIVE_LOT);
    const card = await within(block).findByRole('group', { name: 'Lot BP-2026-09' });
    expect(within(card).getByText(/^Coût restant par tête : 600 F CFA$/)).toBeInTheDocument();
    expect(
      within(card).getByText(/^Coût net 5\s600\s000 F CFA · coût restant 1\s200\s000 F CFA$/),
    ).toBeInTheDocument();
    expect(within(card).getByText('Aucune vente pour ce lot.')).toBeInTheDocument();

    // Écritures : cinq pages au plus, la liste est annoncée partielle.
    await user.click(
      within(card).getByRole('button', { name: 'Voir les écritures de coût de BP-2026-09' }),
    );
    expect(
      await within(card).findByText(
        'Liste partielle : seules les écritures les plus récentes sont affichées.',
      ),
    ).toBeInTheDocument();
    expect(within(card).getAllByText(/ · page \d$/)).toHaveLength(5);
    expect(readsOf(`${ENTRIES(ACTIVE_LOT)}&cursor=n5`)).toBe(0);

    // Relecture en échec : les écritures déjà lues restent, l'échec est annoncé.
    serve({ ...routes, [ENTRIES(ACTIVE_LOT)]: BROKEN });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await within(card).findByText(/^Écritures de coût indisponibles/)).toBeInTheDocument();
    expect(within(card).getAllByText(/ · page \d$/)).toHaveLength(5);

    // Lot sorti de la liste relue : toujours choisi et proposé.
    serve({
      ...routes,
      '/api/v1/production/lots?status=ACTIVE&limit=50': { lots: [], next_cursor: null },
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await within(block).findByText('Aucun lot dans ce statut.')).toBeInTheDocument();
    expect(lotSelect).toBeEnabled();
    expect(lotSelect).toHaveValue(ACTIVE_LOT);
    expect(
      within(lotSelect).getByRole('option', { name: 'BP-2026-09 · Poulet de chair' }),
    ).toBeInTheDocument();

    // Changement de lot : les écritures du lot précédent ne restent pas ouvertes.
    serve(routes);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await within(lotSelect).findByRole('option', { name: 'BP-2026-10 · Poulet de chair' });
    await user.selectOptions(lotSelect, ACTIVE_LOT_2);
    const second = await within(block).findByRole('group', { name: 'Lot BP-2026-10' });
    expect(
      within(second).getByRole('button', { name: 'Voir les écritures de coût de BP-2026-10' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(within(second).queryByText(/ · page \d$/)).toBeNull();
  });

  it('pannes et refus : chaque section à part, avec sa relance ; refus sans relance', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [MONTH]: BROKEN,
      [LOSSES('product')]: DENIED,
      '/api/v1/production/lots?status=CLOSED&limit=50': BROKEN,
    });
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/^Vue d’ensemble indisponible/)).toBeInTheDocument();
    expect(await screen.findByText(/^Lots indisponibles/)).toBeInTheDocument();
    const lossBlock = screen.getByRole('region', { name: 'Pertes de la période' });
    expect(
      await within(lossBlock).findByText(/^Non accessible avec vos droits\./),
    ).toBeInTheDocument();
    expect(within(lossBlock).queryByRole('button', { name: 'Relire les pertes' })).toBeNull();
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Relire la vue d’ensemble' }));
    expect(await screen.findByText('Soldes au 10 octobre 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Relire les lots' }));
    const lotSelect = screen.getByLabelText('Lot');
    await within(lotSelect).findAllByRole('option', { name: /^BP-2026/ });

    serve({
      ...baseRoutes(),
      [`/api/v1/production/lots/${LOT}`]: BROKEN,
    });
    await user.selectOptions(lotSelect, LOT);
    expect(await screen.findByText(/^Fiche du lot indisponible/)).toBeInTheDocument();
    serve({
      ...baseRoutes(),
      [`/api/v1/costs?cost_object_type=PRODUCTION_LOT&cost_object_id=${LOT}&limit=200`]: BROKEN,
    });
    await user.click(screen.getByRole('button', { name: 'Relire la fiche du lot' }));
    await user.click(
      await screen.findByRole('button', { name: 'Voir les écritures de coût de BP-2026-07' }),
    );
    expect(await screen.findByText(/^Écritures de coût indisponibles/)).toBeInTheDocument();
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Relire les écritures de coût' }));
    expect(await screen.findByText(/^1 juillet 2026 · Animaux/)).toBeInTheDocument();

    // Pertes en panne : relance proposée.
    serve({ ...baseRoutes(), [LOSSES('reason')]: BROKEN });
    await user.selectOptions(within(lossBlock).getByLabelText('Regrouper les pertes'), 'reason');
    expect(await within(lossBlock).findByText(/^Pertes indisponibles/)).toBeInTheDocument();
    serve({
      ...baseRoutes(),
      [LOSSES('reason')]: { ...losses, group_by: 'reason', lines: [], total_value_xaf: 0 },
    });
    await user.click(within(lossBlock).getByRole('button', { name: 'Relire les pertes' }));
    expect(
      await within(lossBlock).findByText('Aucune perte déclarée sur la période.'),
    ).toBeInTheDocument();
  });

  it('retour sur l’écran : relecture, la dernière lecture reste affichée pendant l’actualisation', async () => {
    await rememberRoles(['FINANCE']);
    renderScreen();
    const block = await screen.findByRole('region', { name: 'Vue d’ensemble de la période' });
    await within(block).findByText('Soldes au 10 octobre 2026');
    expect(within(block).queryByText('Actualisation en cours…')).toBeNull();
    serve({ ...baseRoutes(), [MONTH]: NEVER });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await within(block).findByText('Actualisation en cours…')).toBeInTheDocument();
    expect(within(block).getByText('Soldes au 10 octobre 2026')).toBeInTheDocument();
    expect(readsOf(MONTH)).toBe(2);
  });

  it('hors ligne : la dernière lecture reste, sans actualisation ; sans lecture, en ligne seulement', async () => {
    await rememberRoles(['FINANCE']);
    const { unmount } = renderScreen();
    await screen.findByText('Soldes au 10 octobre 2026');
    act(() => reportSyncOutcome('OFFLINE'));
    expect(
      await screen.findByText('Hors ligne : les chiffres affichés peuvent être périmés.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Soldes au 10 octobre 2026')).toBeInTheDocument();
    expect(screen.queryByText('Actualisation en cours…')).toBeNull();
    unmount();
    renderScreen();
    expect(
      await screen.findAllByText('Lecture en ligne seulement : reconnectez-vous pour l’afficher.'),
    ).toHaveLength(3);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { LotSheetScreen } from './LotSheetScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});

const LOT = '01900000-0000-7000-8000-0000000009a1';
const BUILDING = '01900000-0000-7000-8000-0000000009a2';
const STOCK_LOT = '01900000-0000-7000-8000-0000000009a3';

const SHEET = {
  id: LOT,
  lotCode: 'LOT-MFO-2026-004',
  lotType: 'POULET_CHAIR',
  productId: IDS.chicken,
  status: 'ACTIVE',
  startDate: '2026-09-20',
  initialQuantity: 1000,
  headcount: { unsold: 950, rearing: 950 },
  mortality: { countedQuantity: 40, pendingQuantity: 10, pendingCount: 1, lostQuantity: 50 },
  indicators: {
    mortalityRate: 0.04,
    averageDailyGainG: 52.3,
    feedConversionRatio: 1.62,
    layingRate: null,
    eggsCollected: null,
  },
  costs: {
    breakdown: [
      { costType: 'ANIMAUX', debitXaf: 450000, creditXaf: 0, netXaf: 450000 },
      { costType: 'ALIMENT', debitXaf: 900000, creditXaf: 0, netXaf: 900000 },
    ],
    netXaf: 1350000,
    remainingXaf: 1350000,
    costPerHeadXaf: 1421,
    monthly: [
      { period: '2026-09', debitXaf: 1350000, creditXaf: 0, netXaf: 1350000, revenueXaf: 0 },
    ],
  },
  sales: {
    grossRevenueXaf: 0,
    cancelledXaf: 0,
    netRevenueXaf: 0,
    costOfSalesXaf: 0,
    soldQuantity: 0,
    lotMarginXaf: -1350000,
    grossMarginXaf: 0,
  },
  entries: [
    { id: 'e1', sourceKind: 'PURCHASE', quantity: 1000, status: 'POSTED', valueXaf: 450000 },
  ],
  weighings: [
    {
      id: 'w1',
      sampleSize: 20,
      avgWeightG: 1250.5,
      occurredAt: '2026-10-09T07:00:00.000Z',
      status: 'RECORDED',
    },
  ],
};

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={[`/production/fiche?lot=${LOT}`]}>
      <LotSheetScreen />
    </MemoryRouter>,
  );
}

describe('Fiche lot (ECR-PRD-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      {
        key: `production:PRODUCTION_LOT:${LOT}`,
        dataset: 'production',
        entity_type: 'PRODUCTION_LOT',
        entity_id: LOT,
        scope_type: 'SITE',
        scope_id: IDS.site,
        row_version: 1,
        seq: 1,
        data: {
          id: LOT,
          lot_code: 'LOT-MFO-2026-004',
          lot_type: 'POULET_CHAIR',
          product_id: IDS.chicken,
          stock_lot_id: STOCK_LOT,
          site_id: IDS.site,
          main_location_id: BUILDING,
          strain: null,
          status: 'ACTIVE',
          start_date: '2026-09-20',
          planned_end_date: null,
          initial_quantity: 1000,
          occurred_at: '2026-09-20T08:00:00.000Z',
        },
      },
    ]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
  });

  it('en ligne : effectif, indicateurs, coûts, marges et pesées du serveur', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({ ok: true, data: { lot: SHEET } } as never);
    renderScreen();
    const heads = within(await screen.findByRole('region', { name: 'Effectif' }));
    expect(await heads.findByText('Morts en attente de validation')).toBeInTheDocument();
    expect(heads.getByText('Non vendu').nextElementSibling).toHaveTextContent('950 U');
    const indicators = within(screen.getByRole('region', { name: 'Indicateurs' }));
    expect(indicators.getByText('Taux de mortalité').nextElementSibling).toHaveTextContent('4 %');
    expect(indicators.getByText('Gain moyen quotidien').nextElementSibling).toHaveTextContent(
      /52,3 g\/jour/,
    );
    const costs = within(screen.getByRole('region', { name: 'Coûts' }));
    expect(costs.getByText('Coût par tête').nextElementSibling).toHaveTextContent(/1\s421\sF/);
    const sales = within(screen.getByRole('region', { name: 'Ventes et marges' }));
    expect(sales.getByText('Marge du lot').nextElementSibling).toHaveTextContent(
      /-1\s350\s000|−1\s350\s000/,
    );
    expect(screen.getByText(/1\s250,5 g en moyenne \(20 sujets\)/)).toBeInTheDocument();
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/production/lots/${LOT}`,
      { method: 'GET' },
    );
  });

  it('sans droit de valorisation : montants masqués annoncés', async () => {
    const masked = {
      ...SHEET,
      costs: { ...SHEET.costs, netXaf: null, remainingXaf: null, costPerHeadXaf: null },
    };
    vi.mocked(authorizedRequest).mockResolvedValue({ ok: true, data: { lot: masked } } as never);
    renderScreen();
    expect(
      await screen.findByText('Montants réservés aux rôles qui voient les valorisations.'),
    ).toBeInTheDocument();
  });

  it('hors ligne : effectif estimé par le téléphone, aucune lecture', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(
      await screen.findByText(/Hors ligne : effectif calculé par ce téléphone/),
    ).toBeInTheDocument();
    expect(screen.getByText('En élevage (estimation du téléphone)')).toBeInTheDocument();
    expect(authorizedRequest).not.toHaveBeenCalled();
  });
});

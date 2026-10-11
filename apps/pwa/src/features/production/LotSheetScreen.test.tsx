import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const CLOSED_LOT = '01900000-0000-7000-8000-0000000009a4';

/** Masquage du serveur sans droit de valorisation : toute clé en …Xaf à null, récursivement. */
function maskAmounts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAmounts);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key.endsWith('Xaf') ? null : maskAmounts(item),
      ]),
    );
  }
  return value;
}

/** Réponses du serveur : lots clôturés, puis fiche demandée. */
function serve(sheets: Record<string, unknown>) {
  vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => {
    if (path.startsWith('/api/v1/production/lots?')) {
      return {
        ok: true,
        data: {
          lots: [
            {
              id: CLOSED_LOT,
              lotCode: 'LOT-MFO-2025-009',
              lotType: 'POULET_CHAIR',
              status: 'CLOSED',
            },
          ],
          next_cursor: null,
        },
      } as never;
    }
    const id = path.split('/').pop() ?? '';
    const sheet = sheets[decodeURIComponent(id)];
    return (
      sheet
        ? { ok: true, data: { lot: sheet } }
        : { ok: false, reason: 'HTTP_ERROR', status: 404, body: null }
    ) as never;
  });
}

function renderScreen(lotId: string = LOT) {
  return render(
    <MemoryRouter initialEntries={[`/production/fiche?lot=${lotId}`]}>
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
    serve({ [LOT]: SHEET });
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
    // Dates avec l'année : démarrage, pesée, mois du résultat.
    expect(screen.getByText(/démarré le 20 septembre 2026/)).toBeInTheDocument();
    expect(screen.getByText(/9 oct\. 2026/)).toBeInTheDocument();
    expect(screen.getByText('septembre 2026')).toBeInTheDocument();
    // Les lots clôturés, sortis du jeu de l'appareil, restent consultables en ligne.
    expect(
      await screen.findByRole('option', { name: 'LOT-MFO-2025-009 · Poulet de chair' }),
    ).toBeInTheDocument();
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/production/lots/${LOT}`,
      { method: 'GET' },
    );
  });

  it('sans droit de valorisation : aucun montant, masquage annoncé dans les coûts et les ventes', async () => {
    serve({ [LOT]: maskAmounts(SHEET) });
    renderScreen();
    const costs = within(await screen.findByRole('region', { name: 'Coûts' }));
    expect(
      costs.getByText('Montants réservés aux rôles qui voient les valorisations.'),
    ).toBeInTheDocument();
    const sales = within(screen.getByRole('region', { name: 'Ventes et marges' }));
    expect(
      sales.getByText('Montants réservés aux rôles qui voient les valorisations.'),
    ).toBeInTheDocument();
    for (const region of ['Coûts', 'Ventes et marges']) {
      expect(screen.getByRole('region', { name: region })).not.toHaveTextContent(/F CFA/);
    }
    expect(screen.queryByRole('region', { name: 'Résultat mensuel' })).not.toBeInTheDocument();
  });

  it('lot demandé absent de l’appareil : lu en ligne, introuvable annoncé sans afficher un autre lot', async () => {
    serve({
      [CLOSED_LOT]: {
        ...SHEET,
        id: CLOSED_LOT,
        lotCode: 'LOT-MFO-2025-009',
        status: 'CLOSED',
        closedAt: '2026-03-02T10:00:00.000Z',
      },
    });
    renderScreen(CLOSED_LOT);
    expect(await screen.findByText(/clôturé le 2 mars 2026/)).toBeInTheDocument();
    expect(screen.getByLabelText('Lot')).toHaveValue(CLOSED_LOT);
    cleanup();

    renderScreen('01900000-0000-7000-8000-0000000009ff');
    expect(
      await screen.findByText('Lot introuvable ou hors de votre périmètre.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Indicateurs' })).not.toBeInTheDocument();
    expect(screen.queryByText('Réessayer')).not.toBeInTheDocument();
  });

  it('sans lot demandé : le lot ouvert reste choisi quand des lots clôturés arrivent', async () => {
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => {
      if (path.startsWith('/api/v1/production/lots?')) {
        return {
          ok: true,
          data: {
            lots: [
              {
                id: CLOSED_LOT,
                lotCode: 'LOT-MFO-2026-012',
                lotType: 'POULET_CHAIR',
                status: 'CLOSED',
              },
            ],
            next_cursor: null,
          },
        } as never;
      }
      return { ok: true, data: { lot: SHEET } } as never;
    });
    render(
      <MemoryRouter initialEntries={['/production/fiche']}>
        <LotSheetScreen />
      </MemoryRouter>,
    );
    const select = await screen.findByLabelText('Lot');
    expect(await within(select).findByRole('group', { name: 'Lots clôturés' })).toBeInTheDocument();
    expect(select).toHaveValue(LOT);
  });

  it('passage hors ligne après lecture : estimation du téléphone, fiche serveur retirée', async () => {
    serve({ [LOT]: SHEET });
    renderScreen();
    await screen.findByRole('region', { name: 'Indicateurs' });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(
      await screen.findByText(/Hors ligne : effectif calculé par ce téléphone/),
    ).toBeInTheDocument();
    expect(screen.getByText('En élevage (estimation du téléphone)')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Indicateurs' })).not.toBeInTheDocument();
  });

  it('lots clôturés indisponibles : annoncés, relus par « Réessayer »', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) =>
        (path.startsWith('/api/v1/production/lots?')
          ? { ok: false, reason: 'HTTP_ERROR', status: 503, body: null }
          : { ok: true, data: { lot: SHEET } }) as never,
    );
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Lots clôturés indisponibles/)).toBeInTheDocument();
    serve({ [LOT]: SHEET });
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(
      await screen.findByRole('option', { name: 'LOT-MFO-2025-009 · Poulet de chair' }),
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

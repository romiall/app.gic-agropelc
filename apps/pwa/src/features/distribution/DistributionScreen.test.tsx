import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DistributionDashboardResponse, DistributionPointOfSale } from '@gic/contracts';
import { authorizedRequest } from '../../sync/api-client.js';
import { resetConnectivityForTests } from '../../platform/connectivity.js';
import { DistributionScreen } from './DistributionScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));

const request = vi.mocked(authorizedRequest);

const SITE = '01900000-0000-7000-8000-000000000020';
const OTHER_SITE = '01900000-0000-7000-8000-000000000021';

function pointOfSale(overrides: Partial<DistributionPointOfSale> = {}): DistributionPointOfSale {
  return {
    siteId: SITE,
    siteCode: 'PDV-YDE',
    siteName: 'PDV de Yaoundé',
    siteStatus: 'ACTIVE',
    zoneId: '01900000-0000-7000-8000-000000000010',
    salesLocationId: '01900000-0000-7000-8000-000000000030',
    custodyMode: 'SHARED',
    products: [
      {
        productId: '01900000-0000-7000-8000-000000000040',
        productCode: 'OEUF',
        productName: 'Œufs de table',
        baseUnitCode: 'U',
        stocked: true,
        sentQty: 600,
        receivedQty: 570,
        soldNetQty: 450,
        soldNetXaf: 45_000,
        lostQty: 12,
        lostPendingQty: 6,
        transitPendingQty: 30,
        openingQty: 100,
        remainingQty: 202,
        toDeliverQty: 0,
        allocatedQty: 90,
        unallocatedQty: 112,
        overcommitted: false,
        replenish: {
          minQty: 300,
          targetQty: 600,
          availableQty: 202,
          inTransitInQty: 0,
          state: 'STOCK_LOW',
          suggestedQty: 398,
        },
        remainingValueXaf: null,
        lostValueXaf: null,
        reconciliation: { residualQty: -6, reconciled: false, salesMatchLedger: true },
      },
    ],
    sales: { soldXaf: 47_000, cancelledXaf: 2_000, netXaf: 45_000 },
    cashed: {
      amountXaf: 40_000,
      paymentsCount: 9,
      byMethod: [{ paymentMethodCode: 'ESPECES', amountXaf: 40_000, paymentsCount: 9 }],
      byReceiver: null,
    },
    cash: {
      accountsCount: 1,
      openSession: {
        status: 'OPEN',
        businessDate: '2026-10-10',
        openedAt: '2026-10-10T06:00:00.000Z',
        closedAt: null,
        varianceXaf: null,
        currentVarianceXaf: -500,
        forceClosed: false,
        severity: 'WARNING',
        openLong: false,
        detail: null,
      },
      sessionOfDay: null,
      pendingValidationCount: 1,
      pendingAdjustmentsCount: 0,
      transfers: { inTransitCount: 0, inTransitXaf: 0, overdueCount: 0, discrepancyCount: 0 },
    },
    devices: {
      count: 1,
      staleCount: 1,
      lastContactAt: '2026-10-08T17:00:00.000Z',
      items: [
        {
          deviceId: '01900000-0000-7000-8000-0000000000d0',
          shortCode: 'TAB-01',
          label: 'Tablette du comptoir',
          status: 'ACTIVE',
          isShared: true,
          lastContactAt: '2026-10-08T17:00:00.000Z',
          stale: true,
          pendingReported: 3,
          authors: null,
        },
      ],
    },
    reconciled: false,
    ...overrides,
  };
}

function response(points: DistributionPointOfSale[]): DistributionDashboardResponse {
  return {
    generatedAt: '2026-10-10T09:00:00.000Z',
    businessDay: '2026-10-10',
    period: { code: 'TODAY', fromDay: '2026-10-10', toDay: '2026-10-10' },
    scope: { allSites: false, pointsOfSaleCount: points.length },
    freshness: { warningHours: 24, devicesCount: 1, staleDevices: 1 },
    totals: {
      soldNetXaf: 45_000,
      cashedXaf: 40_000,
      paymentsCount: 9,
      remainingValueXaf: null,
      lostValueXaf: null,
      cashSessionsToValidate: 1,
      cashAdjustmentsToValidate: 0,
      cashTransfers: {
        inTransitCount: 1,
        inTransitXaf: 150_000,
        overdueCount: 1,
        overdueXaf: 150_000,
        discrepancyCount: 0,
        unreceivedHours: 48,
      },
    },
    products: [],
    pointsOfSale: points,
  };
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <DistributionScreen />
    </MemoryRouter>,
  );
}

describe('Distribution par point de vente (ECR-DIS-04)', () => {
  beforeEach(() => {
    resetConnectivityForTests();
    request.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('en ligne : période, fraîcheur, totaux, caisse, appareils et produits ; mesures masquées absentes', async () => {
    request.mockResolvedValue({ ok: true, data: response([pointOfSale()]) });
    renderScreen();
    const pos = await screen.findByRole('region', { name: 'PDV de Yaoundé' });
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/analytics/dashboards/distribution?period=TODAY',
      { method: 'GET' },
    );
    expect(
      screen.getByText(
        /1 appareil sans contact depuis plus de 24 h : ses opérations peuvent manquer\./,
      ),
    ).toBeInTheDocument();
    const totals = screen.getByRole('region', { name: 'Total (1 point de vente)' });
    expect(within(totals).getByText(/^45\s000 F CFA$/)).toBeInTheDocument();
    expect(within(totals).getByText(/40\s000 F CFA \(9 encaissements\)/)).toBeInTheDocument();
    // Valeur du restant et des pertes masquées par le serveur : rien d'affiché, jamais 0.
    expect(screen.queryByText('Valeur du restant')).not.toBeInTheDocument();
    expect(
      within(totals).getByText(
        /1 remise\(s\) non reçue\(s\) depuis plus de 48 h : 150\s000 F CFA\./,
      ),
    ).toBeInTheDocument();

    expect(
      within(pos).getByText(/Écart de rapprochement : le stock ne se reconstitue pas/),
    ).toBeInTheDocument();
    expect(within(pos).getByText(/45\s000 F CFA net \(2\s000 F CFA annulé\)/)).toBeInTheDocument();
    expect(within(pos).getByText(/ESPECES : 40\s000 F CFA \(9\)/)).toBeInTheDocument();
    expect(
      within(pos).getByText(/Session ouverte depuis le .*\(ouverte\), écart courant : -500 F CFA/),
    ).toBeInTheDocument();
    expect(
      within(pos).getByText(/Tablette du comptoir : sans contact depuis le .*, 3 opération\(s\)/),
    ).toBeInTheDocument();
    const product = within(pos).getByRole('listitem', { name: 'Œufs de table' });
    expect(within(product).getByText('600 U')).toBeInTheDocument();
    expect(within(product).getByText(/450 U \(45\s000 F CFA\)/)).toBeInTheDocument();
    expect(within(product).getByText(/12 U \(\+ 6 U en attente\)/)).toBeInTheDocument();
    expect(within(product).getByText('202 U')).toBeInTheDocument();
    expect(within(product).getByText('90 U alloué, 112 U libre')).toBeInTheDocument();
    expect(within(product).getByText('À réapprovisionner : 398 U')).toBeInTheDocument();
    expect(within(product).getByText('Écart de rapprochement : -6 U')).toBeInTheDocument();
  });

  it('changement de période : nouvelle lecture ; plusieurs PDV filtrés sur l’appareil', async () => {
    request.mockResolvedValue({
      ok: true,
      data: response([
        pointOfSale(),
        pointOfSale({ siteId: OTHER_SITE, siteCode: 'PDV-DLA', siteName: 'PDV de Douala' }),
      ]),
    });
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByRole('region', { name: 'PDV de Douala' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Point de vente'), OTHER_SITE);
    expect(screen.queryByRole('region', { name: 'PDV de Yaoundé' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Période'), 'WEEK');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        '/api/v1/analytics/dashboards/distribution?period=WEEK',
        { method: 'GET' },
      ),
    );
  });

  it('hors ligne : tableau en ligne seulement, aucune lecture', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(screen.getByText(/Tableau en ligne seulement/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('refus de droit, puis serveur muet avec nouvel essai ; périmètre vide', async () => {
    request.mockResolvedValue({ ok: false, reason: 'HTTP_ERROR', status: 403, body: null });
    const { unmount } = renderScreen();
    expect(await screen.findByText('Tableau non accessible avec vos droits.')).toBeInTheDocument();
    unmount();

    request.mockResolvedValueOnce({ ok: false, reason: 'HTTP_ERROR', status: 500, body: null });
    request.mockResolvedValue({ ok: true, data: response([]) });
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Tableau indisponible/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(
      await screen.findByText('Aucun point de vente dans votre périmètre.'),
    ).toBeInTheDocument();
  });
});

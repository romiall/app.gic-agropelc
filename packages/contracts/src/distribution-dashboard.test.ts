import { describe, expect, it } from 'vitest';
import {
  DISTRIBUTION_PERIOD_CODES,
  distributionDashboardResponseSchema,
  distributionPointOfSaleSchema,
  distributionProductRowSchema,
} from './distribution-dashboard.js';

const ID = '01a12a80-b8df-7d48-8dab-50e0d3bab4ec';
const ID2 = '01a12a80-b9ac-71f3-bf12-dc418f767f89';

const row = {
  productId: ID,
  productCode: 'POULET',
  productName: 'Poulet de chair',
  baseUnitCode: 'PIECE',
  stocked: true,
  sentQty: -30,
  receivedQty: 129,
  soldNetQty: 11,
  soldNetXaf: 11_000,
  lostQty: 5,
  lostPendingQty: 0,
  transitPendingQty: 0,
  openingQty: 0,
  remainingQty: 115,
  toDeliverQty: 3,
  allocatedQty: 9,
  unallocatedQty: 106,
  overcommitted: false,
  replenish: {
    minQty: 20,
    targetQty: 50,
    availableQty: 115,
    inTransitInQty: 0,
    state: 'OK',
    suggestedQty: 0,
  },
  remainingValueXaf: 57_500,
  lostValueXaf: 2_500,
  reconciliation: { residualQty: 0, reconciled: true, salesMatchLedger: true },
} as const;

const session = {
  status: 'PENDING_VALIDATION',
  businessDate: '2026-09-15',
  openedAt: '2026-09-15T07:30:00.000Z',
  closedAt: '2026-09-15T18:00:00.000Z',
  varianceXaf: -6_000,
  currentVarianceXaf: -6_000,
  forceClosed: false,
  severity: 'CRITICAL',
  openLong: false,
  detail: { sessionId: ID, openedByUserId: ID2 },
} as const;

const pointOfSale = {
  siteId: ID,
  siteCode: 'PDV-01',
  siteName: 'PDV du marché',
  siteStatus: 'ACTIVE',
  zoneId: ID2,
  salesLocationId: ID2,
  custodyMode: 'SHARED',
  products: [row],
  sales: { soldXaf: 15_000, cancelledXaf: 4_000, netXaf: 11_000 },
  cashed: {
    amountXaf: 5_000,
    paymentsCount: 1,
    byMethod: [{ paymentMethodCode: 'ESPECES', amountXaf: 5_000, paymentsCount: 1 }],
    byReceiver: [{ userId: ID, fullName: 'Awa Ngo', amountXaf: 5_000, paymentsCount: 1 }],
  },
  cash: {
    accountsCount: 1,
    openSession: null,
    sessionOfDay: session,
    pendingValidationCount: 1,
    pendingAdjustmentsCount: 0,
    transfers: { inTransitCount: 1, inTransitXaf: 1_000, overdueCount: 1, discrepancyCount: 0 },
  },
  devices: {
    count: 1,
    staleCount: 0,
    lastContactAt: '2026-10-11T08:00:00.000Z',
    items: [
      {
        deviceId: ID,
        shortCode: 'TAB-01',
        label: null,
        status: 'ACTIVE',
        isShared: true,
        lastContactAt: '2026-10-11T08:00:00.000Z',
        stale: false,
        pendingReported: 0,
        authors: [
          {
            userId: ID2,
            lastPushAt: null,
            lastPullAt: '2026-10-11T08:00:00.000Z',
            pendingReported: null,
          },
        ],
      },
    ],
  },
  reconciled: true,
} as const;

const response = {
  generatedAt: '2026-10-11T08:00:00.000Z',
  businessDay: '2026-10-11',
  period: { code: 'CUSTOM', fromDay: '2026-09-15', toDay: '2026-09-17' },
  scope: { allSites: false, pointsOfSaleCount: 1 },
  freshness: { warningHours: 2, devicesCount: 1, staleDevices: 0 },
  totals: {
    soldNetXaf: 11_000,
    cashedXaf: 5_000,
    paymentsCount: 1,
    remainingValueXaf: 57_500,
    lostValueXaf: 2_500,
    cashSessionsToValidate: 1,
    cashAdjustmentsToValidate: 0,
    cashTransfers: {
      inTransitCount: 1,
      inTransitXaf: 1_000,
      overdueCount: 1,
      overdueXaf: 1_000,
      discrepancyCount: 0,
      unreceivedHours: 48,
    },
  },
  products: [
    {
      productId: ID,
      productCode: 'POULET',
      baseUnitCode: 'PIECE',
      stocked: true,
      sentQty: -30,
      receivedQty: 129,
      soldNetQty: 11,
      lostQty: 5,
      remainingQty: 115,
      toDeliverQty: 3,
    },
  ],
  pointsOfSale: [pointOfSale],
} as const;

describe('tableau de distribution (P5-20, ECR-DIS-04)', () => {
  it('accepte une réponse complète, sans perte de champ', () => {
    expect(distributionDashboardResponseSchema.parse(response)).toEqual(response);
    expect(DISTRIBUTION_PERIOD_CODES).toContain('CUSTOM');
  });

  it('accepte les mesures masquées et le détail absent (AV-205, AV-206)', () => {
    const masked = {
      ...response,
      totals: { ...response.totals, remainingValueXaf: null, lostValueXaf: null },
      pointsOfSale: [
        {
          ...pointOfSale,
          products: [{ ...row, remainingValueXaf: null, lostValueXaf: null }],
          cashed: { ...pointOfSale.cashed, byReceiver: null },
          cash: { ...pointOfSale.cash, sessionOfDay: { ...session, detail: null } },
          devices: {
            ...pointOfSale.devices,
            items: [{ ...pointOfSale.devices.items[0], authors: null }],
          },
        },
      ],
    };
    expect(distributionDashboardResponseSchema.parse(masked)).toEqual(masked);
  });

  it('accepte une ligne de service sans champ de stock', () => {
    const service = {
      ...row,
      stocked: false,
      sentQty: null,
      receivedQty: null,
      lostQty: null,
      lostPendingQty: null,
      transitPendingQty: null,
      openingQty: null,
      remainingQty: null,
      allocatedQty: null,
      unallocatedQty: null,
      overcommitted: null,
      replenish: null,
      remainingValueXaf: null,
      lostValueXaf: null,
      reconciliation: null,
    };
    expect(distributionProductRowSchema.parse(service)).toEqual(service);
  });

  it('refuse un montant non entier, un compte négatif, une période ou un état inconnus', () => {
    expect(() => distributionProductRowSchema.parse({ ...row, soldNetXaf: 10.5 })).toThrow();
    expect(() =>
      distributionPointOfSaleSchema.parse({
        ...pointOfSale,
        cashed: { ...pointOfSale.cashed, paymentsCount: -1 },
      }),
    ).toThrow();
    expect(() =>
      distributionDashboardResponseSchema.parse({
        ...response,
        period: { ...response.period, code: 'QUARTER' },
      }),
    ).toThrow();
    expect(() =>
      distributionDashboardResponseSchema.parse({ ...response, businessDay: '11/10/2026' }),
    ).toThrow();
    expect(() =>
      distributionPointOfSaleSchema.parse({ ...pointOfSale, custodyMode: 'EXCLUSIVE_USER' }),
    ).toThrow();
    expect(() =>
      distributionProductRowSchema.parse({
        ...row,
        replenish: { ...row.replenish, state: 'LOW' },
      }),
    ).toThrow();
    // Bornes des libellés = colonnes varchar(200) : un nom valide en base ne casse jamais la réponse.
    expect(
      distributionProductRowSchema.parse({ ...row, productName: 'x'.repeat(200) }).productName,
    ).toHaveLength(200);
    expect(() =>
      distributionProductRowSchema.parse({ ...row, productName: 'x'.repeat(201) }),
    ).toThrow();
  });
});

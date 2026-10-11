/**
 * Composition du tableau de distribution (P5-20 ; BR-DIS-010, KPI-DIS-01 à 07 ; ADR-035) : un appel par
 * fonction de métrique des modules (P5-19, P5-20), pour **tous** les PDV du périmètre à la fois (seuls
 * les seuils de caisse se lisent site par site, en parallèle), puis assemblage par PDV × produit. Le
 * contrôleur passe une transaction `REPEATABLE READ` : toutes les lectures partagent un instantané, et le
 * rapprochement du vendu de `sales` avec le registre ne voit jamais une vente à moitié. Aucune écriture, aucun calcul métier propre : chaque
 * indicateur vient de la fonction du module qui le possède, partagée avec l'accueil (BR-ANA-009).
 *
 * Instants (AV-207) : envoyé, reçu, vendu, perdu et restant sur la **période** ; à livrer, quotas, à
 * réapprovisionner, caisse et fraîcheur à l'**instant** de lecture. Masquage (AV-205, AV-206) : `null`
 * pour une mesure dont le lecteur n'a pas le droit sur le site.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  businessDayOf,
  cashSessionOpenLongerThan,
  distributionResidual,
  quantityFromDecimal,
  quantityMilliUnits,
  varianceSeverity,
} from '@gic/domain';
import type {
  DistributionCashSession,
  DistributionDashboardResponse,
  DistributionPeriodCode,
  DistributionPointOfSale,
  DistributionProductRow,
} from '@gic/contracts';
import type { DB } from '../platform/kysely/database.js';
import { listProducts } from '../modules/catalog/application/public/index.js';
import {
  allocationPositions,
  distributionFlowsOf,
  distributionKpisOf,
  locationFlows,
  stockThresholdsOf,
} from '../modules/inventory/application/public/index.js';
import {
  cashedByGroup,
  soldByLocation,
  toDeliverByLocation,
} from '../modules/sales/application/public/index.js';
import {
  cashSessionThresholdsAt,
  cashSessionsOverview,
  pendingCashTransfers,
  type CashSessionBrief,
  type CashSessionThresholds,
} from '../modules/finance/application/public/index.js';
import { userFullNames } from '../modules/identity/application/public/index.js';
import { deviceFreshness, devicesOfSites } from '../sync/device-freshness.js';
import type { DistributionTargets } from '../read-api/distribution-targets.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Droits annexes d'un lecteur sur un site (AV-205, AV-206). */
export interface SiteVisibility {
  /** `inventory.valuation.read` : valeurs du restant et du perdu. */
  readonly value: boolean;
  /** `finance.cash.read` : identifiant et ouvreur d'une session. */
  readonly cashDetail: boolean;
  /** `sales.payment.read` : encaissé par receveur. */
  readonly receivers: boolean;
  /** `sync.monitor.read` : appareils par auteur. */
  readonly authors: boolean;
}

export interface DistributionDashboardInput {
  readonly targets: DistributionTargets;
  readonly period: {
    readonly code: DistributionPeriodCode;
    readonly fromDay: string;
    readonly toDay: string;
  };
  readonly now: Date;
  readonly productIds?: readonly string[];
  readonly visibility: (siteId: string) => SiteVisibility;
  readonly allSites: boolean;
}

const milli = (value: number): number => quantityMilliUnits(quantityFromDecimal(value));
const qtyOf = (millis: number): number => millis / 1000;
const keyOf = (location: string, product: string) => `${location}|${product}`;
const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

function sessionView(
  brief: CashSessionBrief,
  thresholds: CashSessionThresholds,
  now: Date,
  cashDetail: boolean,
): DistributionCashSession {
  const variance = brief.currentVarianceXaf ?? brief.varianceXaf;
  const severity =
    variance === null || Math.abs(variance) <= thresholds.varianceToleranceXaf
      ? 'NONE'
      : varianceSeverity(variance, thresholds.varianceCriticalXaf);
  return {
    status: brief.status,
    businessDate: brief.businessDate,
    openedAt: brief.openedAt.toISOString(),
    closedAt: iso(brief.closedAt),
    varianceXaf: brief.varianceXaf,
    currentVarianceXaf: brief.currentVarianceXaf,
    forceClosed: brief.forceClosed,
    severity,
    openLong:
      brief.status === 'OPEN' &&
      cashSessionOpenLongerThan(brief.openedAt, now, thresholds.forceCloseHours),
    detail: cashDetail ? { sessionId: brief.id, openedByUserId: brief.openedBy } : null,
  };
}

export async function buildDistributionDashboard(
  executor: Executor,
  input: DistributionDashboardInput,
): Promise<DistributionDashboardResponse> {
  const { targets, now } = input;
  const period = { fromDay: input.period.fromDay, toDay: input.period.toDay };
  const locations = targets.salesLocationIds;
  const productFilter = input.productIds !== undefined ? { productIds: input.productIds } : {};
  const [
    products,
    flows,
    sold,
    toDeliver,
    allocations,
    thresholds,
    cashed,
    sessions,
    transfers,
    cashThresholds,
    devicesBySite,
  ] = await Promise.all([
    listProducts(executor),
    locationFlows(executor, { locationIds: locations, period, ...productFilter }),
    soldByLocation(executor, { locationIds: locations, period, ...productFilter }),
    toDeliverByLocation(executor, { locationIds: locations, ...productFilter }),
    allocationPositions(executor, { locationIds: locations, now, ...productFilter }),
    stockThresholdsOf(executor, { locationIds: locations, ...productFilter }),
    cashedByGroup(executor, { siteIds: targets.siteIds }, period),
    cashSessionsOverview(executor, {
      accountIds: targets.cashAccountIds,
      day: businessDayOf(now),
    }),
    pendingCashTransfers(executor, { accountIds: targets.cashAccountIds, now }),
    cashSessionThresholdsAt(executor, { siteIds: targets.siteIds, at: now }),
    devicesOfSites(executor, targets.siteIds),
  ]);
  const allDeviceIds = [...new Set([...devicesBySite.values()].flat())].sort();
  const freshness = await deviceFreshness(executor, { deviceIds: allDeviceIds, now });
  const receiverIds = [
    ...new Set(
      cashed
        .filter((group) => input.visibility(group.siteId).receivers)
        .map((group) => group.receivedByUserId),
    ),
  ];
  const names = receiverIds.length > 0 ? await userFullNames(executor, receiverIds) : new Map();

  const productById = new Map(products.map((product) => [product.id, product]));
  const flowByKey = new Map(flows.map((flow) => [keyOf(flow.locationId, flow.productId), flow]));
  const soldByKey = new Map(sold.map((line) => [keyOf(line.locationId, line.productId), line]));
  const deliverByKey = new Map(
    toDeliver.map((line) => [keyOf(line.locationId, line.productId), line]),
  );
  const allocationByKey = new Map(
    allocations.map((line) => [keyOf(line.locationId, line.productId), line]),
  );
  const thresholdByKey = new Map(
    thresholds.map((line) => [keyOf(line.locationId, line.productId), line]),
  );
  const deviceById = new Map(freshness.devices.map((device) => [device.deviceId, device]));

  const productTotals = new Map<
    string,
    {
      sent: number;
      received: number;
      soldNet: number;
      lost: number;
      remaining: number;
      toDeliver: number;
    }
  >();
  let valueMasked = false;
  let remainingValueTotal = 0;
  let lostValueTotal = 0;

  const pointsOfSale: DistributionPointOfSale[] = [];
  const ordered = [...targets.pointsOfSale].sort((a, b) => a.siteCode.localeCompare(b.siteCode));
  for (const pos of ordered) {
    const visibility = input.visibility(pos.siteId);
    const location = pos.salesLocationId;
    const productIds = new Set<string>();
    for (const map of [flowByKey, soldByKey, deliverByKey, allocationByKey, thresholdByKey]) {
      for (const key of map.keys()) {
        const [loc, product] = key.split('|') as [string, string];
        if (loc === location) productIds.add(product);
      }
    }
    const rows: DistributionProductRow[] = [];
    let soldXaf = 0;
    let cancelledXaf = 0;
    let netXaf = 0;
    let reconciled = true;
    for (const productId of productIds) {
      const product = productById.get(productId);
      if (product === undefined) continue;
      const key = keyOf(location, productId);
      const flow = flowByKey.get(key);
      const soldLine = soldByKey.get(key);
      soldXaf += soldLine?.soldXaf ?? 0;
      cancelledXaf += soldLine?.cancelledXaf ?? 0;
      netXaf += soldLine?.netXaf ?? 0;
      const stocked = product.stockFamily !== 'SERVICE';
      const kpis = flow !== undefined ? distributionKpisOf(flow) : undefined;
      const allocation = allocationByKey.get(key);
      const threshold = thresholdByKey.get(key);
      const toDeliverQty = deliverByKey.get(key)?.toDeliverQty ?? 0;
      const ledgerSoldNet = kpis?.soldNetQty ?? 0;
      const residual = flow !== undefined ? distributionResidual(distributionFlowsOf(flow)) : 0;
      const salesMatchLedger = milli(soldLine?.soldNetQty ?? 0) === milli(ledgerSoldNet);
      if (stocked && (residual !== 0 || !salesMatchLedger)) reconciled = false;
      const row: DistributionProductRow = {
        productId,
        productCode: product.code,
        productName: product.name,
        baseUnitCode: product.baseUnitCode,
        stocked,
        sentQty: stocked ? (kpis?.sentQty ?? 0) : null,
        receivedQty: stocked ? (kpis?.receivedQty ?? 0) : null,
        soldNetQty: stocked ? ledgerSoldNet : (soldLine?.soldNetQty ?? 0),
        soldNetXaf: soldLine?.netXaf ?? 0,
        lostQty: stocked ? (kpis?.lostQty ?? 0) : null,
        lostPendingQty: stocked ? (kpis?.lostPendingQty ?? 0) : null,
        transitPendingQty: stocked ? (kpis?.transitPendingQty ?? 0) : null,
        openingQty: stocked ? (kpis?.openingQty ?? 0) : null,
        remainingQty: stocked ? (kpis?.remainingQty ?? 0) : null,
        toDeliverQty,
        allocatedQty: stocked ? (allocation?.allocatedQty ?? 0) : null,
        unallocatedQty: stocked ? (allocation?.unallocatedQty ?? 0) : null,
        overcommitted: stocked ? (allocation?.overcommitted ?? false) : null,
        replenish:
          stocked && threshold !== undefined
            ? {
                minQty: threshold.minQtyBase,
                targetQty: threshold.targetQtyBase,
                availableQty: threshold.qtyAvailable,
                inTransitInQty: threshold.qtyInTransitIn,
                state: threshold.state,
                suggestedQty: threshold.suggestedQty,
              }
            : null,
        remainingValueXaf: stocked && visibility.value ? (kpis?.remainingValueXaf ?? 0) : null,
        lostValueXaf: stocked && visibility.value ? (kpis?.lostValueXaf ?? 0) : null,
        reconciliation: stocked
          ? { residualQty: residual, reconciled: residual === 0, salesMatchLedger }
          : null,
      };
      rows.push(row);
      if (stocked) {
        if (!visibility.value) valueMasked = true;
        remainingValueTotal += kpis?.remainingValueXaf ?? 0;
        lostValueTotal += kpis?.lostValueXaf ?? 0;
      }
      const total = productTotals.get(productId) ?? {
        sent: 0,
        received: 0,
        soldNet: 0,
        lost: 0,
        remaining: 0,
        toDeliver: 0,
      };
      total.sent += milli(row.sentQty ?? 0);
      total.received += milli(row.receivedQty ?? 0);
      total.soldNet += milli(row.soldNetQty);
      total.lost += milli(row.lostQty ?? 0);
      total.remaining += milli(row.remainingQty ?? 0);
      total.toDeliver += milli(row.toDeliverQty);
      productTotals.set(productId, total);
    }
    rows.sort((a, b) => a.productCode.localeCompare(b.productCode));

    // KPI-DIS-06 : encaissé du site.
    const siteGroups = cashed.filter((group) => group.siteId === pos.siteId);
    const byMethod = new Map<string, { amountXaf: number; paymentsCount: number }>();
    const byReceiver = new Map<string, { amountXaf: number; paymentsCount: number }>();
    for (const group of siteGroups) {
      const method = byMethod.get(group.paymentMethodCode) ?? { amountXaf: 0, paymentsCount: 0 };
      method.amountXaf += group.amountXaf;
      method.paymentsCount += group.paymentsCount;
      byMethod.set(group.paymentMethodCode, method);
      const receiver = byReceiver.get(group.receivedByUserId) ?? { amountXaf: 0, paymentsCount: 0 };
      receiver.amountXaf += group.amountXaf;
      receiver.paymentsCount += group.paymentsCount;
      byReceiver.set(group.receivedByUserId, receiver);
    }

    // Caisse du PDV : sessions et remises de ses caisses.
    const accountIds = new Set(targets.cashAccountsBySite.get(pos.siteId) ?? []);
    const siteAccounts = sessions.accounts.filter((account) =>
      accountIds.has(account.cashAccountId),
    );
    const cashThreshold = cashThresholds.get(pos.siteId)!;
    const open = siteAccounts.find((account) => account.openSession !== null)?.openSession ?? null;
    const ofDay =
      siteAccounts
        .map((account) => account.sessionOfDay)
        .filter((session): session is CashSessionBrief => session !== null)
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0] ?? null;
    const siteTransfers = transfers.byAccount.filter((line) => accountIds.has(line.accountId));

    // Fraîcheur des appareils du PDV.
    const siteDevices = (devicesBySite.get(pos.siteId) ?? [])
      .map((id) => deviceById.get(id))
      .filter((device) => device !== undefined);
    const lastContact = siteDevices.reduce<Date | null>(
      (max, device) =>
        device.lastContactAt !== null &&
        (max === null || device.lastContactAt.getTime() > max.getTime())
          ? device.lastContactAt
          : max,
      null,
    );

    pointsOfSale.push({
      siteId: pos.siteId,
      siteCode: pos.siteCode,
      siteName: pos.siteName,
      siteStatus: pos.siteStatus,
      zoneId: pos.zoneId,
      salesLocationId: pos.salesLocationId,
      custodyMode: pos.custodyMode,
      products: rows,
      sales: { soldXaf, cancelledXaf, netXaf },
      cashed: {
        amountXaf: siteGroups.reduce((sum, group) => sum + group.amountXaf, 0),
        paymentsCount: siteGroups.reduce((sum, group) => sum + group.paymentsCount, 0),
        byMethod: [...byMethod.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([paymentMethodCode, total]) => ({ paymentMethodCode, ...total })),
        byReceiver: visibility.receivers
          ? [...byReceiver.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([userId, total]) => ({
                userId,
                fullName: (names.get(userId) as string | undefined) ?? null,
                ...total,
              }))
          : null,
      },
      cash: {
        accountsCount: accountIds.size,
        openSession:
          open === null ? null : sessionView(open, cashThreshold, now, visibility.cashDetail),
        sessionOfDay:
          ofDay === null ? null : sessionView(ofDay, cashThreshold, now, visibility.cashDetail),
        pendingValidationCount: siteAccounts.reduce((s, a) => s + a.pendingValidationCount, 0),
        pendingAdjustmentsCount: siteAccounts.reduce((s, a) => s + a.pendingAdjustmentsCount, 0),
        transfers: {
          inTransitCount: siteTransfers.reduce((s, t) => s + t.inTransitCount, 0),
          inTransitXaf: siteTransfers.reduce((s, t) => s + t.inTransitXaf, 0),
          overdueCount: siteTransfers.reduce((s, t) => s + t.overdueCount, 0),
          discrepancyCount: siteTransfers.reduce((s, t) => s + t.discrepancyCount, 0),
        },
      },
      devices: {
        count: siteDevices.length,
        staleCount: siteDevices.filter((device) => device.stale && device.status === 'ACTIVE')
          .length,
        lastContactAt: iso(lastContact),
        items: siteDevices.map((device) => ({
          deviceId: device.deviceId,
          shortCode: device.shortCode,
          label: device.label,
          status: device.status,
          isShared: device.isShared,
          lastContactAt: iso(device.lastContactAt),
          stale: device.stale,
          pendingReported: device.pendingReported,
          authors: visibility.authors
            ? device.authors.map((author) => ({
                userId: author.userId,
                lastPushAt: iso(author.lastPushAt),
                lastPullAt: iso(author.lastPullAt),
                pendingReported: author.pendingReported,
              }))
            : null,
        })),
      },
      reconciled,
    });
  }

  return {
    generatedAt: now.toISOString(),
    businessDay: businessDayOf(now),
    period: { code: input.period.code, fromDay: period.fromDay, toDay: period.toDay },
    scope: { allSites: input.allSites, pointsOfSaleCount: pointsOfSale.length },
    freshness: {
      warningHours: freshness.warningHours,
      devicesCount: allDeviceIds.length,
      staleDevices: freshness.staleCount,
    },
    totals: {
      soldNetXaf: pointsOfSale.reduce((sum, pos) => sum + pos.sales.netXaf, 0),
      cashedXaf: pointsOfSale.reduce((sum, pos) => sum + pos.cashed.amountXaf, 0),
      paymentsCount: pointsOfSale.reduce((sum, pos) => sum + pos.cashed.paymentsCount, 0),
      remainingValueXaf: valueMasked ? null : remainingValueTotal,
      lostValueXaf: valueMasked ? null : lostValueTotal,
      cashSessionsToValidate: sessions.pendingValidationCount,
      cashAdjustmentsToValidate: sessions.pendingAdjustmentsCount,
      cashTransfers: {
        inTransitCount: transfers.inTransit.count,
        inTransitXaf: transfers.inTransit.totalXaf,
        overdueCount: transfers.inTransit.overdueCount,
        overdueXaf: transfers.inTransit.overdueXaf,
        discrepancyCount: transfers.discrepancyPending.count,
        unreceivedHours: transfers.inTransit.unreceivedHours,
      },
    },
    products: [...productTotals.entries()]
      .map(([productId, total]) => {
        const product = productById.get(productId)!;
        return {
          productId,
          productCode: product.code,
          baseUnitCode: product.baseUnitCode,
          stocked: product.stockFamily !== 'SERVICE',
          sentQty: qtyOf(total.sent),
          receivedQty: qtyOf(total.received),
          soldNetQty: qtyOf(total.soldNet),
          lostQty: qtyOf(total.lost),
          remainingQty: qtyOf(total.remaining),
          toDeliverQty: qtyOf(total.toDeliver),
        };
      })
      .sort((a, b) => a.productCode.localeCompare(b.productCode)),
    pointsOfSale,
  };
}

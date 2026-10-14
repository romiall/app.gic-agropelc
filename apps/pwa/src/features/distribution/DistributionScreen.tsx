/**
 * ECR-DIS-04 « Distribution par PDV » (BR-DIS-010, KPI-DIS-01 à 07, ADR-035, AT-042). En ligne
 * seulement : `GET /api/v1/analytics/dashboards/distribution` calcule à la demande, pour la période
 * choisie, l'envoyé, le reçu, le vendu, le perdu, le restant, l'encaissé et le réapprovisionnement de
 * chaque PDV du périmètre, avec la caisse et les appareils. Quantités en unité de base, jamais sommées
 * entre produits ; une mesure masquée par le serveur (`null`) ne s'affiche pas (AV-205, AV-206).
 */
import type {
  DistributionCashSession,
  DistributionDashboardResponse,
  DistributionPeriodCode,
  DistributionPointOfSale,
  DistributionProductRow,
} from '@gic/contracts';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOnline } from '../../platform/useOnline.js';
import { formatBusinessDay, formatDateTime } from '../home/format-home.js';
import { formatMoney, formatQuantityUnit, type UnitCatalog } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';

/** Périodes proposées (`period`) ; une période libre (`from`, `to`) n'est pas proposée ici. */
const DISTRIBUTION_PERIODS: readonly Exclude<DistributionPeriodCode, 'CUSTOM'>[] = [
  'TODAY',
  'YESTERDAY',
  'WEEK',
  'MONTH',
  'YEAR',
];

const distributionPath = (period: string): string =>
  `/api/v1/analytics/dashboards/distribution?period=${encodeURIComponent(period)}`;

export function DistributionScreen() {
  const { t } = useTranslation();
  const online = useOnline();
  const [period, setPeriod] = useState<(typeof DISTRIBUTION_PERIODS)[number]>('TODAY');
  const [siteChoice, setSiteChoice] = useState('');
  const ids = { period: useId(), site: useId() };
  // Libellés des moyens de paiement du catalogue de l'appareil (le tableau ne sert que le code).
  const refs = useSalesReferences();
  const methodLabels = new Map(
    (refs?.paymentMethods ?? []).map((method) => [method.code, method.label]),
  );
  const read = useOnlineRead<DistributionDashboardResponse>(
    online ? distributionPath(period) : null,
    (path) => readPath<DistributionDashboardResponse>(path),
    online,
    '',
  );

  if (!online) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.distribution')}</h1>
        <p className="home-muted">{t('distribution.online_only')}</p>
      </section>
    );
  }

  const data = read.data;
  const points = data?.pointsOfSale ?? [];
  // Choix d'un PDV qui n'est plus servi (périmètre changé) : tous les PDV.
  const site = points.some((pos) => pos.siteId === siteChoice) ? siteChoice : '';
  const shown = site ? points.filter((pos) => pos.siteId === site) : points;
  const periodOnly = data?.period.code !== 'TODAY';

  return (
    <section className="sale">
      <h1>{t('nav.screens.distribution')}</h1>
      <div className="field">
        <label htmlFor={ids.period}>{t('distribution.period_label')}</label>
        <select
          id={ids.period}
          className="text-input"
          value={period}
          onChange={(event) => setPeriod(event.target.value as typeof period)}
        >
          {DISTRIBUTION_PERIODS.map((code) => (
            <option key={code} value={code}>
              {t(`distribution.period.${code}`)}
            </option>
          ))}
        </select>
      </div>
      {read.denied ? (
        <p className="alert alert-error" role="alert">
          {t('distribution.denied')}
        </p>
      ) : read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{t('distribution.failed')}</p>
          <button type="button" className="secondary" onClick={read.retry}>
            {t('distribution.retry')}
          </button>
        </div>
      ) : !data ? (
        <p className="home-muted" aria-busy="true">
          {t('sales.loading')}
        </p>
      ) : (
        <>
          <p className="home-muted">
            {t('distribution.period_range', {
              from: formatBusinessDay(data.period.fromDay),
              to: formatBusinessDay(data.period.toDay),
              at: formatDateTime(data.generatedAt),
            })}
          </p>
          {data.freshness.staleDevices > 0 ? (
            <p className="text-warn" role="status">
              {t('distribution.stale_devices', {
                count: data.freshness.staleDevices,
                hours: data.freshness.warningHours,
              })}
            </p>
          ) : null}
          {points.length === 0 ? (
            <p className="home-muted">{t('distribution.empty')}</p>
          ) : (
            <>
              <Totals data={data} />
              {points.length > 1 ? (
                <div className="field">
                  <label htmlFor={ids.site}>{t('distribution.site_label')}</label>
                  <select
                    id={ids.site}
                    className="text-input"
                    value={site}
                    onChange={(event) => setSiteChoice(event.target.value)}
                  >
                    <option value="">{t('distribution.all_sites')}</option>
                    {points.map((pos) => (
                      <option key={pos.siteId} value={pos.siteId}>
                        {pos.siteName}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {shown.map((pos) => (
                <PointOfSaleCard
                  key={pos.siteId}
                  pos={pos}
                  methodLabels={methodLabels}
                  periodOnly={periodOnly}
                  units={refs?.units}
                />
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}

function Totals({ data }: { readonly data: DistributionDashboardResponse }) {
  const { t } = useTranslation();
  const totals = data.totals;
  return (
    <section className="sale-block" aria-labelledby="distribution-totals-title">
      <h2 id="distribution-totals-title">
        {t('distribution.totals_title', { count: data.scope.pointsOfSaleCount })}
      </h2>
      <dl className="receipt-totals">
        <dt>{t('distribution.sold_net')}</dt>
        <dd>{formatMoney(totals.soldNetXaf)}</dd>
        <dt>{t('distribution.cashed')}</dt>
        <dd>
          {t('distribution.cashed_value', {
            amount: formatMoney(totals.cashedXaf),
            count: totals.paymentsCount,
          })}
        </dd>
        {totals.remainingValueXaf !== null ? (
          <>
            <dt>{t('distribution.remaining_value')}</dt>
            <dd>{formatMoney(totals.remainingValueXaf)}</dd>
          </>
        ) : null}
        {totals.lostValueXaf !== null ? (
          <>
            <dt>{t('distribution.lost_value')}</dt>
            <dd>{formatMoney(totals.lostValueXaf)}</dd>
          </>
        ) : null}
        <dt>{t('distribution.to_validate')}</dt>
        <dd>
          {t('distribution.to_validate_value', {
            sessions: totals.cashSessionsToValidate,
            adjustments: totals.cashAdjustmentsToValidate,
          })}
        </dd>
        <dt>{t('distribution.transfers')}</dt>
        <dd>
          {t('distribution.transfers_value', {
            count: totals.cashTransfers.inTransitCount,
            amount: formatMoney(totals.cashTransfers.inTransitXaf),
          })}
        </dd>
      </dl>
      {totals.cashTransfers.overdueCount > 0 ? (
        <p className="text-warn">
          {t('distribution.transfers_overdue', {
            count: totals.cashTransfers.overdueCount,
            amount: formatMoney(totals.cashTransfers.overdueXaf),
            hours: totals.cashTransfers.unreceivedHours,
          })}
        </p>
      ) : null}
      {totals.cashTransfers.discrepancyCount > 0 ? (
        <p className="text-warn">
          {t('distribution.transfers_discrepancy', {
            count: totals.cashTransfers.discrepancyCount,
          })}
        </p>
      ) : null}
    </section>
  );
}

function PointOfSaleCard({
  pos,
  methodLabels,
  periodOnly,
  units,
}: {
  readonly pos: DistributionPointOfSale;
  readonly methodLabels: ReadonlyMap<string, string>;
  readonly periodOnly: boolean;
  readonly units: UnitCatalog | undefined;
}) {
  const { t } = useTranslation();
  const titleId = `distribution-pos-${pos.siteId}`;
  return (
    <section className="sale-block" aria-labelledby={titleId}>
      <h2 id={titleId}>{pos.siteName}</h2>
      {!pos.reconciled ? (
        <p className="text-warn" role="status">
          {t('distribution.not_reconciled')}
        </p>
      ) : null}
      <dl className="receipt-totals">
        <dt>{t('distribution.sales')}</dt>
        <dd>
          {t('distribution.sales_value', {
            net: formatMoney(pos.sales.netXaf),
            cancelled: formatMoney(pos.sales.cancelledXaf),
          })}
        </dd>
        <dt>{t('distribution.cashed')}</dt>
        <dd>
          {t('distribution.cashed_value', {
            amount: formatMoney(pos.cashed.amountXaf),
            count: pos.cashed.paymentsCount,
          })}
        </dd>
      </dl>
      {pos.cashed.byMethod.length > 0 ? (
        <ul className="home-muted">
          {pos.cashed.byMethod.map((method) => (
            <li key={method.paymentMethodCode}>
              {t('distribution.by_method', {
                method: methodLabels.get(method.paymentMethodCode) ?? method.paymentMethodCode,
                amount: formatMoney(method.amountXaf),
                count: method.paymentsCount,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {pos.cashed.byReceiver && pos.cashed.byReceiver.length > 0 ? (
        <ul className="home-muted" aria-label={t('distribution.by_receiver_title')}>
          {pos.cashed.byReceiver.map((receiver) => (
            <li key={receiver.userId}>
              {t('distribution.by_receiver', {
                name: receiver.fullName ?? t('distribution.unknown_user'),
                amount: formatMoney(receiver.amountXaf),
                count: receiver.paymentsCount,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      <CashBlock pos={pos} />
      <DevicesBlock pos={pos} />
      <h3>{t('distribution.products_title')}</h3>
      {pos.products.length === 0 ? (
        <p className="home-muted">{t('distribution.no_products')}</p>
      ) : (
        <ul className="line-list">
          {pos.products.map((row) => (
            <ProductItem key={row.productId} row={row} periodOnly={periodOnly} units={units} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CashBlock({ pos }: { readonly pos: DistributionPointOfSale }) {
  const { t } = useTranslation();
  const cash = pos.cash;
  const session: DistributionCashSession | null = cash.openSession ?? cash.sessionOfDay;
  const variance = session ? (session.currentVarianceXaf ?? session.varianceXaf) : null;
  const sessionText = session
    ? t(`distribution.session.${session.closedAt ? 'closed' : 'open'}`, {
        since: formatDateTime(session.openedAt),
        status: t(`distribution.session_status.${session.status}`, {
          defaultValue: session.status,
        }),
        variance: variance === null ? '—' : formatMoney(variance),
      })
    : '';
  return (
    <>
      <h3>{t('distribution.cash_title')}</h3>
      {session ? (
        <p className={session.severity === 'NONE' ? undefined : 'text-warn'}>{sessionText}</p>
      ) : (
        <p className="home-muted">{t('distribution.no_session')}</p>
      )}
      {session?.openLong ? (
        <p className="text-warn">{t('distribution.session_open_long')}</p>
      ) : null}
      {cash.pendingValidationCount + cash.pendingAdjustmentsCount > 0 ? (
        <p className="home-muted">
          {t('distribution.to_validate_value', {
            sessions: cash.pendingValidationCount,
            adjustments: cash.pendingAdjustmentsCount,
          })}
        </p>
      ) : null}
      {cash.transfers.inTransitCount > 0 ? (
        <p className="home-muted">
          {t('distribution.transfers_value', {
            count: cash.transfers.inTransitCount,
            amount: formatMoney(cash.transfers.inTransitXaf),
          })}
        </p>
      ) : null}
    </>
  );
}

function DevicesBlock({ pos }: { readonly pos: DistributionPointOfSale }) {
  const { t } = useTranslation();
  const devices = pos.devices;
  return (
    <>
      <h3>{t('distribution.devices_title', { count: devices.count })}</h3>
      {devices.items.length === 0 ? (
        <p className="home-muted">{t('distribution.no_devices')}</p>
      ) : (
        <ul className="home-muted">
          {devices.items.map((device) => {
            const name = device.label ?? device.shortCode;
            // Un appareil bloqué, perdu ou retiré reste listé mais n'est pas « en retard » (AV-202).
            const active = device.status === 'ACTIVE';
            const late = active && device.stale;
            const text = !active
              ? t('distribution.device_inactive', {
                  name,
                  status: t(`distribution.device_status.${device.status}`, {
                    defaultValue: device.status,
                  }),
                })
              : device.lastContactAt
                ? t(late ? 'distribution.device_stale' : 'distribution.device', {
                    name,
                    at: formatDateTime(device.lastContactAt),
                  })
                : t('distribution.device_never', { name });
            return (
              <li key={device.deviceId} className={late ? 'text-warn' : undefined}>
                {text}
                {device.pendingReported !== null && device.pendingReported > 0
                  ? t('distribution.device_pending', { count: device.pendingReported })
                  : ''}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function ProductItem({
  row,
  periodOnly,
  units,
}: {
  readonly row: DistributionProductRow;
  readonly periodOnly: boolean;
  readonly units: UnitCatalog | undefined;
}) {
  const { t } = useTranslation();
  const unit = row.baseUnitCode;
  const q = (value: number | null) =>
    value === null ? '—' : formatQuantityUnit(value, unit, units);
  // Mesures lues à l'instant de lecture (ADR-035 §5) : séparées de celles de la période.
  const nowMeasures = row.toDeliverQty > 0 || (row.allocatedQty !== null && row.allocatedQty > 0);
  return (
    <li className="line-card" aria-label={row.productName}>
      <p>
        <strong>{row.productName}</strong>
      </p>
      <dl className="receipt-totals">
        {row.stocked ? (
          <>
            <dt>{t('distribution.sent')}</dt>
            <dd>{q(row.sentQty)}</dd>
            <dt>{t('distribution.received')}</dt>
            <dd>{q(row.receivedQty)}</dd>
          </>
        ) : null}
        <dt>{t('distribution.sold')}</dt>
        <dd>
          {t('distribution.sold_value', {
            quantity: q(row.soldNetQty),
            amount: formatMoney(row.soldNetXaf),
          })}
        </dd>
        {row.stocked ? (
          <>
            <dt>{t('distribution.lost')}</dt>
            <dd>{q(row.lostQty)}</dd>
            {/* Flux de la période, signé : une décision dans la période le rend négatif (AV-199). */}
            {row.lostPendingQty !== null && row.lostPendingQty !== 0 ? (
              <>
                <dt>{t('distribution.lost_pending')}</dt>
                <dd>{q(row.lostPendingQty)}</dd>
              </>
            ) : null}
            {row.transitPendingQty !== null && row.transitPendingQty !== 0 ? (
              <>
                <dt>{t('distribution.transit_pending')}</dt>
                <dd>{q(row.transitPendingQty)}</dd>
              </>
            ) : null}
            <dt>{t('distribution.remaining')}</dt>
            <dd>{q(row.remainingQty)}</dd>
          </>
        ) : null}
      </dl>
      {nowMeasures ? (
        <p className="home-muted">
          {t(periodOnly ? 'distribution.now_caption_past' : 'distribution.now_caption')}
        </p>
      ) : null}
      <dl className="receipt-totals">
        {row.toDeliverQty > 0 ? (
          <>
            <dt>{t('distribution.to_deliver')}</dt>
            <dd>{q(row.toDeliverQty)}</dd>
          </>
        ) : null}
        {row.allocatedQty !== null && row.allocatedQty > 0 ? (
          <>
            <dt>{t('distribution.allocated')}</dt>
            <dd>
              {t('distribution.allocated_value', {
                allocated: q(row.allocatedQty),
                unallocated: q(row.unallocatedQty),
              })}
            </dd>
          </>
        ) : null}
      </dl>
      {row.overcommitted ? <p className="text-warn">{t('distribution.overcommitted')}</p> : null}
      {row.replenish && row.replenish.suggestedQty > 0 ? (
        <p className={row.replenish.state === 'OK' ? 'home-muted' : 'text-warn'}>
          {t('distribution.replenish', { quantity: q(row.replenish.suggestedQty) })}
        </p>
      ) : null}
      {row.reconciliation && !row.reconciliation.reconciled ? (
        <p className="text-warn">
          {t('distribution.residual', { quantity: q(row.reconciliation.residualQty) })}
        </p>
      ) : null}
      {row.reconciliation && !row.reconciliation.salesMatchLedger ? (
        <p className="text-warn">{t('distribution.sales_mismatch')}</p>
      ) : null}
    </li>
  );
}

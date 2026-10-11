/**
 * ECR-PRD-03 « Fiche lot » (responsable de production, direction ; action `LOT_COSTS` ; partiel hors
 * ligne). En ligne (`GET /production/lots/{id}`) : effectif non vendu et en élevage, mortalité,
 * indicateurs (taux de mortalité, gain moyen quotidien, indice de consommation, ponte), coûts par
 * nature, coût restant et par tête, résultat mensuel, chiffre d'affaires et marges, entrées et pesées.
 * Hors ligne : la fiche du lot téléchargé et l'effectif calculé par l'appareil seulement. Montants
 * nuls sans droit de valorisation (RC-05). Les lots clôturés (sortis du jeu `production`) se lisent en
 * ligne ; un lot demandé absent de l'appareil se lit directement, sans retomber sur un autre lot.
 * Dates avec l'année (un lot de pondeuses dure plus d'un an). Aucune écriture.
 */
import { Fragment, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useOnline } from '../../platform/useOnline.js';
import { formatBusinessDate, formatDateTime, formatMonthPeriod } from '../home/format-home.js';
import { formatMoney, formatQuantity } from '../sales/format.js';
import { readPages, readPath, useOnlineRead, type Pages } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { rearingHeadcount } from './daily.js';

/** Fiche renvoyée par `GET /api/v1/production/lots/{id}` (montants nuls sans droit). */
interface LotSheet {
  readonly id: string;
  readonly lotCode: string;
  readonly lotType: string;
  readonly productId: string;
  readonly status: string;
  readonly startDate: string | null;
  readonly closedAt?: string | null;
  readonly initialQuantity: number | null;
  readonly headcount: { readonly unsold: number; readonly rearing: number };
  readonly mortality: {
    readonly countedQuantity: number;
    readonly pendingQuantity: number;
    readonly lostQuantity: number;
  };
  readonly indicators: {
    readonly mortalityRate: number | null;
    readonly averageDailyGainG: number | null;
    readonly feedConversionRatio: number | null;
    readonly layingRate: number | null;
    readonly eggsCollected: number | null;
  };
  readonly costs: {
    readonly breakdown: readonly {
      readonly costType: string;
      readonly netXaf: number | null;
    }[];
    readonly netXaf: number | null;
    readonly remainingXaf: number | null;
    readonly costPerHeadXaf: number | null;
    readonly monthly: readonly {
      readonly period: string;
      readonly netXaf: number | null;
      readonly revenueXaf: number | null;
    }[];
  };
  readonly sales?: {
    readonly netRevenueXaf: number | null;
    readonly costOfSalesXaf: number | null;
    readonly soldQuantity: number;
    readonly lotMarginXaf: number | null;
    readonly grossMarginXaf: number | null;
  };
  readonly entries: readonly {
    readonly id: string;
    readonly sourceKind: string;
    readonly quantity: number;
    readonly status: string;
    readonly valueXaf: number | null;
  }[];
  readonly weighings: readonly {
    readonly id: string;
    readonly sampleSize: number;
    readonly avgWeightG: number;
    readonly occurredAt: string;
    readonly status: string;
  }[];
}

/** Lot clôturé lu en ligne (`GET /production/lots?status=CLOSED`). */
interface ClosedLot {
  readonly id: string;
  readonly lotCode: string;
  readonly lotType: string;
  readonly status: string;
}

/** Lot proposé : de l'appareil (ouvert) ou lu en ligne (clôturé). */
interface LotChoice {
  readonly id: string;
  readonly lotCode: string;
  readonly lotType: string;
}

/** Lots clôturés : une page à la fois (chaque lot coûte un calcul d'effectif au serveur, S-41). */
const CLOSED_LOTS_PATH = '/api/v1/production/lots?status=CLOSED&limit=50';

const percent = (rate: number | null): string | null =>
  rate === null ? null : `${formatQuantity(Math.round(rate * 10000) / 100)} %`;
const money = (value: number | null | undefined): string | null =>
  value === null || value === undefined ? null : formatMoney(value);

export function LotSheetScreen() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const refs = useSalesReferences();
  const online = useOnline();
  const [lotChoice, setLotChoice] = useState<string | null>(searchParams.get('lot'));
  const [closedPages, setClosedPages] = useState(1);
  const lotId = useId();
  const closed = useOnlineRead<Pages<ClosedLot>>(
    `${CLOSED_LOTS_PATH}#${closedPages}`,
    () => readPages<ClosedLot>([CLOSED_LOTS_PATH], 'lots', closedPages),
    online,
    '',
  );
  const deviceLots = refs?.productionLots ?? [];
  const known = new Set(deviceLots.map((candidate) => candidate.id));
  const byCodeDesc = (a: LotChoice, b: LotChoice) => b.lotCode.localeCompare(a.lotCode, 'fr');
  // Lots de l'appareil (ouverts) d'abord, puis les lots clôturés lus en ligne.
  const openLots: LotChoice[] = deviceLots
    .map((candidate) => ({
      id: candidate.id,
      lotCode: candidate.lot_code,
      lotType: candidate.lot_type,
    }))
    .sort(byCodeDesc);
  const closedLots: LotChoice[] = (closed.data?.items ?? [])
    .filter((candidate) => !known.has(candidate.id))
    .map((candidate) => ({
      id: candidate.id,
      lotCode: candidate.lotCode,
      lotType: candidate.lotType,
    }))
    .sort(byCodeDesc);
  const lots = [...openLots, ...closedLots];
  // Lot demandé (lien, choix) lu tel quel même absent de la liste ; sinon un lot ouvert, et un lot
  // clôturé seulement s'il n'y en a aucun.
  const id = lotChoice ?? openLots[0]?.id ?? closedLots[0]?.id ?? '';
  const lot = deviceLots.find((candidate) => candidate.id === id);
  const sheet = useOnlineRead<{ lot: LotSheet }>(
    id ? `/api/v1/production/lots/${encodeURIComponent(id)}` : null,
    readPath,
    online,
    '',
  );

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.lot_sheet')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  // Hors ligne, la fiche lue avant la coupure n'est plus présentée : l'estimation de l'appareil prend
  // le relais, comme l'annonce le bandeau.
  const current = online ? sheet.data?.lot : undefined;
  const localHeads = lot ? rearingHeadcount(refs, lot) : null;
  const productId = current?.productId ?? lot?.product_id;
  const product = productId
    ? refs.products.find((candidate) => candidate.id === productId)
    : undefined;
  // Statut et démarrage du serveur dès que la fiche est lue ; ceux de l'appareil en repli.
  const status = current?.status ?? lot?.status;
  const startDate = current?.startDate ?? lot?.start_date ?? null;
  const choice = lots.find((candidate) => candidate.id === id);
  const amountsHidden = current?.costs.netXaf === null;
  const unit = product?.base_unit_code ?? '';
  const row = (label: string, value: string | null) =>
    value === null ? null : (
      <Fragment key={label}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </Fragment>
    );

  return (
    <section className="sale">
      <h1>{t('nav.screens.lot_sheet')}</h1>
      {online && closed.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{t('lot_sheet.closed_unavailable')}</p>
          <button type="button" className="secondary" onClick={closed.retry}>
            {t('ledger.retry')}
          </button>
        </div>
      ) : null}
      {!id ? (
        online && closed.data === undefined && !closed.failed ? (
          <p className="home-muted">{t('sales.loading')}</p>
        ) : (
          <p className="home-muted">{t('lot_sheet.no_lot')}</p>
        )
      ) : (
        <>
          <div className="field">
            <label htmlFor={lotId}>{t('lot_sheet.lot_label')}</label>
            <select
              id={lotId}
              className="text-input"
              value={id}
              onChange={(event) => setLotChoice(event.target.value)}
            >
              {choice ? null : (
                <option value={id}>{current?.lotCode ?? t('lot_sheet.requested_lot')}</option>
              )}
              {openLots.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {`${candidate.lotCode} · ${t(`production.lot_type.${candidate.lotType}`, {
                    defaultValue: candidate.lotType,
                  })}`}
                </option>
              ))}
              {closedLots.length > 0 ? (
                <optgroup label={t('lot_sheet.closed_group')}>
                  {closedLots.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {`${candidate.lotCode} · ${t(`production.lot_type.${candidate.lotType}`, {
                        defaultValue: candidate.lotType,
                      })}`}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
            {closed.data?.more ? (
              <button
                type="button"
                className="secondary"
                disabled={closed.stale}
                onClick={() => setClosedPages((value) => value + 1)}
              >
                {t('lot_sheet.more_closed')}
              </button>
            ) : null}
          </div>
          <p className="home-muted">
            {[
              product?.name,
              status ? t(`lot_sheet.status.${status}`, { defaultValue: status }) : null,
              startDate ? t('lot_sheet.started', { date: formatBusinessDate(startDate) }) : null,
              current?.closedAt
                ? t('lot_sheet.closed_on', { date: formatDateTime(current.closedAt) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {!online ? (
            <p className="home-banner" role="status">
              {lot ? t('lot_sheet.offline') : t('lot_sheet.not_on_device')}
            </p>
          ) : null}
          {online && current === undefined && !sheet.failed ? (
            <p className="home-muted">{t('sales.loading')}</p>
          ) : null}
          {online && sheet.failed ? (
            <div className="alert alert-error" role="alert">
              <p>{sheet.denied ? t('lot_sheet.not_found') : t('lot_sheet.unavailable')}</p>
              {sheet.denied ? null : (
                <button type="button" className="secondary" onClick={sheet.retry}>
                  {t('ledger.retry')}
                </button>
              )}
            </div>
          ) : null}

          <section className="sale-block" aria-labelledby="lot-sheet-heads">
            <h2 id="lot-sheet-heads">{t('lot_sheet.heads_title')}</h2>
            <dl className="receipt-totals">
              {current
                ? [
                    row(
                      t('lot_sheet.initial'),
                      current.initialQuantity === null
                        ? null
                        : `${formatQuantity(current.initialQuantity)} ${unit}`,
                    ),
                    row(
                      t('lot_sheet.unsold'),
                      `${formatQuantity(current.headcount.unsold)} ${unit}`,
                    ),
                    row(
                      t('lot_sheet.rearing'),
                      `${formatQuantity(current.headcount.rearing)} ${unit}`,
                    ),
                    row(
                      t('lot_sheet.deaths'),
                      `${formatQuantity(current.mortality.countedQuantity)} ${unit}`,
                    ),
                    current.mortality.pendingQuantity > 0
                      ? row(
                          t('lot_sheet.deaths_pending'),
                          `${formatQuantity(current.mortality.pendingQuantity)} ${unit}`,
                        )
                      : null,
                    row(
                      t('lot_sheet.lost'),
                      `${formatQuantity(current.mortality.lostQuantity)} ${unit}`,
                    ),
                  ]
                : lot
                  ? [
                      row(
                        t('lot_sheet.rearing_device'),
                        localHeads === null
                          ? t('production.headcount_unknown')
                          : `${formatQuantity(localHeads)} ${unit}`,
                      ),
                    ]
                  : null}
            </dl>
          </section>

          {current ? (
            <>
              <section className="sale-block" aria-labelledby="lot-sheet-indicators">
                <h2 id="lot-sheet-indicators">{t('lot_sheet.indicators_title')}</h2>
                <dl className="receipt-totals">
                  {row(t('lot_sheet.mortality_rate'), percent(current.indicators.mortalityRate))}
                  {row(
                    t('lot_sheet.adg'),
                    current.indicators.averageDailyGainG === null
                      ? null
                      : t('lot_sheet.grams_per_day', {
                          value: formatQuantity(current.indicators.averageDailyGainG),
                        }),
                  )}
                  {row(
                    t('lot_sheet.fcr'),
                    current.indicators.feedConversionRatio === null
                      ? null
                      : formatQuantity(current.indicators.feedConversionRatio),
                  )}
                  {row(t('lot_sheet.laying_rate'), percent(current.indicators.layingRate))}
                  {row(
                    t('lot_sheet.eggs'),
                    current.indicators.eggsCollected === null
                      ? null
                      : formatQuantity(current.indicators.eggsCollected),
                  )}
                </dl>
              </section>

              <section className="sale-block" aria-labelledby="lot-sheet-costs">
                <h2 id="lot-sheet-costs">{t('lot_sheet.costs_title')}</h2>
                {current.costs.netXaf === null ? (
                  <p className="home-muted">{t('lot_sheet.amounts_hidden')}</p>
                ) : (
                  <>
                    <ul className="receipt-lines">
                      {current.costs.breakdown.map((line) => (
                        <li key={line.costType}>
                          <span>
                            {t(`lot_sheet.cost_type.${line.costType}`, {
                              defaultValue: line.costType,
                            })}
                          </span>
                          <span>{money(line.netXaf)}</span>
                        </li>
                      ))}
                    </ul>
                    <dl className="receipt-totals">
                      {row(t('lot_sheet.cost_total'), money(current.costs.netXaf))}
                      {row(t('lot_sheet.cost_remaining'), money(current.costs.remainingXaf))}
                      {row(t('lot_sheet.cost_per_head'), money(current.costs.costPerHeadXaf))}
                    </dl>
                  </>
                )}
              </section>

              {current.sales ? (
                <section className="sale-block" aria-labelledby="lot-sheet-sales">
                  <h2 id="lot-sheet-sales">{t('lot_sheet.sales_title')}</h2>
                  {current.sales.netRevenueXaf === null ? (
                    <p className="home-muted">{t('lot_sheet.amounts_hidden')}</p>
                  ) : null}
                  <dl className="receipt-totals">
                    {row(
                      t('lot_sheet.sold'),
                      `${formatQuantity(current.sales.soldQuantity)} ${unit}`,
                    )}
                    {row(t('lot_sheet.revenue'), money(current.sales.netRevenueXaf))}
                    {row(t('lot_sheet.cost_of_sales'), money(current.sales.costOfSalesXaf))}
                    {row(t('lot_sheet.lot_margin'), money(current.sales.lotMarginXaf))}
                    {row(t('lot_sheet.gross_margin'), money(current.sales.grossMarginXaf))}
                  </dl>
                </section>
              ) : null}

              {current.costs.monthly.length > 0 && !amountsHidden ? (
                <section className="sale-block" aria-labelledby="lot-sheet-monthly">
                  <h2 id="lot-sheet-monthly">{t('lot_sheet.monthly_title')}</h2>
                  <ul className="receipt-lines">
                    {current.costs.monthly.map((month) => (
                      <li key={month.period}>
                        <span>{formatMonthPeriod(month.period)}</span>
                        <span>
                          {t('lot_sheet.month', {
                            cost: money(month.netXaf) ?? '—',
                            revenue: money(month.revenueXaf) ?? '—',
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="sale-block" aria-labelledby="lot-sheet-entries">
                <h2 id="lot-sheet-entries">{t('lot_sheet.entries_title')}</h2>
                {current.entries.length === 0 ? (
                  <p className="home-muted">{t('lot_sheet.none')}</p>
                ) : (
                  <ul className="receipt-lines">
                    {current.entries.map((entry) => (
                      <li key={entry.id}>
                        <span>
                          {t(`lot_setup.kind.${entry.sourceKind}`, {
                            defaultValue: entry.sourceKind,
                          })}
                          {entry.status === 'CANCELLED' ? (
                            <small>{t('lot_sheet.cancelled')}</small>
                          ) : null}
                        </span>
                        <span>{`${formatQuantity(entry.quantity)} ${unit}`}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {current.weighings.length > 0 ? (
                <section className="sale-block" aria-labelledby="lot-sheet-weighings">
                  <h2 id="lot-sheet-weighings">{t('lot_sheet.weighings_title')}</h2>
                  <ul className="receipt-lines">
                    {current.weighings
                      .filter((weighing) => weighing.status !== 'CANCELLED')
                      .map((weighing) => (
                        <li key={weighing.id}>
                          <span>{formatDateTime(weighing.occurredAt)}</span>
                          <span>
                            {t('lot_sheet.weighing', {
                              weight: formatQuantity(weighing.avgWeightG),
                              sample: weighing.sampleSize,
                            })}
                          </span>
                        </li>
                      ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

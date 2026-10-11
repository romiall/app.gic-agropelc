/**
 * ECR-PRD-03 « Fiche lot » (responsable de production, direction ; action `LOT_COSTS` ; partiel hors
 * ligne). En ligne (`GET /production/lots/{id}`) : effectif non vendu et en élevage, mortalité,
 * indicateurs (taux de mortalité, gain moyen quotidien, indice de consommation, ponte), coûts par
 * nature, coût restant et par tête, résultat mensuel, chiffre d'affaires et marges, entrées et pesées.
 * Hors ligne : la fiche du lot téléchargé et l'effectif calculé par l'appareil seulement. Montants
 * nuls sans droit de valorisation (RC-05). Aucune écriture.
 */
import { Fragment, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { formatMoney, formatQuantity } from '../sales/format.js';
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
  const [sheet, setSheet] = useState<{ id: string; data: LotSheet | null }>();
  const lotId = useId();
  const lots = [...(refs?.productionLots ?? [])].sort((a, b) =>
    b.lot_code.localeCompare(a.lot_code, 'fr'),
  );
  const lot = lots.find((candidate) => candidate.id === lotChoice) ?? lots[0];
  const id = lot?.id ?? '';

  useEffect(() => {
    if (!id || !online) return;
    let cancelled = false;
    void authorizedRequest<{ lot: LotSheet }>(
      getDb(),
      `/api/v1/production/lots/${encodeURIComponent(id)}`,
      { method: 'GET' },
    ).then((result) => {
      if (!cancelled) setSheet({ id, data: result.ok ? result.data.lot : null });
    });
    return () => {
      cancelled = true;
    };
  }, [id, online]);

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.lot_sheet')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const current = online && sheet?.id === id ? sheet.data : undefined;
  const localHeads = lot ? rearingHeadcount(refs, lot) : null;
  const product = lot
    ? refs.products.find((candidate) => candidate.id === lot.product_id)
    : undefined;
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
      {lots.length === 0 || !lot ? (
        <p className="home-muted">{t('lot_sheet.no_lot')}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={lotId}>{t('lot_sheet.lot_label')}</label>
            <select
              id={lotId}
              className="text-input"
              value={lot.id}
              onChange={(event) => setLotChoice(event.target.value)}
            >
              {lots.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {`${candidate.lot_code} · ${t(`production.lot_type.${candidate.lot_type}`, {
                    defaultValue: candidate.lot_type,
                  })}`}
                </option>
              ))}
            </select>
          </div>
          <p className="home-muted">
            {[
              product?.name,
              t(`lot_sheet.status.${lot.status}`, { defaultValue: lot.status }),
              lot.start_date
                ? t('lot_sheet.started', { date: formatBusinessDay(lot.start_date) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {!online ? (
            <p className="home-banner" role="status">
              {t('lot_sheet.offline')}
            </p>
          ) : null}
          {online && current === undefined ? (
            <p className="home-muted">{t('sales.loading')}</p>
          ) : null}
          {online && current === null ? (
            <p className="alert alert-error">{t('lot_sheet.unavailable')}</p>
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
                : [
                    row(
                      t('lot_sheet.rearing_device'),
                      localHeads === null
                        ? t('production.headcount_unknown')
                        : `${formatQuantity(localHeads)} ${unit}`,
                    ),
                  ]}
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

              {current.costs.monthly.length > 0 && current.costs.netXaf !== null ? (
                <section className="sale-block" aria-labelledby="lot-sheet-monthly">
                  <h2 id="lot-sheet-monthly">{t('lot_sheet.monthly_title')}</h2>
                  <ul className="receipt-lines">
                    {current.costs.monthly.map((month) => (
                      <li key={month.period}>
                        <span>{month.period}</span>
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
                          <span>{formatMoment(weighing.occurredAt, today)}</span>
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

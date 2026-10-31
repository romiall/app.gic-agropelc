/**
 * ECR-PRD-03 « Fiche lot » (responsable de production, direction ; action `LOT_COSTS` ; partiel hors
 * ligne). En ligne (`GET /production/lots/{id}`) : effectif non vendu et en élevage, mortalité,
 * indicateurs (taux de mortalité, gain moyen quotidien, indice de consommation, ponte), coûts par
 * nature, coût restant et par tête, résultat mensuel, chiffre d'affaires et marges, entrées et pesées.
 * Hors ligne : la fiche du lot téléchargé et l'effectif calculé par l'appareil seulement. Montants
 * nuls sans droit de valorisation (RC-05). Les lots clôturés (sortis du jeu `production`) se lisent en
 * ligne ; un lot demandé absent de l'appareil se lit directement, sans retomber sur un autre lot.
 * Dates avec l'année (un lot de pondeuses dure plus d'un an). Aucune écriture.
 *
 * Refonte (ADR-049, lot L6) : effectif et indicateurs en tuiles (`dl` : le libellé précède sa valeur),
 * coûts, ventes, résultat mensuel, entrées et pesées en cartes, sur deux colonnes sur ordinateur.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  List,
  ListRow,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  type BadgeTone,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { formatBusinessDate, formatDateTime, formatMonthPeriod } from '../home/format-home.js';
import { formatMoney, formatQuantity, formatQuantityUnit } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { rearingHeadcount } from './daily.js';
import './production.css';

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

/** Page de lots clôturés et curseur de la suivante. */
interface ClosedPage {
  readonly lots?: readonly ClosedLot[];
  readonly next_cursor?: string | null;
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

/** Ton de la pastille de situation d'un lot. */
const lotStatusTone = (status: string): BadgeTone =>
  status === 'ACTIVE'
    ? 'ok'
    : status === 'SELLING'
      ? 'info'
      : status === 'CANCELLED'
        ? 'bad'
        : 'muted';

/** Un chiffre et son libellé (`dt` puis `dd`) ; rien si la valeur manque. */
function Figure({
  label,
  value,
  warn = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly warn?: boolean;
}) {
  if (value === null) return null;
  return (
    <div className={warn ? 'is-warn' : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function LotSheetScreen() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const refs = useSalesReferences();
  const online = useOnline();
  const [lotChoice, setLotChoice] = useState<string | null>(searchParams.get('lot'));
  // Première page lue en ligne ; les suivantes, une à la fois, ajoutées sans relire les précédentes.
  const closed = useOnlineRead<ClosedPage>(CLOSED_LOTS_PATH, readPath, online, '');
  const [more, setMore] = useState<{
    readonly items: readonly ClosedLot[];
    readonly cursor: string | null;
    readonly loaded: number;
    readonly status: 'IDLE' | 'LOADING' | 'FAILED';
  }>({ items: [], cursor: null, loaded: 0, status: 'IDLE' });
  const nextCursor = more.loaded > 0 ? more.cursor : (closed.data?.next_cursor ?? null);
  const loadMore = async () => {
    if (!nextCursor) return;
    setMore((current) => ({ ...current, status: 'LOADING' }));
    const result = await readPath<ClosedPage>(
      `${CLOSED_LOTS_PATH}&cursor=${encodeURIComponent(nextCursor)}`,
    );
    setMore((current) =>
      result.ok
        ? {
            items: [...current.items, ...(result.data.lots ?? [])],
            cursor: result.data.next_cursor ?? null,
            loaded: current.loaded + 1,
            status: 'IDLE',
          }
        : { ...current, status: 'FAILED' },
    );
  };
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
  const closedSeen = new Set<string>();
  const closedLots: LotChoice[] = [...(closed.data?.lots ?? []), ...more.items]
    .filter((candidate) => {
      if (known.has(candidate.id) || closedSeen.has(candidate.id)) return false;
      closedSeen.add(candidate.id);
      return true;
    })
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
        <PageHeader title={t('nav.screens.lot_sheet')} />
        <SkeletonRows />
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
  const lotLabel = (candidate: LotChoice) =>
    `${candidate.lotCode} · ${t(`production.lot_type.${candidate.lotType}`, {
      defaultValue: candidate.lotType,
    })}`;

  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.lot_sheet')} />
      {online && closed.failed ? (
        <Banner
          tone="bad"
          action={
            <Button variant="tonal" size="sm" onClick={closed.retry}>
              {t('ledger.retry')}
            </Button>
          }
        >
          {t('lot_sheet.closed_unavailable')}
        </Banner>
      ) : null}
      {!id ? (
        online && closed.data === undefined && !closed.failed ? (
          <SkeletonRows rows={2} />
        ) : (
          <EmptyState icon="leaf" title={t('lot_sheet.no_lot')} />
        )
      ) : (
        <>
          <Field label={t('lot_sheet.lot_label')} className="prd-narrow">
            {(control) => (
              <Select
                {...control}
                value={id}
                onChange={(event) => setLotChoice(event.target.value)}
              >
                {choice ? null : (
                  <option value={id}>{current?.lotCode ?? t('lot_sheet.requested_lot')}</option>
                )}
                {openLots.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {lotLabel(candidate)}
                  </option>
                ))}
                {closedLots.length > 0 ? (
                  <optgroup label={t('lot_sheet.closed_group')}>
                    {closedLots.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {lotLabel(candidate)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </Select>
            )}
          </Field>
          {online && more.status === 'FAILED' ? (
            <p className="prd-note is-bad" role="alert">
              {t('lot_sheet.more_failed')}
            </p>
          ) : null}
          {online && nextCursor ? (
            <Button
              variant="tonal"
              size="sm"
              className="prd-self-start"
              disabled={more.status === 'LOADING'}
              onClick={() => void loadMore()}
            >
              {t('lot_sheet.more_closed')}
            </Button>
          ) : null}
          <div className="prd-status">
            {status ? (
              <Badge tone={lotStatusTone(status)}>
                {t(`lot_sheet.status.${status}`, { defaultValue: status })}
              </Badge>
            ) : null}
            <span>
              {[
                product?.name,
                startDate ? t('lot_sheet.started', { date: formatBusinessDate(startDate) }) : null,
                current?.closedAt
                  ? t('lot_sheet.closed_on', { date: formatDateTime(current.closedAt) })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          {!online ? (
            <Banner tone="warn" role="status">
              {lot ? t('lot_sheet.offline') : t('lot_sheet.not_on_device')}
            </Banner>
          ) : null}
          {online && current === undefined && !sheet.failed ? <SkeletonRows rows={2} /> : null}
          {online && sheet.failed ? (
            <Banner
              tone="bad"
              {...(sheet.denied
                ? {}
                : {
                    action: (
                      <Button variant="tonal" size="sm" onClick={sheet.retry}>
                        {t('ledger.retry')}
                      </Button>
                    ),
                  })}
            >
              {sheet.denied ? t('lot_sheet.not_found') : t('lot_sheet.unavailable')}
            </Banner>
          ) : null}

          <div className="prd-sheet">
            <Section title={t('lot_sheet.heads_title')} className="is-wide">
              <dl className="prd-figures">
                {current ? (
                  <>
                    <Figure
                      label={t('lot_sheet.initial')}
                      value={
                        current.initialQuantity === null
                          ? null
                          : formatQuantityUnit(current.initialQuantity, unit)
                      }
                    />
                    <Figure
                      label={t('lot_sheet.unsold')}
                      value={formatQuantityUnit(current.headcount.unsold, unit)}
                    />
                    <Figure
                      label={t('lot_sheet.rearing')}
                      value={formatQuantityUnit(current.headcount.rearing, unit)}
                    />
                    <Figure
                      label={t('lot_sheet.deaths')}
                      value={formatQuantityUnit(current.mortality.countedQuantity, unit)}
                    />
                    {current.mortality.pendingQuantity > 0 ? (
                      <Figure
                        warn
                        label={t('lot_sheet.deaths_pending')}
                        value={formatQuantityUnit(current.mortality.pendingQuantity, unit)}
                      />
                    ) : null}
                    <Figure
                      label={t('lot_sheet.lost')}
                      value={formatQuantityUnit(current.mortality.lostQuantity, unit)}
                    />
                  </>
                ) : lot ? (
                  <Figure
                    label={t('lot_sheet.rearing_device')}
                    value={
                      localHeads === null
                        ? t('production.headcount_unknown')
                        : formatQuantityUnit(localHeads, unit)
                    }
                  />
                ) : null}
              </dl>
            </Section>

            {current ? (
              <>
                <Section title={t('lot_sheet.indicators_title')} className="is-wide">
                  <dl className="prd-figures">
                    <Figure
                      label={t('lot_sheet.mortality_rate')}
                      value={percent(current.indicators.mortalityRate)}
                    />
                    <Figure
                      label={t('lot_sheet.adg')}
                      value={
                        current.indicators.averageDailyGainG === null
                          ? null
                          : t('lot_sheet.grams_per_day', {
                              value: formatQuantity(current.indicators.averageDailyGainG),
                            })
                      }
                    />
                    <Figure
                      label={t('lot_sheet.fcr')}
                      value={
                        current.indicators.feedConversionRatio === null
                          ? null
                          : formatQuantity(current.indicators.feedConversionRatio)
                      }
                    />
                    <Figure
                      label={t('lot_sheet.laying_rate')}
                      value={percent(current.indicators.layingRate)}
                    />
                    <Figure
                      label={t('lot_sheet.eggs')}
                      value={
                        current.indicators.eggsCollected === null
                          ? null
                          : formatQuantity(current.indicators.eggsCollected)
                      }
                    />
                  </dl>
                </Section>

                <Section title={t('lot_sheet.costs_title')}>
                  {current.costs.netXaf === null ? (
                    <p className="prd-note">{t('lot_sheet.amounts_hidden')}</p>
                  ) : (
                    <>
                      <Card>
                        <ul className="prd-lines">
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
                      </Card>
                      <Card>
                        <dl className="prd-totals">
                          <Figure
                            label={t('lot_sheet.cost_total')}
                            value={money(current.costs.netXaf)}
                          />
                          <Figure
                            label={t('lot_sheet.cost_remaining')}
                            value={money(current.costs.remainingXaf)}
                          />
                          <Figure
                            label={t('lot_sheet.cost_per_head')}
                            value={money(current.costs.costPerHeadXaf)}
                          />
                        </dl>
                      </Card>
                    </>
                  )}
                </Section>

                {current.sales ? (
                  <Section title={t('lot_sheet.sales_title')}>
                    {current.sales.netRevenueXaf === null ? (
                      <p className="prd-note">{t('lot_sheet.amounts_hidden')}</p>
                    ) : null}
                    <Card>
                      <dl className="prd-totals">
                        <Figure
                          label={t('lot_sheet.sold')}
                          value={formatQuantityUnit(current.sales.soldQuantity, unit)}
                        />
                        <Figure
                          label={t('lot_sheet.revenue')}
                          value={money(current.sales.netRevenueXaf)}
                        />
                        <Figure
                          label={t('lot_sheet.cost_of_sales')}
                          value={money(current.sales.costOfSalesXaf)}
                        />
                        <Figure
                          label={t('lot_sheet.lot_margin')}
                          value={money(current.sales.lotMarginXaf)}
                        />
                        <Figure
                          label={t('lot_sheet.gross_margin')}
                          value={money(current.sales.grossMarginXaf)}
                        />
                      </dl>
                    </Card>
                  </Section>
                ) : null}

                {current.costs.monthly.length > 0 && !amountsHidden ? (
                  <Section title={t('lot_sheet.monthly_title')}>
                    <List>
                      {current.costs.monthly.map((month) => (
                        <ListRow
                          key={month.period}
                          title={formatMonthPeriod(month.period)}
                          subtitle={t('lot_sheet.month', {
                            cost: money(month.netXaf) ?? '—',
                            revenue: money(month.revenueXaf) ?? '—',
                          })}
                        />
                      ))}
                    </List>
                  </Section>
                ) : null}

                <Section title={t('lot_sheet.entries_title')}>
                  {current.entries.length === 0 ? (
                    <p className="prd-note">{t('lot_sheet.none')}</p>
                  ) : (
                    <List>
                      {current.entries.map((entry) => (
                        <ListRow
                          key={entry.id}
                          title={t(`lot_setup.kind.${entry.sourceKind}`, {
                            defaultValue: entry.sourceKind,
                          })}
                          value={formatQuantityUnit(entry.quantity, unit)}
                          badge={
                            entry.status === 'CANCELLED' ? (
                              <Badge tone="muted">{t('lot_sheet.cancelled')}</Badge>
                            ) : undefined
                          }
                        />
                      ))}
                    </List>
                  )}
                </Section>

                {current.weighings.length > 0 ? (
                  <Section title={t('lot_sheet.weighings_title')}>
                    <List>
                      {current.weighings
                        .filter((weighing) => weighing.status !== 'CANCELLED')
                        .map((weighing) => (
                          <ListRow
                            key={weighing.id}
                            title={formatDateTime(weighing.occurredAt)}
                            subtitle={t('lot_sheet.weighing', {
                              weight: formatQuantity(weighing.avgWeightG),
                              sample: weighing.sampleSize,
                            })}
                          />
                        ))}
                    </List>
                  </Section>
                ) : null}
              </>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

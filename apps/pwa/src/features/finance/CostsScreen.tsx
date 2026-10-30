/**
 * ECR-FIN-06 « Coûts et marges » (P8E-08 ; ADR-044, ADR-047 §6 ; AV-299, AV-303). Lecture seule, en
 * ligne ; hors ligne, les dernières lectures restent affichées, périmées :
 * - période (mois, semaine, jour, année en cours à ce jour, ou du … au …) ;
 * - vue d'ensemble de la période (`GET /finance/overview`) : ventes et marge brute, encaissé,
 *   dépenses ; créances, dettes fournisseurs et trésorerie à la date de lecture ; un bloc non lisible
 *   avec ses droits est annoncé comme tel ;
 * - pertes valorisées de la période (`GET /losses/summary`) par produit, lot ou motif : indicateur,
 *   hors coût des lots ;
 * - coûts et marges d'un lot choisi parmi les lots en cours, en vente ou clôturés (fiche du lot,
 *   `GET /production/lots/{id}`) et ses écritures de coût à la demande (`GET /costs`).
 * Aucune marge n'est calculée sur l'appareil (BR-ANA-009) ; les axes produit, point de vente et
 * commercial viendront avec l'explorateur de P9 (AV-299). Finance et Direction (AV-303).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  KpiTile,
  LinkButton,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
} from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDate } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { formatMoney, formatQuantity, unitLabel } from '../sales/format.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type OnlineRead,
} from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { shiftDay } from '../stock/ledger.js';
import {
  COST_ENTRY_MAX_PAGES,
  COST_PERIODS,
  costEntriesPath,
  DEFAULT_COST_PERIOD,
  LOSS_GROUPS,
  LOT_CODE_MAX_PAGES,
  lotCodePaths,
  LOT_PAGE_LIMIT,
  LOT_STATUSES,
  lotWithoutSales,
  lossesPath,
  lotPath,
  lotsPath,
  namedPeriod,
  overviewPath,
  periodIssue,
  sortCostEntries,
  sortLots,
  type CostEntry,
  type CostPeriod,
  type FinanceOverview,
  type LossGroup,
  type LossSummary,
  type LotChoice,
  type LotMarginsResponse,
  type LotStatusChoice,
} from './costs.js';
import './finance.css';

const shortId = (id: string) => `…${id.slice(-4)}`;

/** Échec d'une section : refus sans relance, panne avec sa relance. */
function SectionProblem({
  read,
  failedKey,
  retryKey,
}: {
  readonly read: Pick<OnlineRead<unknown>, 'failed' | 'denied' | 'retry'>;
  readonly failedKey: string;
  readonly retryKey: string;
}) {
  const { t } = useTranslation();
  if (!read.failed) return null;
  return (
    <Banner
      tone="warn"
      role="alert"
      action={
        read.denied ? undefined : (
          <Button variant="outline" size="sm" onClick={read.retry}>
            {t(retryKey)}
          </Button>
        )
      }
    >
      {read.denied ? t('costs_margins.denied') : t(failedKey)}
    </Banner>
  );
}

/** Section sans lecture : hors ligne, en ligne seulement ; sinon en cours. */
function Waiting({ online }: { readonly online: boolean }) {
  const { t } = useTranslation();
  return online ? (
    <SkeletonRows rows={2} />
  ) : (
    <EmptyState icon="offline" title={t('costs_margins.online_only')} />
  );
}

function Refreshing({
  read,
  online,
}: {
  readonly read: Pick<OnlineRead<unknown>, 'data' | 'stale' | 'failed'>;
  readonly online: boolean;
}) {
  const { t } = useTranslation();
  return online && read.data !== undefined && read.stale && !read.failed ? (
    <p className="home-muted" role="status">
      {t('costs_margins.refreshing')}
    </p>
  ) : null;
}

export function CostsScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const today = businessDayOf(clock.now());
  const [period, setPeriod] = useState<CostPeriod>(DEFAULT_COST_PERIOD);
  const [custom, setCustom] = useState(() => ({ from: shiftDay(today, -29), to: today }));
  const range = period === 'CUSTOM' ? custom : namedPeriod(period, today);
  const issue = periodIssue(range.from, range.to, today);

  if (!userId || navigation === undefined) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.costs_margins')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }
  const roles = navigation?.roles ?? [];
  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.costs_margins')} />
      {online ? null : (
        <Banner tone="warn" role="status">
          {t('costs_margins.offline_banner')}
        </Banner>
      )}
      <Section title={t('costs_margins.period_title')}>
        <div className="filter-bar">
          <Field label={t('costs_margins.period_label')}>
            {(control) => (
              <Select
                {...control}
                value={period}
                onChange={(event) => setPeriod(event.target.value as CostPeriod)}
              >
                {COST_PERIODS.map((code) => (
                  <option key={code} value={code}>
                    {t(`costs_margins.period.${code}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {period === 'CUSTOM' ? (
            <>
              <Field label={t('ledger.from_label')}>
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={custom.from}
                    onChange={(event) =>
                      setCustom((current) => ({ ...current, from: event.target.value }))
                    }
                  />
                )}
              </Field>
              <Field label={t('ledger.to_label')}>
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={custom.to}
                    onChange={(event) =>
                      setCustom((current) => ({ ...current, to: event.target.value }))
                    }
                  />
                )}
              </Field>
            </>
          ) : null}
        </div>
        {issue ? (
          <Banner tone="bad" role="alert">
            {t(`ledger.issue.${issue}`)}
          </Banner>
        ) : (
          <p className="home-muted">
            {t('costs_margins.period_range', {
              from: formatBusinessDate(range.from),
              to: formatBusinessDate(range.to),
            })}
          </p>
        )}
      </Section>
      <Overview range={issue ? null : range} online={online} />
      <Losses range={issue ? null : range} online={online} />
      <LotSection online={online} mayOpenLotSheet={holdsAnyRole(roles, ROLE_SETS.lotSheet)} />
      <p className="home-muted">{t('costs_margins.axes_note')}</p>
    </section>
  );
}

/** Période lue ; nulle tant que la période choisie est invalide (rien n'est lu). */
type Range = { readonly from: string; readonly to: string } | null;

function Overview({ range, online }: { readonly range: Range; readonly online: boolean }) {
  const { t } = useTranslation();
  const read = useOnlineRead(
    range ? overviewPath(range.from, range.to) : null,
    (key) => readPath<FinanceOverview>(key),
    online,
    '',
  );
  useRefreshOnVisible(read.retry);
  const data = read.data;
  const money = (value: number | null) =>
    value === null ? t('costs_margins.not_visible') : formatMoney(value);
  // Bloc non lisible avec ses droits : une tuile vide qui l'annonce, jamais un zéro.
  const hiddenTile = (label: string) => (
    <KpiTile label={label} value="—" detail={t('costs_margins.block_hidden')} />
  );
  return (
    <Section title={t('costs_margins.overview_title')}>
      <SectionProblem
        read={read}
        failedKey="costs_margins.overview_failed"
        retryKey="costs_margins.retry_overview"
      />
      <Refreshing read={read} online={online} />
      {!range ? (
        <p className="home-muted">{t('costs_margins.period_needed')}</p>
      ) : !data ? (
        read.failed ? null : (
          <Waiting online={online} />
        )
      ) : (
        <>
          <div className="fin-kpis fin-kpis-4">
            {data.revenue ? (
              <>
                <KpiTile
                  icon="cart"
                  label={t('costs_margins.tile_revenue')}
                  value={formatMoney(data.revenue.netRevenueXaf)}
                  detail={t('costs_margins.tile_revenue_detail', {
                    gross: formatMoney(data.revenue.grossRevenueXaf),
                    cancelled: formatMoney(data.revenue.cancelledXaf),
                    count: data.revenue.saleCount,
                  })}
                />
                <KpiTile
                  icon="chart"
                  label={t('costs_margins.tile_margin')}
                  value={
                    data.revenue.grossMarginXaf === null
                      ? '—'
                      : formatMoney(data.revenue.grossMarginXaf)
                  }
                  detail={t('costs_margins.tile_margin_detail', {
                    cost: money(data.revenue.costOfSalesXaf),
                  })}
                />
              </>
            ) : (
              hiddenTile(t('costs_margins.revenue_title'))
            )}
            {data.collected ? (
              <KpiTile
                icon="cash"
                label={t('costs_margins.collected_title')}
                value={formatMoney(data.collected.amountXaf)}
                detail={t('costs_margins.collected_detail', {
                  count: data.collected.paymentsCount,
                })}
              />
            ) : (
              hiddenTile(t('costs_margins.collected_title'))
            )}
            {data.expenses ? (
              <KpiTile
                icon="receipt"
                label={t('costs_margins.expenses_title')}
                value={formatMoney(data.expenses.totalXaf)}
                detail={t('costs_margins.expenses_detail', { count: data.expenses.count })}
              />
            ) : (
              hiddenTile(t('costs_margins.expenses_title'))
            )}
          </div>
          {data.expenses && data.expenses.byCategory.length > 0 ? (
            <ul className="fin-breakdown">
              {data.expenses.byCategory.map((category) => (
                <li key={category.code}>
                  {t('costs_margins.expense_category', {
                    label: category.label,
                    amount: formatMoney(category.amountXaf),
                    count: category.count,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
          {data.expenses && (data.expenses.pendingXaf > 0 || data.expenses.unjustifiedXaf > 0) ? (
            <p className="text-warn">
              {t('costs_margins.expenses_pending', {
                pending: formatMoney(data.expenses.pendingXaf),
                unjustified: formatMoney(data.expenses.unjustifiedXaf),
              })}
            </p>
          ) : null}
          <h3 className="fin-sub">
            {t('costs_margins.balances_title', { date: formatBusinessDate(data.as_of) })}
          </h3>
          <p className="home-muted">{t('costs_margins.balances_note')}</p>
          <div className="fin-kpis">
            {data.receivables ? (
              <KpiTile
                icon="users"
                label={t('costs_margins.tile_receivables')}
                value={formatMoney(data.receivables.outstandingXaf)}
                tone={data.receivables.overdueXaf > 0 ? 'warn' : 'neutral'}
                detail={`${t('costs_margins.receivables_open_detail', {
                  count: data.receivables.openCount,
                })} · ${t('costs_margins.receivables_overdue', {
                  amount: formatMoney(data.receivables.overdueXaf),
                  count: data.receivables.overdueCount,
                })}`}
              />
            ) : null}
            {data.payables ? (
              <KpiTile
                icon="truck"
                label={t('costs_margins.tile_payables')}
                value={formatMoney(data.payables.balanceXaf)}
                detail={t('costs_margins.payables_detail', {
                  overdue: formatMoney(data.payables.overdueXaf),
                  advance: formatMoney(data.payables.advanceXaf),
                  net: formatMoney(data.payables.netXaf),
                })}
              />
            ) : null}
            {data.cash ? (
              <KpiTile
                icon="store"
                label={t('costs_margins.tile_cash')}
                value={formatMoney(data.cash.totalXaf)}
              />
            ) : null}
          </div>
          {data.receivables ? null : (
            <p className="home-muted">{t('costs_margins.receivables_hidden')}</p>
          )}
          {data.payables ? null : (
            <p className="home-muted">{t('costs_margins.payables_hidden')}</p>
          )}
          {data.cash ? (
            <ul className="fin-breakdown">
              {Object.entries(data.cash.byAccountType).map(([type, amount]) => (
                <li key={type}>
                  {t('costs_margins.cash_type', {
                    type: t(`treasury.account_type.${type}`, { defaultValue: type }),
                    amount: formatMoney(amount),
                  })}
                </li>
              ))}
            </ul>
          ) : (
            <p className="home-muted">{t('costs_margins.cash_hidden')}</p>
          )}
        </>
      )}
    </Section>
  );
}

function Losses({ range, online }: { readonly range: Range; readonly online: boolean }) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [group, setGroup] = useState<LossGroup>('product');
  const read = useOnlineRead(
    range ? lossesPath(range.from, range.to, group) : null,
    (key) => readPath<LossSummary>(key),
    online,
    '',
  );
  // Codes des lots lus sur le serveur (les lots clôturés ne sont pas sur l'appareil), par lot seulement.
  const lotCodes = useOnlineRead(
    group === 'lot' ? 'loss-lot-codes' : null,
    () => readPages<LotChoice>(lotCodePaths(), 'lots', LOT_CODE_MAX_PAGES),
    online,
    '',
  );
  useRefreshOnVisible(read.retry);
  const data = read.data;
  const productOf = (id: string | null) => refs?.products.find((product) => product.id === id);
  const label = (line: LossSummary['lines'][number]) => {
    if (group === 'product') {
      return line.productId ? (productOf(line.productId)?.name ?? shortId(line.productId)) : '—';
    }
    if (group === 'lot') {
      if (!line.productionLotId) return '—';
      return (
        lotCodes.data?.items.find((lot) => lot.id === line.productionLotId)?.lotCode ??
        refs?.productionLots.find((lot) => lot.id === line.productionLotId)?.lot_code ??
        t('costs_margins.lot_unknown', { id: shortId(line.productionLotId) })
      );
    }
    // Motif désactivé ou inconnu de l'appareil : nommé par son identifiant court.
    const reason = line.reasonCodeId
      ? (refs?.reasonCodes.find((code) => code.id === line.reasonCodeId)?.label ??
        t('costs_margins.reason_unknown', { id: shortId(line.reasonCodeId) }))
      : null;
    const category = line.category
      ? t(`loss.categories.${line.category}`, { defaultValue: line.category })
      : null;
    return [category, reason].filter(Boolean).join(' · ') || '—';
  };
  // Une quantité n'a de sens que pour un produit (une unité) ; par lot ou motif, les déclarations.
  const quantity = (line: LossSummary['lines'][number], value: number) => {
    const unit = productOf(line.productId)?.base_unit_code;
    return unit
      ? `${formatQuantity(value)} ${unitLabel(unit, value, refs?.units)}`.trim()
      : formatQuantity(value);
  };
  const money = (value: number | null) =>
    value === null ? t('costs_margins.not_visible') : formatMoney(value);
  return (
    <Section title={t('costs_margins.losses_title')}>
      <p className="home-muted">{t('costs_margins.losses_note')}</p>
      <div className="filter-bar">
        <Field label={t('costs_margins.losses_group_label')}>
          {(control) => (
            <Select
              {...control}
              value={group}
              onChange={(event) => setGroup(event.target.value as LossGroup)}
            >
              {LOSS_GROUPS.map((code) => (
                <option key={code} value={code}>
                  {t(`costs_margins.losses_group.${code}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <SectionProblem
        read={read}
        failedKey="costs_margins.losses_failed"
        retryKey="costs_margins.retry_losses"
      />
      <Refreshing read={read} online={online} />
      {group === 'lot' ? <p className="home-muted">{t('costs_margins.losses_lot_note')}</p> : null}
      {!range ? (
        <p className="home-muted">{t('costs_margins.period_needed')}</p>
      ) : !data ? (
        read.failed ? null : (
          <Waiting online={online} />
        )
      ) : data.lines.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={t(
            group === 'lot' ? 'costs_margins.losses_lot_empty' : 'costs_margins.losses_empty',
          )}
        />
      ) : (
        <>
          {data.total_value_xaf === null ? (
            <p className="home-muted">{t('lot_sheet.amounts_hidden')}</p>
          ) : (
            <p className="fin-total">
              {t(
                group === 'lot' ? 'costs_margins.losses_lot_total' : 'costs_margins.losses_total',
                {
                  amount: formatMoney(data.total_value_xaf),
                },
              )}
            </p>
          )}
          <ul className="line-list">
            {data.lines.map((line, index) => (
              <li
                key={`${label(line)}-${index}`}
                className="line-card fin-card"
                aria-label={label(line)}
              >
                <p>
                  <strong>{label(line)}</strong> · {money(line.valueXaf)}
                </p>
                <p className="home-muted">
                  {group === 'product'
                    ? t('costs_margins.loss_quantity', {
                        quantity: quantity(line, line.quantityBase),
                        count: line.declarations,
                      })
                    : t('costs_margins.loss_declarations', { count: line.declarations })}
                </p>
                {line.pendingQuantityBase > 0 ? (
                  <p className="text-warn">
                    {group === 'product'
                      ? t('costs_margins.loss_pending_quantity', {
                          quantity: quantity(line, line.pendingQuantityBase),
                          amount: money(line.pendingValueXaf),
                        })
                      : t('costs_margins.loss_pending', { amount: money(line.pendingValueXaf) })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function LotSection({
  online,
  mayOpenLotSheet,
}: {
  readonly online: boolean;
  readonly mayOpenLotSheet: boolean;
}) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [status, setStatus] = useState<LotStatusChoice>('CLOSED');
  const [lotId, setLotId] = useState('');
  const [entriesShown, setEntriesShown] = useState(false);
  const lots = useOnlineRead(
    `lots:${status}`,
    () => readPages<LotChoice>([lotsPath(status)], 'lots', 1),
    online,
    '',
  );
  const detail = useOnlineRead(
    lotId ? lotPath(lotId) : null,
    (key) => readPath<LotMarginsResponse>(key),
    online,
    '',
  );
  useRefreshOnVisible(() => {
    lots.retry();
    if (lotId) detail.retry();
  });
  const choices = sortLots(lots.data?.items ?? []);
  const lot = detail.data?.lot;
  const money = (value: number | null) =>
    value === null ? t('costs_margins.not_visible') : formatMoney(value);
  const productName = (id: string) =>
    refs?.products.find((product) => product.id === id)?.name ?? shortId(id);
  return (
    <Section title={t('costs_margins.lots_title')}>
      <div className="filter-bar">
        <Field label={t('costs_margins.lot_status_label')}>
          {(control) => (
            <Select
              {...control}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as LotStatusChoice);
                setLotId('');
                setEntriesShown(false);
              }}
            >
              {LOT_STATUSES.map((code) => (
                <option key={code} value={code}>
                  {t(`costs_margins.lot_status.${code}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('costs_margins.lot_label')}>
          {(control) => (
            <Select
              {...control}
              value={lotId}
              disabled={choices.length === 0 && !lotId}
              onChange={(event) => {
                setLotId(event.target.value);
                setEntriesShown(false);
              }}
            >
              <option value="">{t('costs_margins.lot_placeholder')}</option>
              {lotId && lot && !choices.some((choice) => choice.id === lotId) ? (
                <option value={lotId}>
                  {t('costs_margins.lot_option', {
                    code: lot.lotCode,
                    product: productName(lot.productId),
                  })}
                </option>
              ) : null}
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {t('costs_margins.lot_option', {
                    code: choice.lotCode,
                    product: productName(choice.productId),
                  })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <SectionProblem
        read={lots}
        failedKey="costs_margins.lots_failed"
        retryKey="costs_margins.retry_lots"
      />
      {!lots.data ? (
        lots.failed ? null : (
          <Waiting online={online} />
        )
      ) : choices.length === 0 ? (
        <p className="home-muted">{t('costs_margins.lots_empty')}</p>
      ) : lots.data.more ? (
        <p className="home-muted">{t('costs_margins.lots_truncated', { limit: LOT_PAGE_LIMIT })}</p>
      ) : null}
      {lotId ? (
        <>
          <SectionProblem
            read={detail}
            failedKey="costs_margins.lot_failed"
            retryKey="costs_margins.retry_lot"
          />
          <Refreshing read={detail} online={online} />
          {!lot ? (
            detail.failed ? null : (
              <Waiting online={online} />
            )
          ) : (
            <Card
              padded
              className="fin-lot"
              role="group"
              aria-label={t('costs_margins.lot_card', { code: lot.lotCode })}
            >
              <h3 className="fin-sub">
                {t('costs_margins.lot_costs_title', { code: lot.lotCode })}
              </h3>
              {lot.costs.netXaf === null ? (
                <p className="home-muted">{t('lot_sheet.amounts_hidden')}</p>
              ) : (
                <>
                  <ul className="fin-breakdown">
                    {lot.costs.breakdown.map((line) => (
                      <li key={line.costType}>
                        {t('costs_margins.cost_line', {
                          type: t(`lot_sheet.cost_type.${line.costType}`, {
                            defaultValue: line.costType,
                          }),
                          amount: money(line.netXaf),
                        })}
                      </li>
                    ))}
                  </ul>
                  <p className="fin-total">
                    {t('costs_margins.cost_total', {
                      net: money(lot.costs.netXaf),
                      remaining: money(lot.costs.remainingXaf),
                    })}
                  </p>
                  {lot.costs.costPerHeadXaf !== null ? (
                    <p className="home-muted">
                      {t('costs_margins.cost_per_head', {
                        amount: money(lot.costs.costPerHeadXaf),
                      })}
                    </p>
                  ) : null}
                </>
              )}
              <h3 className="fin-sub">{t('costs_margins.lot_margins_title')}</h3>
              {!lotWithoutSales(lot.sales) ? (
                <>
                  <p>
                    {t('costs_margins.lot_revenue', {
                      revenue: money(lot.sales.netRevenueXaf),
                      slaughter: money(lot.sales.slaughterProductsRevenueXaf),
                      count: lot.sales.soldQuantity,
                    })}
                  </p>
                  <p className="fin-total">
                    {t('costs_margins.lot_margin', { amount: money(lot.sales.lotMarginXaf) })}
                  </p>
                  <p>
                    {t('costs_margins.lot_gross_margin', {
                      cost: money(lot.sales.costOfSalesXaf),
                      amount: money(lot.sales.grossMarginXaf),
                    })}
                  </p>
                  <p className="home-muted">{t('costs_margins.margins_note')}</p>
                </>
              ) : (
                <p className="home-muted">{t('costs_margins.no_sales')}</p>
              )}
              <div className="result-actions">
                {mayOpenLotSheet ? (
                  <LinkButton to={ROUTES.lotSheetFor(lot.id)} variant="tonal" size="sm" icon="file">
                    {t('costs_margins.lot_sheet_link', { code: lot.lotCode })}
                  </LinkButton>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  iconEnd={entriesShown ? 'chevron-up' : 'chevron-down'}
                  aria-expanded={entriesShown}
                  onClick={() => setEntriesShown((current) => !current)}
                >
                  {t(entriesShown ? 'costs_margins.entries_hide' : 'costs_margins.entries_show', {
                    code: lot.lotCode,
                  })}
                </Button>
              </div>
              {entriesShown ? <CostEntries lotId={lot.id} online={online} /> : null}
            </Card>
          )}
        </>
      ) : null}
    </Section>
  );
}

/** Écritures de coût d'un lot, de la plus récente à la plus ancienne (registre en ajout seul). */
function CostEntries({ lotId, online }: { readonly lotId: string; readonly online: boolean }) {
  const { t } = useTranslation();
  const read = useOnlineRead(
    costEntriesPath(lotId),
    (key) => readPages<CostEntry>([key], 'cost_entries', COST_ENTRY_MAX_PAGES),
    online,
    '',
  );
  useRefreshOnVisible(read.retry);
  const problem = (
    <SectionProblem
      read={read}
      failedKey="costs_margins.entries_failed"
      retryKey="costs_margins.retry_entries"
    />
  );
  if (!read.data) return read.failed ? problem : <Waiting online={online} />;
  if (read.data.items.length === 0) {
    return (
      <>
        {problem}
        <p className="home-muted">{t('costs_margins.entries_empty')}</p>
      </>
    );
  }
  return (
    <>
      {problem}
      <Refreshing read={read} online={online} />
      <ul className="line-list">
        {sortCostEntries(read.data.items).map((entry) => (
          <li key={entry.id}>
            {t(`costs_margins.entry.${entry.direction}`, {
              date: formatBusinessDate(businessDayOf(new Date(entry.occurredAt))),
              type: t(`lot_sheet.cost_type.${entry.costType}`, { defaultValue: entry.costType }),
              amount: formatMoney(entry.amountXaf),
              source: t(`costs_margins.source.${entry.sourceType}`, {
                defaultValue: entry.sourceType,
              }),
            })}
            {entry.reversesEntryId ? ` · ${t('costs_margins.entry_reversal')}` : ''}
            {entry.comment ? ` · ${entry.comment}` : ''}
          </li>
        ))}
      </ul>
      {read.data.more ? <p className="home-muted">{t('costs_margins.entries_truncated')}</p> : null}
    </>
  );
}

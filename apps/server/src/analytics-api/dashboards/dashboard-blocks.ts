/**
 * Blocs des tableaux de bord et de la tour de contrôle (P9-17 ; D11 §7.2, ADR-066 §2 et §4). Un bloc **ne lit aucune
 * table** : il appelle les fonctions de référence du registre des indicateurs (ADR-065 §1) dans le périmètre de
 * l'utilisateur, calcule la valeur de la période précédente pour les **flux seulement**, masque les valeurs au
 * coût sans `inventory.valuation.read` (valeur `null`, jamais une erreur) et porte un lien d'exploration vers
 * l'explorateur (BR-ANA-010, niveau 1).
 *
 * Un bloc est isolé (`guarded`) : un périmètre que les fonctions de référence ne savent pas exprimer
 * (`SCOPE_UNSUPPORTED`), une étendue tronquée au-delà de `analytics.scope_max_candidates` (`SCOPE_TRUNCATED`, TB-6),
 * un bloc dont la forme viole le contrat (`BLOCK_INVALID`, TB-12) ou une erreur technique le rend `unavailable`,
 * sans faire échouer les autres blocs.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  kpiHasPreviousPeriod,
  type AnalyticsPeriod,
  type AnalyticsPeriodWindow,
} from '@gic/domain';
import { dashboardBlockSchema, type DashboardBlock, type DashboardKpi } from '@gic/contracts';
import type { DB } from '../../platform/kysely/database.js';
import { logStructured } from '../../platform/observability/logger.js';
import type { ReadScope } from '../../platform/read-scope.js';
import type { ScopeIssue } from './scope-adapter.js';
import { alertSummary } from '../../modules/communication/application/public/index.js';
import { listProducts } from '../../modules/catalog/application/public/index.js';
import {
  conversionCohort,
  inactiveAfterDays,
  portfolioActivity,
  portfolioHealth,
  visitToOrderRate,
} from '../../modules/crm/application/public/index.js';
import { attendanceDays } from '../../modules/fieldwork/application/public/index.js';
import { expensesSummary } from '../../modules/finance/application/public/index.js';
import {
  inventoryVarianceSummary,
  lossValueSummary,
  mortalitySummary,
  stockCoverage,
  stockHealth,
} from '../../modules/inventory/application/public/index.js';
import {
  cumulativeMortalityRate,
  eggSummary,
  hatchRate,
  productionOverview,
} from '../../modules/production/application/public/index.js';
import {
  cashedActivity,
  ordersActivity,
  periodRevenue,
  receivablesSummary,
  repurchaseRate,
  salesActivityByDay,
  sumSalesActivity,
} from '../../modules/sales/application/public/index.js';
import { hasPermissionAt } from '../../modules/identity/application/public/index.js';
import { toBin } from '../../platform/kysely/uuid-columns.js';
import { supplierServiceRate } from '../../modules/procurement/application/public/index.js';
import { countPendingApprovalsFor } from '../../modules/approvals/application/public/index.js';
import { buildDistributionDashboard } from '../../distribution-api/distribution-dashboard.service.js';
import {
  DISTRIBUTION_DASHBOARD_READ,
  resolveDashboardScope,
} from '../../distribution-api/dashboard-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;
type BlockCode = DashboardBlock['code'];

/** Borne du libellé d'une ligne de détail du contrat (`details[].label`) : une borne de forme, pas un seuil métier. */
const DETAIL_LABEL_MAX = 200;

/** Libellé ramené à `max` caractères au plus, terminé par « … » s'il a été coupé. */
export const fitLabel = (label: string, max: number): string =>
  label.length <= max ? label : `${label.slice(0, max - 1)}…`;

export interface DashboardContext {
  readonly executor: Executor;
  readonly userId: string;
  readonly at: Date;
  readonly today: string;
  readonly period: AnalyticsPeriod;
  /**
   * `null` : l'étendue exacte n'est pas exprimable en `ReadScope` (`SCOPE_UNSUPPORTED`) ou a été tronquée au-delà
   * de `analytics.scope_max_candidates` (`SCOPE_TRUNCATED`, TB-6).
   */
  readonly scope: ReadScope | null;
  /** Cause d'un `scope` nul (défaut `SCOPE_UNSUPPORTED`). */
  readonly scopeIssue?: ScopeIssue;
  readonly canReadValuation: boolean;
  /** Plafond du compteur de validations en attente (`analytics.pending_approvals_count_cap`). */
  readonly pendingApprovalsCap: number;
}

class BlockUnavailable extends Error {
  constructor(
    readonly reason: 'FORBIDDEN' | 'ERROR',
    readonly errorCode: string,
  ) {
    super(errorCode);
  }
}

const isAllScope = (scope: ReadScope): boolean =>
  scope.siteIds === undefined && scope.userIds === undefined;

function scopeOf(context: DashboardContext): ReadScope {
  if (context.scope === null) {
    throw new BlockUnavailable('ERROR', context.scopeIssue ?? 'SCOPE_UNSUPPORTED');
  }
  return context.scope;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

interface KpiInput {
  readonly code: string;
  readonly label: string;
  readonly unit: DashboardKpi['unit'];
  readonly value: number | null;
  readonly previous?: number | null;
  readonly protectedValue?: boolean;
  readonly canReadValuation: boolean;
  readonly explore?: DashboardKpi['explore'];
  readonly alertType?: string;
}

/** Un indicateur du bloc : valeur masquée si elle est au coût, période précédente pour les seuls flux. */
function kpi(input: KpiInput): DashboardKpi {
  const hidden = input.protectedValue === true && !input.canReadValuation;
  const value = hidden ? null : input.value;
  const flow = kpiHasPreviousPeriod(input.code);
  const previous = flow && !hidden ? (input.previous ?? null) : null;
  return {
    code: input.code,
    label: input.label,
    unit: input.unit,
    value,
    ...(flow
      ? {
          previousValue: previous,
          variationPct:
            value !== null && previous !== null && previous !== 0
              ? round1(((value - previous) / Math.abs(previous)) * 100)
              : null,
        }
      : {}),
    explore: hidden ? null : (input.explore ?? null),
    alertType: input.alertType ?? null,
  };
}

const dayWindow = (window: AnalyticsPeriodWindow) => ({
  fromDay: window.fromDay,
  toDay: window.toDay,
});
const utcWindow = (window: AnalyticsPeriodWindow) => ({
  fromUtc: window.startUtc,
  toUtc: window.endUtc,
});

/** Lien d'exploration d'un indicateur : le jeu, la mesure et la période courante en jours inclus. */
function exploreLink(
  context: DashboardContext,
  dataset: string,
  measures: readonly string[],
  options: {
    readonly dimensions?: readonly string[];
    readonly state?: boolean;
    readonly filters?: NonNullable<DashboardKpi['explore']>['definition']['filters'];
  } = {},
): DashboardKpi['explore'] {
  return {
    definition: {
      dataset,
      ...(options.state === true
        ? {}
        : {
            period: {
              code: 'CUSTOM' as const,
              fromDay: context.period.fromDay,
              toDay: context.period.toDay,
            },
          }),
      dimensions: [...(options.dimensions ?? [])],
      measures: [...measures],
      filters: [...(options.filters ?? [])],
      sort: [],
    },
  };
}

function block(
  code: BlockCode,
  title: string,
  kpis: DashboardKpi[],
  details: DashboardBlock['details'] = [],
): DashboardBlock {
  return { code, title, kpis, details, unavailable: null };
}

/**
 * Un bloc isolé : un échec le rend indisponible sans faire échouer les autres. TB-12 : la forme du bloc est
 * validée par le contrat (`dashboardBlockSchema`) ; un bloc invalide devient indisponible (`BLOCK_INVALID`) au lieu
 * de faire échouer, par la validation de la réponse entière, tout le tableau en 500.
 */
export async function guarded(
  code: BlockCode,
  title: string,
  build: () => Promise<DashboardBlock>,
): Promise<DashboardBlock> {
  try {
    const built = await build();
    const checked = dashboardBlockSchema.safeParse(built);
    // Le bloc d'origine est rendu tel quel, pas la copie validée (AT-054).
    if (checked.success) return built;
    // Les chemins fautifs seulement, jamais les valeurs.
    logStructured(
      'warn',
      { module: 'analytics', code: 'BLOCK_INVALID' },
      `Bloc ${code} invalide (${checked.error.issues.map((issue) => issue.path.join('.')).join(', ')}).`,
    );
    return {
      code,
      title,
      kpis: [],
      details: [],
      unavailable: { reason: 'ERROR' as const, code: 'BLOCK_INVALID' },
    };
  } catch (error) {
    if (!(error instanceof BlockUnavailable)) {
      // Échec technique : visible côté serveur, sans le message d'erreur (jamais dans la réponse).
      logStructured(
        'warn',
        { module: 'analytics', code: 'BLOCK_FAILED' },
        `Bloc ${code} en échec.`,
      );
    }
    const unavailable =
      error instanceof BlockUnavailable
        ? { reason: error.reason, code: error.errorCode }
        : { reason: 'ERROR' as const, code: 'BLOCK_FAILED' };
    return { code, title, kpis: [], details: [], unavailable };
  }
}

// --- Les blocs -------------------------------------------------------------------------------------------------

async function salesOf(context: DashboardContext, window: AnalyticsPeriodWindow) {
  const days = await salesActivityByDay(context.executor, scopeOf(context), dayWindow(window));
  return sumSalesActivity(days, window.fromDay, window.toDay);
}

async function cashedOf(context: DashboardContext, window: AnalyticsPeriodWindow): Promise<number> {
  const rows = await cashedActivity(context.executor, scopeOf(context), dayWindow(window));
  return rows.reduce((total, row) => total + row.confirmedXaf - row.cancelledXaf, 0);
}

export async function salesBlock(context: DashboardContext): Promise<DashboardBlock> {
  const [current, previous, orders, previousOrders] = await Promise.all([
    salesOf(context, context.period),
    salesOf(context, context.period.previous),
    ordersActivity(context.executor, scopeOf(context), utcWindow(context.period)),
    ordersActivity(context.executor, scopeOf(context), utcWindow(context.period.previous)),
  ]);
  const average = (net: number, count: number) =>
    net > 0 && count > 0 ? Math.round(net / count) : null;
  const can = context.canReadValuation;
  return block('VENTES', 'Ventes', [
    kpi({
      code: 'KPI-COM-08',
      label: 'Chiffre d’affaires',
      unit: 'xaf',
      value: current.netXaf,
      previous: previous.netXaf,
      canReadValuation: can,
      explore: exploreLink(context, 'f_sales_line', ['revenue'], { dimensions: ['site_id'] }),
    }),
    kpi({
      code: 'KPI-COM-07',
      label: 'Ventes',
      unit: 'count',
      value: current.salesCount,
      previous: previous.salesCount,
      canReadValuation: can,
      explore: exploreLink(context, 'f_sales_line', ['sales_count']),
    }),
    kpi({
      code: 'KPI-COM-10',
      label: 'Panier moyen',
      unit: 'xaf',
      value: average(current.netXaf, current.salesCount),
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-COM-06',
      label: 'Commandes confirmées',
      unit: 'count',
      value: orders.orders,
      previous: previousOrders.orders,
      canReadValuation: can,
      explore: exploreLink(context, 'f_orders', ['orders_count']),
    }),
  ]);
}

export async function financeBlock(context: DashboardContext): Promise<DashboardBlock> {
  const scope = scopeOf(context);
  const can = context.canReadValuation;
  const [cashed, previousCashed, receivables] = await Promise.all([
    cashedOf(context, context.period),
    cashedOf(context, context.period.previous),
    receivablesSummary(context.executor, scope, context.today),
  ]);
  // Les dépenses et la marge ne se lisent que sur toute l'entreprise ou par site : sinon le chiffre serait faux.
  const expenses = isAllScope(scope)
    ? await Promise.all([
        expensesSummary(context.executor, utcWindow(context.period)),
        expensesSummary(context.executor, utcWindow(context.period.previous)),
      ])
    : null;
  const marginScope = scope.userIds === undefined;
  const margin = marginScope
    ? await Promise.all([
        periodRevenue(context.executor, {
          ...utcWindow(context.period),
          ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
        }),
        periodRevenue(context.executor, {
          ...utcWindow(context.period.previous),
          ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
        }),
      ])
    : null;
  return block('FINANCES', 'Finances', [
    kpi({
      code: 'KPI-FIN-01',
      label: 'Encaissé',
      unit: 'xaf',
      value: cashed,
      previous: previousCashed,
      canReadValuation: can,
      explore: exploreLink(context, 'f_payments', ['amount']),
    }),
    kpi({
      code: 'KPI-FIN-02',
      label: 'Créances',
      unit: 'xaf',
      value: receivables.outstandingXaf,
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-FIN-03',
      label: 'Créances en retard',
      unit: 'xaf',
      value: receivables.overdueXaf,
      canReadValuation: can,
      alertType: 'OVERDUE_RECEIVABLE',
    }),
    kpi({
      code: 'KPI-FIN-04',
      label: 'Dépenses',
      unit: 'xaf',
      value: expenses?.[0].totalXaf ?? null,
      previous: expenses?.[1].totalXaf ?? null,
      canReadValuation: can,
      explore: expenses === null ? null : exploreLink(context, 'f_expenses', ['amount']),
    }),
    kpi({
      code: 'KPI-FIN-07',
      label: 'Marge brute',
      unit: 'xaf',
      value: margin?.[0].grossMarginXaf ?? null,
      previous: margin?.[1].grossMarginXaf ?? null,
      protectedValue: true,
      canReadValuation: can,
      explore: exploreLink(context, 'f_sales_line', ['margin']),
    }),
  ]);
}

export async function stockBlock(context: DashboardContext): Promise<DashboardBlock> {
  const scope = scopeOf(context);
  const can = context.canReadValuation;
  const siteOnly = scope.userIds === undefined;
  const [health, products, coverage, losses, previousLosses, variance, previousVariance] =
    await Promise.all([
      stockHealth(context.executor, scope),
      listProducts(context.executor),
      stockCoverage(context.executor, scope, context.at),
      siteOnly
        ? lossValueSummary(context.executor, {
            ...utcWindow(context.period),
            groupBy: 'product',
            ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
          })
        : null,
      siteOnly
        ? lossValueSummary(context.executor, {
            ...utcWindow(context.period.previous),
            groupBy: 'product',
            ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
          })
        : null,
      inventoryVarianceSummary(context.executor, scope, utcWindow(context.period)),
      inventoryVarianceSummary(context.executor, scope, utcWindow(context.period.previous)),
    ]);
  const sum = (
    lines: Awaited<ReturnType<typeof lossValueSummary>> | null,
    pick: (line: Awaited<ReturnType<typeof lossValueSummary>>[number]) => number,
  ) => (lines === null ? null : lines.reduce((total, line) => total + pick(line), 0));
  const nameOf = new Map(products.map((product) => [product.id, product.name]));
  const details = coverage
    .filter((line) => line.coverageDays !== null)
    .slice(0, 10)
    .map((line) => ({
      label: fitLabel(
        `Couverture (jours) — ${nameOf.get(line.productId) ?? line.productId}`,
        DETAIL_LABEL_MAX,
      ),
      value: line.coverageDays,
      unit: 'ratio' as const,
    }));
  return block(
    'STOCK',
    'Stock',
    [
      kpi({
        code: 'KPI-STK-02',
        label: 'Valeur du stock',
        unit: 'xaf',
        value: health.valueXaf,
        protectedValue: true,
        canReadValuation: can,
        explore: exploreLink(context, 'f_stock_balance', ['value'], {
          state: true,
          dimensions: ['location_type'],
        }),
      }),
      kpi({
        code: 'KPI-STK-06',
        label: 'Ruptures',
        unit: 'count',
        value: health.stockOut,
        canReadValuation: can,
        alertType: 'STOCK_OUT',
      }),
      kpi({
        code: 'KPI-STK-03',
        label: 'Pertes déclarées',
        unit: 'count',
        value: sum(losses, (line) => line.declarations),
        previous: sum(previousLosses, (line) => line.declarations),
        canReadValuation: can,
        explore: exploreLink(context, 'f_losses', ['quantity'], { dimensions: ['category'] }),
        alertType: 'HIGH_LOSS',
      }),
      kpi({
        code: 'KPI-FIN-08',
        label: 'Valeur des pertes',
        unit: 'xaf',
        value: sum(losses, (line) => line.valueXaf),
        previous: sum(previousLosses, (line) => line.valueXaf),
        protectedValue: true,
        canReadValuation: can,
        explore: exploreLink(context, 'f_losses', ['value'], { dimensions: ['category'] }),
      }),
      kpi({
        code: 'KPI-STK-04',
        label: 'Écarts d’inventaire (valeur nette)',
        unit: 'xaf',
        value: variance.netValueXaf,
        previous: previousVariance.netValueXaf,
        protectedValue: true,
        canReadValuation: can,
        explore: exploreLink(context, 'f_stock_moves', ['value'], { dimensions: ['move_type'] }),
      }),
    ],
    details,
  );
}

export async function productionBlock(context: DashboardContext): Promise<DashboardBlock> {
  const scope = scopeOf(context);
  const can = context.canReadValuation;
  const [overview, mortality, previousMortality, cumulative, eggs, previousEggs, hatch] =
    await Promise.all([
      productionOverview(context.executor, scope),
      mortalitySummary(context.executor, scope, dayWindow(context.period)),
      mortalitySummary(context.executor, scope, dayWindow(context.period.previous)),
      cumulativeMortalityRate(context.executor, scope),
      eggSummary(context.executor, scope, dayWindow(context.period)),
      eggSummary(context.executor, scope, dayWindow(context.period.previous)),
      hatchRate(context.executor, scope, utcWindow(context.period)),
    ]);
  const pct = (rate: number | null) => (rate === null ? null : round1(rate * 100));
  return block(
    'PRODUCTION',
    'Production',
    [
      kpi({
        code: 'KPI-PRD-01',
        label: 'Effectif en élevage',
        unit: 'count',
        value: overview.rearingHeads,
        canReadValuation: can,
      }),
      kpi({
        code: 'KPI-PRD-02',
        label: 'Mortalité (têtes)',
        unit: 'count',
        value: mortality.total,
        previous: previousMortality.total,
        canReadValuation: can,
        explore: exploreLink(context, 'f_losses', ['quantity'], {
          dimensions: ['business_day'],
          filters: [{ field: 'category', op: 'EQ', value: 'MORTALITE' }],
        }),
        alertType: 'HIGH_MORTALITY',
      }),
      kpi({
        code: 'KPI-PRD-03',
        label: 'Taux de mortalité cumulé',
        unit: 'pct',
        value: pct(cumulative.rate),
        canReadValuation: can,
      }),
      kpi({
        code: 'KPI-PRD-06',
        label: 'Œufs collectés',
        unit: 'count',
        value: eggs.collected,
        previous: previousEggs.collected,
        canReadValuation: can,
        explore: exploreLink(context, 'f_production_daily', ['eggs_collected'], {
          dimensions: ['business_day'],
        }),
      }),
      kpi({
        code: 'KPI-PRD-07',
        label: 'Taux d’œufs commercialisables',
        unit: 'pct',
        value: pct(eggs.marketableRate),
        canReadValuation: can,
      }),
      kpi({
        code: 'KPI-PRD-08',
        label: 'Taux d’éclosion',
        unit: 'pct',
        value: pct(hatch.rate),
        canReadValuation: can,
      }),
    ],
    mortality.byDay.slice(-14).map((day) => ({
      label: `Mortalité du ${day.day}`,
      value: day.heads,
      unit: 'count' as const,
    })),
  );
}

export async function teamsBlock(context: DashboardContext): Promise<DashboardBlock> {
  const scope = scopeOf(context);
  const can = context.canReadValuation;
  const [activity, previousActivity, cohort, orderRate, attendance, previousAttendance] =
    await Promise.all([
      portfolioActivity(context.executor, scope, utcWindow(context.period)),
      portfolioActivity(context.executor, scope, utcWindow(context.period.previous)),
      conversionCohort(context.executor, scope, utcWindow(context.period)),
      visitToOrderRate(context.executor, scope, utcWindow(context.period)),
      attendanceDays(context.executor, scope, utcWindow(context.period)),
      attendanceDays(context.executor, scope, utcWindow(context.period.previous)),
    ]);
  const pct = (rate: number | null) => (rate === null ? null : round1(rate * 100));
  return block('EQUIPES', 'Équipes commerciales', [
    kpi({
      code: 'KPI-COM-01',
      label: 'Prospects créés',
      unit: 'count',
      value: activity.accountsCreated,
      previous: previousActivity.accountsCreated,
      canReadValuation: can,
      explore: exploreLink(context, 'f_prospecting', ['accounts_created']),
    }),
    kpi({
      code: 'KPI-COM-03',
      label: 'Visites',
      unit: 'count',
      value: activity.visits,
      previous: previousActivity.visits,
      canReadValuation: can,
      explore: exploreLink(context, 'f_prospecting', ['visits']),
      alertType: 'INACTIVE_COMMERCIAL',
    }),
    kpi({
      code: 'KPI-COM-05',
      label: 'Nouveaux clients',
      unit: 'count',
      value: activity.newCustomers,
      previous: previousActivity.newCustomers,
      canReadValuation: can,
      explore: exploreLink(context, 'f_prospecting', ['conversions']),
    }),
    kpi({
      code: 'KPI-COM-11',
      label: 'Taux de conversion (cohorte)',
      unit: 'pct',
      value: pct(cohort.rate),
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-COM-12',
      label: 'Taux visite → commande',
      unit: 'pct',
      value: pct(orderRate.rate),
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-COM-17',
      label: 'Jours de présence',
      unit: 'count',
      value: attendance.presenceDays,
      previous: previousAttendance.presenceDays,
      canReadValuation: can,
      explore: exploreLink(context, 'f_attendance', ['presence_days']),
    }),
  ]);
}

export async function commercialBlock(context: DashboardContext): Promise<DashboardBlock> {
  const scope = scopeOf(context);
  const can = context.canReadValuation;
  // Seuil d'inactivité : réglage `crm.inactive_after_days` (AV-013, TB-5).
  const inactiveDays = await inactiveAfterDays(context.executor, context.at);
  const [health, repurchase] = await Promise.all([
    // TB-1 : un compte se lit par son titulaire ; des personnes (avec ou sans sites) = le titulaire seul, car le
    // site de rattachement d'un compte de commercial est le plus souvent vide (un ET le viderait, AV-465) ; des
    // sites seuls = le site de rattachement (liste vide : zéros, jamais tout le portefeuille) ; ALL = tout.
    portfolioHealth(context.executor, {
      ...(scope.userIds !== undefined
        ? { ownerUserIds: scope.userIds }
        : scope.siteIds !== undefined
          ? { siteIds: scope.siteIds }
          : {}),
      at: context.at,
      inactiveDays,
    }),
    repurchaseRate(context.executor, scope, dayWindow(context.period)),
  ]);
  return block('COMMERCIAL', 'Portefeuille clients', [
    kpi({
      code: 'KPI-COM-13',
      label: 'Clients actifs',
      unit: 'count',
      value: health.customers - health.inactiveCustomers,
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-COM-14',
      label: 'Clients inactifs',
      unit: 'count',
      value: health.inactiveCustomers,
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-COM-15',
      label: 'Taux de réachat',
      unit: 'pct',
      value: repurchase.rate === null ? null : round1(repurchase.rate * 100),
      canReadValuation: can,
    }),
  ]);
}

export async function distributionBlock(context: DashboardContext): Promise<DashboardBlock> {
  const allowed = await hasPermissionAt(
    context.executor,
    toBin(context.userId),
    DISTRIBUTION_DASHBOARD_READ,
    context.at,
  );
  if (!allowed) throw new BlockUnavailable('FORBIDDEN', 'DISTRIBUTION_FORBIDDEN');
  const scope = await resolveDashboardScope(context.executor, {
    userId: context.userId,
    at: context.at,
  });
  // Sans point de vente dans la portée de `analytics.dashboard.distribution` : rien à lire (jamais « tout »).
  if (scope.status !== 'OK' || scope.kept.length === 0)
    return block('DISTRIBUTION', 'Distribution', []);
  const response = await buildDistributionDashboard(context.executor, {
    targets: scope.targets,
    period: {
      code: context.period.code,
      fromDay: context.period.fromDay,
      toDay: context.period.toDay,
    },
    now: context.at,
    visibility: scope.visibility,
    allSites: scope.allSites,
  });
  const can = context.canReadValuation;
  const totals = response.totals;
  return block('DISTRIBUTION', 'Distribution', [
    kpi({
      code: 'KPI-DIS-03',
      label: 'Vendu net des points de vente',
      unit: 'xaf',
      value: totals.soldNetXaf,
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-DIS-06',
      label: 'Encaissé des points de vente',
      unit: 'xaf',
      value: totals.cashedXaf,
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-DIS-05',
      label: 'Valeur du restant',
      unit: 'xaf',
      value: totals.remainingValueXaf,
      protectedValue: true,
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-FIN-CS-PENDING',
      label: 'Sessions de caisse à valider',
      unit: 'count',
      value: totals.cashSessionsToValidate,
      canReadValuation: can,
      alertType: 'CASH_VARIANCE',
    }),
  ]);
}

export async function alertsBlock(context: DashboardContext): Promise<DashboardBlock> {
  const summary = await alertSummary(context.executor, { userId: context.userId, at: context.at });
  const can = context.canReadValuation;
  return block('ALERTES', 'Alertes', [
    {
      ...kpi({
        code: 'KPI-OPS-ALERTS-CRITICAL',
        label: 'Alertes critiques ouvertes',
        unit: 'count',
        value: summary.bySeverity.CRITICAL,
        canReadValuation: can,
      }),
      alertSeverity: 'CRITICAL' as const,
    },
    {
      ...kpi({
        code: 'KPI-OPS-ALERTS-WARNING',
        label: 'Alertes d’avertissement ouvertes',
        unit: 'count',
        value: summary.bySeverity.WARNING,
        canReadValuation: can,
      }),
      alertSeverity: 'WARNING' as const,
    },
    {
      ...kpi({
        code: 'KPI-OPS-ALERTS-INFO',
        label: 'Alertes d’information ouvertes',
        unit: 'count',
        value: summary.bySeverity.INFO,
        canReadValuation: can,
      }),
      alertSeverity: 'INFO' as const,
    },
  ]);
}

export async function coordinationBlock(context: DashboardContext): Promise<DashboardBlock> {
  const [pending, service] = await Promise.all([
    countPendingApprovalsFor(context.executor, {
      userId: context.userId,
      at: context.at,
      cap: context.pendingApprovalsCap,
    }),
    // Une étendue nulle ne coûte que le taux de service, pas le compteur de validations (TB-6).
    context.scope !== null && isAllScope(context.scope)
      ? supplierServiceRate(context.executor, context.scope, dayWindow(context.period))
      : null,
  ]);
  const can = context.canReadValuation;
  return block('COORDINATION', 'Validations et approvisionnement', [
    kpi({
      code: 'KPI-OPS-APPROVALS',
      label: pending.capped
        ? `Validations en attente (au moins ${pending.count}, plafond atteint)`
        : 'Validations en attente',
      unit: 'count',
      value: pending.count,
      canReadValuation: can,
    }),
    kpi({
      code: 'KPI-APP-01',
      label: 'Taux de service fournisseur',
      unit: 'pct',
      value: service?.rate === null || service === null ? null : round1(service.rate * 100),
      canReadValuation: can,
      explore:
        service === null ? null : exploreLink(context, 'f_purchases', ['ordered', 'accepted']),
    }),
  ]);
}

export const BLOCK_BUILDERS: Readonly<
  Record<
    BlockCode,
    {
      readonly title: string;
      readonly build: (context: DashboardContext) => Promise<DashboardBlock>;
    }
  >
> = {
  PRODUCTION: { title: 'Production', build: productionBlock },
  STOCK: { title: 'Stock', build: stockBlock },
  DISTRIBUTION: { title: 'Distribution', build: distributionBlock },
  VENTES: { title: 'Ventes', build: salesBlock },
  FINANCES: { title: 'Finances', build: financeBlock },
  EQUIPES: { title: 'Équipes commerciales', build: teamsBlock },
  ALERTES: { title: 'Alertes', build: alertsBlock },
  COMMERCIAL: { title: 'Portefeuille clients', build: commercialBlock },
  COORDINATION: { title: 'Validations et approvisionnement', build: coordinationBlock },
};

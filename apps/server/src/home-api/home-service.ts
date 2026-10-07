/**
 * Accueil par rôle (ECR-ADM-03, UX-01 ; ADR-030) : compose, pour un utilisateur et un instant, les
 * actions du jour, les indicateurs, les signaux (urgences, points d'attention) et l'activité récente
 * de **chacun de ses rôles actifs**, chacun lu dans son périmètre. Tout est **calculé** à la demande
 * à partir des opérations (BR-ANA-001, BR-ANA-009) par les API publiques de lecture des modules
 * propriétaires ; aucune valeur n'est stockée ni saisie.
 *
 * Périmètre d'un rôle (DÉDUIT de la matrice acteurs × domaines, D04-acteurs §4) :
 * Direction, Administrateur, Finance, Achats, Production : toute l'entreprise ; Resp. commercial :
 * son équipe et lui-même ; commerciaux : eux-mêmes ; vendeur de PDV, Resp. ferme, magasinier : les
 * sites de leur affectation (un site ou les sites d'une zone). Les montants de valeur (stock) exigent
 * `inventory.valuation.read` (RC-05, BR-ANA-004). Une section vide de données reste affichée : un
 * indicateur à zéro est une information.
 */
import type { Kysely, Transaction } from 'kysely';
import { businessDayOf, businessDayStartUtc, type Clock } from '@gic/domain';
import type {
  HomeAction,
  HomeActivity,
  HomeKpi,
  HomeResponse,
  HomeSection,
  HomeSignal,
} from '@gic/contracts';
import type { DB } from '../platform/kysely/database.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import { openConflictSummary } from '../platform/sync/conflicts.js';
import { ALL_SCOPE, type ReadScope } from '../platform/read-scope.js';
import {
  activeRoleAssignmentsAt,
  deviceUserCounts,
  hasPermissionAt,
  userFullName,
  userFullNames,
} from '../modules/identity/application/public/index.js';
import {
  listSiteIdsInZones,
  listManagedTeamMembersAt,
} from '../modules/organization/application/public/index.js';
import { findWorkSessionAt } from '../modules/fieldwork/application/public/index.js';
import { pendingApprovalsFor } from '../modules/approvals/application/public/index.js';
import { cashPosition } from '../modules/finance/application/public/index.js';
import { recentLosses, stockHealth } from '../modules/inventory/application/public/index.js';
import { productionOverview } from '../modules/production/application/public/index.js';
import { procurementOverview } from '../modules/procurement/application/public/index.js';
import {
  commercialEffort,
  getCustomer,
  portfolioHealth,
} from '../modules/crm/application/public/index.js';
import {
  cashedSummary,
  receivablesSummary,
  recentSales,
  salesDailySeries,
  salesPeriodSummary,
  suspectPaymentsCount,
} from '../modules/sales/application/public/index.js';
import { ROLE_CATALOG, ROLE_ORDER, type RoleDefinition } from './role-catalog.js';
import {
  formatXaf,
  kpi,
  lastDays,
  plural,
  shiftDay,
  signal,
  sortSignals,
  variation,
  weekStart,
} from './home-format.js';

type Executor = Kysely<DB> | Transaction<DB>;

const VALUATION_READ = 'inventory.valuation.read';
/** Un client sans vente depuis ce nombre de jours est inactif (AV-013). */
const INACTIVE_DAYS = 30;
const RECENT_SALES = 6;

interface Context {
  readonly executor: Executor;
  readonly userId: string;
  readonly at: Date;
  readonly day: string;
  readonly roles: readonly string[];
  readonly canReadValuation: boolean;
}

interface Built {
  readonly kpis: HomeKpi[];
  readonly signals: HomeSignal[];
  readonly activity: HomeActivity[];
}

const empty = (): Built => ({ kpis: [], signals: [], activity: [] });

/** Bornes UTC `[début, fin[` d'un jour métier. */
function dayBounds(day: string): { readonly fromUtc: Date; readonly toUtc: Date } {
  return { fromUtc: businessDayStartUtc(day), toUtc: businessDayStartUtc(shiftDay(day, 1)) };
}

// --- Périmètre d'un rôle ---------------------------------------------------------------------------------

interface ResolvedScope {
  readonly scope: ReadScope;
  readonly label: string;
  /** Personnes de l'équipe (Resp. commercial) ; sinon l'utilisateur seul ou aucune. */
  readonly people: readonly string[];
}

async function resolveScope(ctx: Context, role: RoleDefinition): Promise<ResolvedScope> {
  switch (role.scopeKind) {
    case 'ALL':
      return { scope: ALL_SCOPE, label: "Toute l'entreprise", people: [] };
    case 'OWN':
      return { scope: { userIds: [ctx.userId] }, label: 'Votre activité', people: [ctx.userId] };
    case 'TEAM': {
      const members = await listManagedTeamMembersAt(ctx.executor, ctx.userId, ctx.at);
      const people = [...new Set([ctx.userId, ...members])];
      return {
        scope: { userIds: people },
        label:
          members.length > 0 ? `Votre équipe (${members.length + 1} personnes)` : 'Votre activité',
        people,
      };
    }
    case 'SITES': {
      const assignments = (await activeRoleAssignmentsAt(ctx.executor, ctx.userId, ctx.at)).filter(
        (assignment) => assignment.roleCode === role.code,
      );
      if (assignments.some((assignment) => assignment.scopeType === 'GLOBAL')) {
        return { scope: ALL_SCOPE, label: "Toute l'entreprise", people: [] };
      }
      const sites = new Set<string>();
      const zones: string[] = [];
      for (const assignment of assignments) {
        if (assignment.scopeSiteId) sites.add(assignment.scopeSiteId);
        if (assignment.scopeZoneId) zones.push(assignment.scopeZoneId);
      }
      for (const siteId of await listSiteIdsInZones(ctx.executor, zones)) sites.add(siteId);
      const siteIds = [...sites];
      return {
        scope: { siteIds },
        label: siteIds.length === 1 ? 'Votre site' : `Vos sites (${siteIds.length})`,
        people: [],
      };
    }
  }
}

// --- Blocs d'indicateurs réutilisés par plusieurs rôles ----------------------------------------------------

async function salesBlock(
  ctx: Context,
  scope: ReadScope,
  options: { readonly cashed: boolean; readonly period: 'DAY' | 'WEEK' } = {
    cashed: true,
    period: 'DAY',
  },
): Promise<Built> {
  const built = empty();
  const yesterday = shiftDay(ctx.day, -1);
  const [today, before, week, series, cashed] = await Promise.all([
    salesPeriodSummary(ctx.executor, scope, { fromDay: ctx.day, toDay: ctx.day }),
    salesPeriodSummary(ctx.executor, scope, { fromDay: yesterday, toDay: yesterday }),
    salesPeriodSummary(ctx.executor, scope, { fromDay: weekStart(ctx.day), toDay: ctx.day }),
    salesDailySeries(ctx.executor, scope, { fromDay: shiftDay(ctx.day, -6), toDay: ctx.day }),
    options.cashed
      ? cashedSummary(ctx.executor, scope, { fromDay: ctx.day, toDay: ctx.day })
      : Promise.resolve(null),
  ]);
  const byDay = new Map(series.map((entry) => [entry.day, entry.netXaf]));
  built.kpis.push(
    kpi({
      code: 'KPI-COM-08',
      label: "Chiffre d'affaires du jour",
      value: today.netXaf,
      unit: 'XAF',
      detail: plural(today.salesCount, 'vente', 'ventes'),
      delta: variation(today.netXaf, before.netXaf, 'vs hier'),
      series: lastDays(ctx.day, 7).map((day) => ({ day, value: byDay.get(day) ?? 0 })),
      tone: today.netXaf > 0 ? 'good' : 'neutral',
    }),
  );
  if (options.period === 'WEEK' || week.salesCount > today.salesCount) {
    built.kpis.push(
      kpi({
        code: 'KPI-COM-08-S',
        label: 'Chiffre d’affaires de la semaine',
        value: week.netXaf,
        unit: 'XAF',
        detail: plural(week.salesCount, 'vente', 'ventes'),
      }),
    );
  }
  if (today.salesCount > 0) {
    built.kpis.push(
      kpi({
        code: 'KPI-COM-10',
        label: 'Panier moyen',
        value: Math.round(today.netXaf / today.salesCount),
        unit: 'XAF',
        detail: 'sur les ventes du jour',
      }),
    );
  }
  if (cashed) {
    built.kpis.push(
      kpi({
        code: 'KPI-FIN-01',
        label: 'Encaissé du jour',
        value: cashed.amountXaf,
        unit: 'XAF',
        detail: plural(cashed.paymentsCount, 'encaissement', 'encaissements'),
        tone: cashed.amountXaf > 0 ? 'good' : 'neutral',
      }),
    );
  }
  if (today.flaggedCount > 0) {
    built.signals.push(
      signal({
        code: 'SALES_FLAGGED',
        severity: 'WARNING',
        title: `${plural(today.flaggedCount, 'vente du jour porte', 'ventes du jour portent')} une anomalie`,
        detail: 'Prix différent du catalogue, stock négatif, vente anonyme non payée…',
        count: today.flaggedCount,
      }),
    );
  }
  return built;
}

async function receivablesBlock(ctx: Context, scope: ReadScope): Promise<Built> {
  const built = empty();
  const receivables = await receivablesSummary(ctx.executor, scope, ctx.day);
  built.kpis.push(
    kpi({
      code: 'KPI-FIN-02',
      label: 'Créances clients',
      value: receivables.outstandingXaf,
      unit: 'XAF',
      detail:
        receivables.overdueXaf > 0
          ? `dont ${formatXaf(receivables.overdueXaf)} en retard`
          : plural(receivables.openCount, 'vente à solder', 'ventes à solder'),
      tone: receivables.overdueXaf > 0 ? 'warn' : 'neutral',
    }),
  );
  if (receivables.overdueCount > 0) {
    built.signals.push(
      signal({
        code: 'OVERDUE_RECEIVABLE',
        severity: 'WARNING',
        title: `${plural(receivables.overdueCount, 'créance en retard', 'créances en retard')} : ${formatXaf(receivables.overdueXaf)}`,
        detail: 'Échéance dépassée : relancer les clients concernés.',
        count: receivables.overdueCount,
      }),
    );
  }
  return built;
}

async function stockBlock(
  ctx: Context,
  scope: ReadScope,
  options: { readonly value: boolean },
): Promise<Built> {
  const built = empty();
  const health = await stockHealth(ctx.executor, scope);
  if (health.thresholdsCount > 0) {
    built.kpis.push(
      kpi({
        code: 'KPI-STK-06',
        label: 'Produits en rupture',
        value: health.stockOut,
        unit: 'COUNT',
        detail: `${health.stockLow} sous le seuil · ${health.thresholdsCount} suivis`,
        tone: health.stockOut > 0 ? 'bad' : health.stockLow > 0 ? 'warn' : 'good',
      }),
    );
  }
  if (options.value && ctx.canReadValuation) {
    built.kpis.push(
      kpi({
        code: 'KPI-STK-02',
        label: 'Valeur du stock',
        value: health.valueXaf,
        unit: 'XAF',
        detail: 'au coût moyen pondéré',
      }),
    );
  }
  if (health.stockOut > 0) {
    built.signals.push(
      signal({
        code: 'STOCK_OUT',
        severity: 'CRITICAL',
        title: `${plural(health.stockOut, 'produit en rupture', 'produits en rupture')}`,
        detail: 'Disponible nul ou négatif alors qu’un seuil existe : réapprovisionner.',
        count: health.stockOut,
      }),
    );
  } else if (health.stockLow > 0) {
    built.signals.push(
      signal({
        code: 'STOCK_LOW',
        severity: 'WARNING',
        title: `${plural(health.stockLow, 'produit sous son seuil', 'produits sous leur seuil')}`,
        detail: 'Prévoir un réapprovisionnement ou un transfert.',
        count: health.stockLow,
      }),
    );
  }
  if (health.negativeBalances > 0) {
    built.signals.push(
      signal({
        code: 'STOCK_NEGATIVE',
        severity: 'CRITICAL',
        title: `${plural(health.negativeBalances, 'solde de stock négatif', 'soldes de stock négatifs')}`,
        detail:
          'Vente ou sortie hors ligne au-delà du stock : régulariser par inventaire ou transfert.',
        count: health.negativeBalances,
      }),
    );
  }
  return built;
}

async function productionBlock(ctx: Context, scope: ReadScope): Promise<Built> {
  const built = empty();
  const since = new Date(ctx.at.getTime() - 7 * 86_400_000);
  const [overview, losses] = await Promise.all([
    productionOverview(ctx.executor, scope),
    recentLosses(ctx.executor, scope, since),
  ]);
  built.kpis.push(
    kpi({
      code: 'KPI-PRD-01',
      label: 'Animaux en élevage',
      value: overview.rearingHeads,
      unit: 'HEADS',
      detail: `${plural(overview.activeLots, 'lot en cours', 'lots en cours')}${
        overview.sellingLots > 0 ? ` · ${overview.sellingLots} en vente` : ''
      }`,
    }),
    kpi({
      code: 'KPI-PRD-02',
      label: 'Mortalité sur 7 jours',
      value: losses.animalHeads,
      unit: 'HEADS',
      detail: 'têtes perdues, validations en attente comprises',
      tone: losses.animalHeads > 0 ? 'warn' : 'good',
    }),
  );
  return built;
}

async function coordinationBlock(
  ctx: Context,
  scope: ReadScope,
  role: RoleDefinition,
): Promise<Built> {
  const built = empty();
  const approvals = await pendingApprovalsFor(ctx.executor, ctx.userId, ctx.at);
  if (approvals.length > 0) {
    const oldest = approvals[0]!;
    built.signals.push(
      signal({
        code: 'APPROVALS_PENDING',
        severity: 'WARNING',
        title: `${plural(approvals.length, 'validation vous attend', 'validations vous attendent')}`,
        detail: `La plus ancienne : ${oldest.subjectSummary}`,
        count: approvals.length,
        action: { label: 'Ouvrir la file de validation', route: null },
      }),
    );
  }
  const conflicts = await openConflictSummary(
    ctx.executor,
    role.conflictRoles === 'ALL' ? {} : { ownerRoles: role.conflictRoles },
  );
  if (conflicts.total > 0) {
    const critical = (conflicts.byType['STOCK_NEGATIVE'] ?? 0) > 0;
    const types = Object.entries(conflicts.byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, count]) => `${type.replaceAll('_', ' ').toLowerCase()} ×${count}`)
      .join(', ');
    built.signals.push(
      signal({
        code: 'SYNC_CONFLICTS',
        severity: critical ? 'CRITICAL' : 'WARNING',
        title: `${plural(conflicts.total, 'anomalie à traiter', 'anomalies à traiter')}`,
        detail: types,
        count: conflicts.total,
      }),
    );
  }
  void scope;
  return built;
}

async function recentSalesActivity(ctx: Context, scope: ReadScope): Promise<HomeActivity> {
  const sales = await recentSales(ctx.executor, scope, RECENT_SALES);
  const names = await userFullNames(
    ctx.executor,
    sales.map((sale) => sale.sellerUserId),
  );
  const customers = new Map<string, string>();
  for (const customerId of new Set(
    sales.flatMap((sale) => (sale.customerId ? [sale.customerId] : [])),
  )) {
    const customer = await getCustomer(ctx.executor, customerId);
    if (customer) customers.set(customerId, customer.displayName);
  }
  return {
    code: 'RECENT_SALES',
    title: 'Dernières ventes',
    items: sales.map((sale) => ({
      id: sale.id,
      at: sale.occurredAt.toISOString(),
      label: sale.customerId ? (customers.get(sale.customerId) ?? 'Client') : 'Vente comptoir',
      detail: `${sale.docNumber} · ${names.get(sale.sellerUserId) ?? 'vendeur'}${
        sale.paymentStatus === 'PAID'
          ? ''
          : sale.paymentStatus === 'UNPAID'
            ? ' · à crédit'
            : ' · acompte'
      }`,
      amountXaf: sale.totalXaf,
      tone: sale.flags.length > 0 ? 'warn' : sale.paymentStatus === 'PAID' ? 'good' : 'neutral',
    })),
  };
}

async function commercialEffortBlock(
  ctx: Context,
  people: readonly string[],
  options: { readonly field: boolean },
): Promise<Built> {
  const built = empty();
  const today = dayBounds(ctx.day);
  const weekFrom = businessDayStartUtc(shiftDay(ctx.day, -6));
  let visits = 0;
  let newProspects = 0;
  let newCustomers = 0;
  for (const userId of people) {
    const [d, w] = await Promise.all([
      commercialEffort(ctx.executor, { userId, ...today }),
      commercialEffort(ctx.executor, { userId, fromUtc: weekFrom, toUtc: today.toUtc }),
    ]);
    visits += d.visits;
    newProspects += w.prospectsCreated;
    newCustomers += w.newCustomers;
  }
  if (options.field) {
    built.kpis.push(
      kpi({ code: 'KPI-COM-03', label: 'Visites du jour', value: visits, unit: 'COUNT' }),
    );
  }
  built.kpis.push(
    kpi({
      code: 'KPI-COM-01',
      label: 'Prospects créés (7 jours)',
      value: newProspects,
      unit: 'COUNT',
      detail: `${plural(newCustomers, 'nouveau client', 'nouveaux clients')} sur la période`,
    }),
  );
  return built;
}

async function portfolioBlock(ctx: Context, owners: readonly string[] | undefined): Promise<Built> {
  const built = empty();
  const health = await portfolioHealth(ctx.executor, {
    ...(owners !== undefined ? { ownerUserIds: owners } : {}),
    at: ctx.at,
    inactiveDays: INACTIVE_DAYS,
  });
  built.kpis.push(
    kpi({
      code: 'KPI-COM-14',
      label: 'Clients inactifs',
      value: health.inactiveCustomers,
      unit: 'COUNT',
      detail: `sur ${plural(health.customers, 'client', 'clients')} · inactif après ${INACTIVE_DAYS} jours`,
      tone: health.inactiveCustomers > 0 ? 'warn' : 'good',
    }),
  );
  if (health.inactiveCustomers > 0) {
    built.signals.push(
      signal({
        code: 'INACTIVE_CUSTOMERS',
        severity: 'INFO',
        title: `${plural(health.inactiveCustomers, 'client sans achat', 'clients sans achat')} depuis ${INACTIVE_DAYS} jours`,
        detail: 'Une visite ou un appel peut relancer la vente.',
        count: health.inactiveCustomers,
      }),
    );
  }
  return built;
}

function merge(...parts: readonly Built[]): Built {
  return {
    kpis: parts.flatMap((part) => part.kpis),
    signals: parts.flatMap((part) => part.signals),
    activity: parts.flatMap((part) => part.activity),
  };
}

// --- Contenu de chaque rôle ----------------------------------------------------------------------------

async function buildRole(
  ctx: Context,
  role: RoleDefinition,
  resolved: ResolvedScope,
): Promise<Built> {
  const { scope } = resolved;
  const coordination = coordinationBlock(ctx, scope, role);
  switch (role.code) {
    case 'DIRECTION': {
      const [sales, receivables, stock, production, suspects, base] = await Promise.all([
        salesBlock(ctx, scope),
        receivablesBlock(ctx, scope),
        stockBlock(ctx, scope, { value: true }),
        productionBlock(ctx, scope),
        suspectPaymentsCount(ctx.executor, scope),
        coordination,
      ]);
      const extra = empty();
      if (suspects > 0) {
        extra.signals.push(
          signal({
            code: 'PAYMENT_DUPLICATES',
            severity: 'WARNING',
            title: plural(
              suspects,
              'encaissement en double à trancher',
              'encaissements en double à trancher',
            ),
            count: suspects,
          }),
        );
      }
      return merge(
        { ...sales, activity: [await recentSalesActivity(ctx, scope)] },
        receivables,
        stock,
        production,
        extra,
        base,
      );
    }
    case 'FINANCE': {
      const [sales, receivables, cash, suspects, base] = await Promise.all([
        salesBlock(ctx, scope, { cashed: true, period: 'DAY' }),
        receivablesBlock(ctx, scope),
        cashPosition(ctx.executor),
        suspectPaymentsCount(ctx.executor, scope),
        coordination,
      ]);
      const extra = empty();
      extra.kpis.push(
        kpi({
          code: 'KPI-FIN-06',
          label: 'Trésorerie',
          value: cash.totalXaf,
          unit: 'XAF',
          detail: plural(cash.activeAccounts, 'compte actif', 'comptes actifs'),
          tone: cash.negativeAccounts > 0 ? 'bad' : 'neutral',
        }),
      );
      if (cash.negativeAccounts > 0) {
        extra.signals.push(
          signal({
            code: 'CASH_NEGATIVE',
            severity: 'CRITICAL',
            title: plural(
              cash.negativeAccounts,
              'compte de trésorerie négatif',
              'comptes de trésorerie négatifs',
            ),
            count: cash.negativeAccounts,
          }),
        );
      }
      if (suspects > 0) {
        extra.kpis.push(
          kpi({
            code: 'KPI-FIN-DUP',
            label: 'Doublons de paiement',
            value: suspects,
            unit: 'COUNT',
            detail: 'à décider par la Finance',
            tone: 'warn',
          }),
        );
        extra.signals.push(
          signal({
            code: 'PAYMENT_DUPLICATES',
            severity: 'WARNING',
            title: plural(
              suspects,
              'encaissement en double à trancher',
              'encaissements en double à trancher',
            ),
            detail: 'Mis de côté sans effet de trésorerie jusqu’à votre décision.',
            count: suspects,
          }),
        );
      }
      return merge(
        { ...sales, activity: [await recentSalesActivity(ctx, scope)] },
        receivables,
        extra,
        base,
      );
    }
    case 'RESP_COMMERCIAL': {
      const [sales, receivables, effort, portfolio, base] = await Promise.all([
        salesBlock(ctx, scope, { cashed: false, period: 'WEEK' }),
        receivablesBlock(ctx, scope),
        commercialEffortBlock(ctx, resolved.people, { field: true }),
        portfolioBlock(ctx, resolved.people),
        coordination,
      ]);
      return merge(
        { ...sales, activity: [await recentSalesActivity(ctx, scope)] },
        receivables,
        effort,
        portfolio,
        base,
      );
    }
    case 'COMMERCIAL_TERRAIN':
    case 'COMMERCIAL_SEDENTAIRE': {
      const field = role.code === 'COMMERCIAL_TERRAIN';
      const [sales, receivables, effort, portfolio, session, base] = await Promise.all([
        salesBlock(ctx, scope),
        receivablesBlock(ctx, scope),
        commercialEffortBlock(ctx, [ctx.userId], { field }),
        portfolioBlock(ctx, [ctx.userId]),
        field ? findWorkSessionAt(ctx.executor, ctx.userId, ctx.at) : Promise.resolve(undefined),
        coordination,
      ]);
      const extra = empty();
      if (field && !session) {
        extra.signals.push(
          signal({
            code: 'SERVICE_NOT_STARTED',
            severity: 'WARNING',
            title: 'Vous n’avez pas pris service',
            detail:
              'Prenez service pour que vos visites et vos ventes soient rattachées à votre journée.',
            action: { label: 'PRENDRE SERVICE', route: null },
          }),
        );
      }
      return merge(
        { ...sales, activity: [await recentSalesActivity(ctx, scope)] },
        receivables,
        effort,
        portfolio,
        extra,
        base,
      );
    }
    case 'VENDEUR_PDV': {
      const [sales, stock, base] = await Promise.all([
        salesBlock(ctx, scope),
        stockBlock(ctx, scope, { value: false }),
        coordination,
      ]);
      return merge({ ...sales, activity: [await recentSalesActivity(ctx, scope)] }, stock, base);
    }
    case 'MAGASINIER': {
      const [stock, base] = await Promise.all([
        stockBlock(ctx, scope, { value: true }),
        coordination,
      ]);
      return merge(stock, base);
    }
    case 'RESP_FERME':
    case 'RESP_PRODUCTION': {
      const [production, stock, base] = await Promise.all([
        productionBlock(ctx, scope),
        stockBlock(ctx, scope, { value: false }),
        coordination,
      ]);
      return merge(production, stock, base);
    }
    case 'RESP_ACHATS': {
      const [overview, base] = await Promise.all([procurementOverview(ctx.executor), coordination]);
      const requests = overview.requestsByStatus;
      const orders = overview.ordersByStatus;
      const receipts = overview.receiptsByStatus;
      const toReview = (receipts['QUARANTINED'] ?? 0) + (receipts['POSTED_PENDING_REVIEW'] ?? 0);
      const inFlight = (orders['SENT'] ?? 0) + (orders['PARTIALLY_RECEIVED'] ?? 0);
      const built = empty();
      built.kpis.push(
        kpi({
          code: 'KPI-APP-DA',
          label: "Demandes d'achat à instruire",
          value: requests['SUBMITTED'] ?? 0,
          unit: 'COUNT',
          tone: (requests['SUBMITTED'] ?? 0) > 0 ? 'warn' : 'neutral',
        }),
        kpi({
          code: 'KPI-APP-BC',
          label: 'Bons de commande en cours',
          value: inFlight,
          unit: 'COUNT',
          detail: `${orders['PENDING_APPROVAL'] ?? 0} en attente d’approbation`,
        }),
        kpi({
          code: 'KPI-APP-REC',
          label: 'Réceptions à examiner',
          value: toReview,
          unit: 'COUNT',
          detail: 'quarantaine ou sans bon de commande',
          tone: toReview > 0 ? 'warn' : 'good',
        }),
      );
      if (toReview > 0) {
        built.signals.push(
          signal({
            code: 'RECEIPTS_TO_REVIEW',
            severity: 'WARNING',
            title: plural(toReview, 'réception à examiner', 'réceptions à examiner'),
            detail: 'Doublon de bon de livraison, dépassement ou réception sans bon de commande.',
            count: toReview,
          }),
        );
      }
      return merge(built, base);
    }
    case 'ADMIN': {
      const [counts, base] = await Promise.all([deviceUserCounts(ctx.executor), coordination]);
      const built = empty();
      built.kpis.push(
        kpi({
          code: 'KPI-OPS-USR',
          label: 'Utilisateurs actifs',
          value: counts.activeUsers,
          unit: 'COUNT',
        }),
        kpi({
          code: 'KPI-OPS-DEV',
          label: 'Appareils actifs',
          value: counts.activeDevices,
          unit: 'COUNT',
          detail: `${counts.pendingDevices} en attente · ${counts.blockedDevices} bloqués ou perdus`,
          tone: counts.pendingDevices > 0 ? 'warn' : 'neutral',
        }),
      );
      if (counts.pendingDevices > 0) {
        built.signals.push(
          signal({
            code: 'DEVICES_PENDING',
            severity: 'WARNING',
            title: plural(
              counts.pendingDevices,
              'appareil attend votre approbation',
              'appareils attendent votre approbation',
            ),
            detail: 'Un appareil non approuvé ne peut pas envoyer d’opérations.',
            count: counts.pendingDevices,
            action: { label: 'Voir les appareils', route: null },
          }),
        );
      }
      return merge(built, base);
    }
    default:
      return merge(await coordination);
  }
}

function toSection(role: RoleDefinition, resolved: ResolvedScope, built: Built): HomeSection {
  const actions: HomeAction[] = role.actions.map((action) => ({ ...action }));
  return {
    role: role.code,
    roleLabel: role.label,
    scopeLabel: resolved.label,
    actions,
    kpis: built.kpis,
    activity: built.activity,
  };
}

export interface BuildHomeInput {
  readonly executor: Executor;
  readonly userId: string;
  readonly clock: Clock;
}

export async function buildHome(input: BuildHomeInput): Promise<HomeResponse> {
  const at = input.clock.now();
  const assignments = await activeRoleAssignmentsAt(input.executor, input.userId, at);
  const roleCodes = [...new Set(assignments.map((assignment) => assignment.roleCode))];
  const ctx: Context = {
    executor: input.executor,
    userId: input.userId,
    at,
    day: businessDayOf(at),
    roles: roleCodes,
    canReadValuation: await hasPermissionAt(
      input.executor,
      toBin(input.userId),
      VALUATION_READ,
      at,
    ),
  };

  const sections: HomeSection[] = [];
  const signals: HomeSignal[] = [];
  const known = ROLE_ORDER.filter((code) => roleCodes.includes(code));
  for (const code of known) {
    const role = ROLE_CATALOG[code]!;
    const resolved = await resolveScope(ctx, role);
    const built = await buildRole(ctx, role, resolved);
    sections.push(toSection(role, resolved, built));
    signals.push(...built.signals);
  }
  return {
    generatedAt: at.toISOString(),
    businessDay: ctx.day,
    user: {
      fullName: (await userFullName(input.executor, input.userId)) ?? 'Utilisateur',
      roles: known,
    },
    signals: [...sortSignals(signals)],
    sections,
  };
}

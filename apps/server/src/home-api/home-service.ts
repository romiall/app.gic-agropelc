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
 *
 * Appareils (MP-06, AV-247) : l'Admin voit tous les appareils en attente ; un responsable qui approuve les
 * appareils de sa portée reçoit le même signal, compté dans cette portée et sans ses propres appareils
 * (AV-258), quel que soit le rôle qui lui donne ce droit.
 *
 * Distribution (P5-20, AV-208) : avec `analytics.dashboard.distribution`, la Finance lit les sessions de
 * caisse des PDV, les remises en attente et les appareils en retard ; le magasinier, les produits à
 * réapprovisionner, les quotas à régulariser et les appareils des PDV de **ses** sites. Mêmes fonctions
 * que le tableau de distribution (BR-ANA-009). Les anomalies d'un rôle de sites ne portent que sur ses
 * sites.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  businessDayOf,
  businessDayStartUtc,
  cashSessionOpenLongerThan,
  varianceSeverity,
  type Clock,
} from '@gic/domain';
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
import {
  listConflicts,
  openConflictSummary,
  type OpenConflictSummary,
} from '../platform/sync/conflicts.js';
import { conflictResource } from '../sync/conflict-resource.js';
import { ALL_SCOPE, type ReadScope } from '../platform/read-scope.js';
import {
  activeRoleAssignmentsAt,
  deviceUserCounts,
  hasPermissionAt,
  pendingDeviceApprovalsFor,
  userFullName,
  userFullNames,
} from '../modules/identity/application/public/index.js';
import {
  listPointsOfSale,
  listSiteIdsInZones,
  listManagedTeamMembersAt,
} from '../modules/organization/application/public/index.js';
import { findWorkSessionAt } from '../modules/fieldwork/application/public/index.js';
import { pendingApprovalsFor } from '../modules/approvals/application/public/index.js';
import {
  cashPosition,
  cashSessionThresholdsAt,
  cashSessionsOverview,
  listCashAccounts,
  pendingCashTransfers,
} from '../modules/finance/application/public/index.js';
import {
  allocationPositions,
  recentLosses,
  stockHealth,
  stockThresholdsOf,
} from '../modules/inventory/application/public/index.js';
import { productionOverview } from '../modules/production/application/public/index.js';
import { procurementOverview } from '../modules/procurement/application/public/index.js';
import {
  commercialEffort,
  getCustomer,
  inactiveAfterDays,
  portfolioHealth,
} from '../modules/crm/application/public/index.js';
import {
  cashedSummary,
  receivablesSummary,
  recentSales,
  flaggedSalesOfDay,
  salesActivityByDay,
  sumSalesActivity,
  suspectPaymentsCount,
} from '../modules/sales/application/public/index.js';
import { deviceFreshness, devicesOfSites } from '../sync/device-freshness.js';
import {
  distributionTargetsOf,
  type DistributionTargets,
} from '../read-api/distribution-targets.js';
import { ROLE_CATALOG, ROLE_ORDER, type RoleDefinition } from './role-catalog.js';
import {
  conflictTypeLabel,
  flaggedSalesSignal,
  formatXaf,
  kpi,
  lastDays,
  pendingApprovalsTitle,
  plural,
  shiftDay,
  signal,
  sortSignals,
  variation,
  weekStart,
} from './home-format.js';

type Executor = Kysely<DB> | Transaction<DB>;

const VALUATION_READ = 'inventory.valuation.read';
const DISTRIBUTION_READ = 'analytics.dashboard.distribution';
const RECENT_SALES = 6;

interface Context {
  readonly executor: Executor;
  readonly userId: string;
  readonly at: Date;
  readonly day: string;
  readonly roles: readonly string[];
  readonly canReadValuation: boolean;
  /** `analytics.dashboard.distribution` (P5-20) : blocs de distribution de la Finance et du magasinier. */
  readonly canReadDistribution: boolean;
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
  // Une lecture de sept jours (la semaine commence au plus six jours avant) : valeur, variation, semaine
  // et courbe sont tirées des mêmes jours — définition par période d'activité partagée avec le tableau
  // de distribution (P5-23, AV-200, AV-209, ADR-041 : une annulation compte à sa date).
  const fromDay = shiftDay(ctx.day, -6);
  const [days, cashed] = await Promise.all([
    salesActivityByDay(ctx.executor, scope, { fromDay, toDay: ctx.day }),
    options.cashed
      ? cashedSummary(ctx.executor, scope, { fromDay: ctx.day, toDay: ctx.day })
      : Promise.resolve(null),
  ]);
  const today = sumSalesActivity(days, ctx.day, ctx.day);
  const before = sumSalesActivity(days, yesterday, yesterday);
  const week = sumSalesActivity(days, weekStart(ctx.day), ctx.day);
  const byDay = new Map(days.map((entry) => [entry.day, entry.netXaf]));
  built.kpis.push(
    kpi({
      code: 'KPI-COM-08',
      label: "Chiffre d'affaires du jour",
      value: today.netXaf,
      unit: 'XAF',
      detail: plural(today.salesCount, 'vente', 'ventes'),
      delta: variation(today.netXaf, before.netXaf, 'vs hier'),
      series: lastDays(ctx.day, 7).map((day) => ({ day, value: byDay.get(day) ?? 0 })),
      tone: today.netXaf > 0 ? 'good' : today.netXaf < 0 ? 'warn' : 'neutral',
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
  if (today.salesCount > 0 && today.netXaf > 0) {
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
        tone: cashed.amountXaf > 0 ? 'good' : cashed.amountXaf < 0 ? 'warn' : 'neutral',
      }),
    );
  }
  if (today.flaggedCount > 0) {
    // Ventilation par cause, gravité et lien (AV-255).
    const flagged = flaggedSalesSignal(await flaggedSalesOfDay(ctx.executor, scope, ctx.day));
    if (flagged) built.signals.push(flagged);
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
    // Toute l'entreprise : le transit fait partie du stock (AV-256) ; les pertes en attente restent à
    // part, annoncées. Un site : sa valeur seule (le transit n'a pas de site).
    const transit = health.transitValueXaf ?? 0;
    const pendingLoss = health.pendingLossValueXaf ?? 0;
    built.kpis.push(
      kpi({
        code: 'KPI-STK-02',
        label: 'Valeur du stock',
        value: health.valueXaf + transit,
        unit: 'XAF',
        detail: [
          'au coût moyen pondéré',
          ...(transit !== 0 ? [`dont ${formatXaf(transit)} en transit`] : []),
          ...(pendingLoss !== 0 ? [`pertes en attente à part : ${formatXaf(pendingLoss)}`] : []),
        ].join(' · '),
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

/**
 * Rôle d'équipe (ou de personne) : les anomalies ouvertes de ses rôles propriétaires dont le titulaire
 * est l'une de ses personnes — l'auteur de la commande, ou pour un conflit système le détenteur du
 * stock mobile en cause (`conflictResource`) : la règle de la portée `TEAM` de `GET /sync/conflicts`.
 */
async function peopleConflictSummary(
  ctx: Context,
  ownerRoles: readonly string[],
  people: readonly string[],
): Promise<OpenConflictSummary> {
  if (ownerRoles.length === 0 || people.length === 0) return { total: 0, byType: {} };
  const members = new Set(people);
  const byType: Record<string, number> = {};
  let total = 0;
  let beforeId: string | undefined;
  for (;;) {
    const page = await listConflicts(ctx.executor, {
      status: 'OPEN',
      ownerRoles,
      // Pré-filtre sûr : conflits produits par ces personnes, ou conflits système (évalués ensuite).
      confinement: { siteIds: [], authorUserIds: people },
      limit: 200,
      ...(beforeId !== undefined ? { beforeId } : {}),
    });
    for (const conflict of page.items) {
      const { ownerUserId } = await conflictResource(ctx.executor, conflict);
      if (ownerUserId === undefined || !members.has(ownerUserId)) continue;
      byType[conflict.conflictType] = (byType[conflict.conflictType] ?? 0) + 1;
      total += 1;
    }
    if (page.nextCursor === null) break;
    beforeId = page.nextCursor;
  }
  return { total, byType };
}

async function coordinationBlock(
  ctx: Context,
  scope: ReadScope,
  role: RoleDefinition,
): Promise<Built> {
  const built = empty();
  const approvals = await pendingApprovalsFor(ctx.executor, ctx.userId, ctx.at);
  if (approvals.total > 0) {
    const oldest = approvals.items[0]!;
    // MP-11 : décompte jusqu'au plafond, « plus de N » au-delà.
    built.signals.push(
      signal({
        code: 'APPROVALS_PENDING',
        severity: 'WARNING',
        title: pendingApprovalsTitle(approvals.total, approvals.truncated),
        detail: `La plus ancienne : ${oldest.subjectSummary}`,
        count: approvals.total,
        action: { label: 'Ouvrir la file de validation', route: null },
      }),
    );
  }
  const conflicts =
    role.conflictRoles !== 'ALL' && scope.userIds !== undefined
      ? await peopleConflictSummary(ctx, role.conflictRoles, scope.userIds)
      : await openConflictSummary(ctx.executor, {
          ...(role.conflictRoles === 'ALL' ? {} : { ownerRoles: role.conflictRoles }),
          // Rôle de sites : les anomalies de ses seuls sites (P5-20).
          ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
        });
  if (conflicts.total > 0) {
    const critical = (conflicts.byType['STOCK_NEGATIVE'] ?? 0) > 0;
    const types = Object.entries(conflicts.byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, count]) => `${conflictTypeLabel(type)} ×${count}`)
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
  // Un client sans vente depuis ce nombre de jours est inactif : réglage `crm.inactive_after_days` (AV-013, TB-5).
  const inactiveDays = await inactiveAfterDays(ctx.executor, ctx.at);
  const health = await portfolioHealth(ctx.executor, {
    ...(owners !== undefined ? { ownerUserIds: owners } : {}),
    at: ctx.at,
    inactiveDays,
  });
  built.kpis.push(
    kpi({
      code: 'KPI-COM-14',
      label: 'Clients inactifs',
      value: health.inactiveCustomers,
      unit: 'COUNT',
      detail: `sur ${plural(health.customers, 'client', 'clients')} · inactif après ${inactiveDays} jours`,
      tone: health.inactiveCustomers > 0 ? 'warn' : 'good',
    }),
  );
  if (health.inactiveCustomers > 0) {
    built.signals.push(
      signal({
        code: 'INACTIVE_CUSTOMERS',
        severity: 'INFO',
        title: `${plural(health.inactiveCustomers, 'client sans achat', 'clients sans achat')} depuis ${inactiveDays} jours`,
        detail: 'Une visite ou un appel peut relancer la vente.',
        count: health.inactiveCustomers,
      }),
    );
  }
  return built;
}

// --- Distribution (P5-20, AV-208) : les fonctions du tableau de distribution (BR-ANA-009) ---------------

/** PDV configurés du périmètre et leurs cibles ; un périmètre vide n'en a aucun (ADR-030 §5). */
async function distributionTargetsFor(
  ctx: Context,
  scope: ReadScope,
): Promise<DistributionTargets> {
  const points = await listPointsOfSale(
    ctx.executor,
    scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {},
  );
  return distributionTargetsOf(ctx.executor, points);
}

/**
 * Appareils des PDV **ouverts** sans contact au-delà de `analytics.freshness_warning_hours` (BR-ANA-005,
 * AV-202, AV-208) : la tablette restée désignée d'un site fermé n'est pas une vente en attente.
 */
async function devicesBlock(ctx: Context, targets: DistributionTargets): Promise<Built> {
  const built = empty();
  const siteIds = targets.pointsOfSale
    .filter((pos) => pos.siteStatus === 'ACTIVE')
    .map((pos) => pos.siteId);
  const bySite = await devicesOfSites(ctx.executor, siteIds);
  const deviceIds = [...new Set([...bySite.values()].flat())];
  if (deviceIds.length === 0) return built;
  const report = await deviceFreshness(ctx.executor, { deviceIds, now: ctx.at });
  const inService = report.devices.filter((device) => device.status === 'ACTIVE').length;
  built.kpis.push(
    kpi({
      code: 'KPI-OPS-01',
      label: 'Appareils en retard',
      value: report.staleCount,
      unit: 'COUNT',
      detail: `sur ${plural(inService, 'appareil de PDV', 'appareils de PDV')} · seuil ${report.warningHours} h`,
      tone: report.staleCount > 0 ? 'warn' : 'good',
    }),
  );
  if (report.staleCount > 0) {
    // Distinct de `SYNC_STALE` (D13, 24 h, P9) : seuil d'affichage de BR-ANA-005 (AV-208).
    built.signals.push(
      signal({
        code: 'DEVICES_STALE',
        severity: 'WARNING',
        title: `${plural(report.staleCount, 'appareil sans contact', 'appareils sans contact')} depuis plus de ${report.warningHours} h`,
        detail:
          'Des ventes ou des encaissements peuvent attendre sur l’appareil : le faire synchroniser.',
        count: report.staleCount,
      }),
    );
  }
  return built;
}

/**
 * Finance : sessions de caisse des PDV (à valider, écarts du jour, ouvertes trop longtemps), remises de
 * fonds en attente sur tous les comptes, appareils des PDV. Pas de signal « sessions à valider » :
 * `APPROVALS_PENDING` porte déjà les demandes `CASH_VARIANCE` (AV-208).
 */
async function distributionFinanceBlock(ctx: Context): Promise<Built> {
  const built = empty();
  const targets = await distributionTargetsFor(ctx, ALL_SCOPE);
  const accounts = await listCashAccounts(ctx.executor);
  const [overview, transfers, thresholds, devices] = await Promise.all([
    cashSessionsOverview(ctx.executor, { accountIds: targets.cashAccountIds, day: ctx.day }),
    pendingCashTransfers(ctx.executor, {
      accountIds: accounts.map((account) => account.id),
      now: ctx.at,
    }),
    cashSessionThresholdsAt(ctx.executor, { siteIds: targets.siteIds, at: ctx.at }),
    devicesBlock(ctx, targets),
  ]);
  let varianceCount = 0;
  let shortXaf = 0;
  let overXaf = 0;
  let critical = 0;
  let openLong = 0;
  for (const account of overview.accounts) {
    const limits = account.siteId !== null ? thresholds.get(account.siteId) : undefined;
    // Toutes les sessions du jour (plusieurs par jour si `finance.cash_sessions_per_day_max` > 1).
    for (const session of account.sessionsOfDay) {
      const variance = session.currentVarianceXaf;
      if (variance === null || variance === 0) continue;
      varianceCount += 1;
      if (variance < 0) shortXaf -= variance;
      else overXaf += variance;
      if (
        limits !== undefined &&
        Math.abs(variance) > limits.varianceToleranceXaf &&
        varianceSeverity(variance, limits.varianceCriticalXaf) === 'CRITICAL'
      ) {
        critical += 1;
      }
    }
    if (
      account.openSession !== null &&
      limits !== undefined &&
      cashSessionOpenLongerThan(account.openSession.openedAt, ctx.at, limits.forceCloseHours)
    ) {
      openLong += 1;
    }
  }
  const inTransit = transfers.inTransit;
  built.kpis.push(
    kpi({
      code: 'KPI-FIN-CS-PENDING',
      label: 'Caisses à valider',
      value: overview.pendingValidationCount,
      unit: 'COUNT',
      detail:
        overview.pendingAdjustmentsCount > 0
          ? `+ ${plural(overview.pendingAdjustmentsCount, 'ajustement', 'ajustements')} à valider`
          : null,
      tone:
        overview.pendingValidationCount + overview.pendingAdjustmentsCount > 0 ? 'warn' : 'good',
    }),
    kpi({
      code: 'KPI-FIN-CS-VAR',
      label: 'Écarts de caisse du jour',
      value: varianceCount,
      unit: 'COUNT',
      detail:
        varianceCount > 0
          ? `manquant ${formatXaf(shortXaf)} · excédent ${formatXaf(overXaf)}`
          : null,
      tone: critical > 0 ? 'bad' : varianceCount > 0 ? 'warn' : 'good',
    }),
    kpi({
      code: 'KPI-FIN-TRANSFERS',
      label: 'Remises en attente',
      value: transfers.pendingCount,
      unit: 'COUNT',
      detail: `${formatXaf(inTransit.totalXaf)} en route · ${inTransit.overdueCount} en retard${
        transfers.discrepancyPending.count > 0
          ? ` · ${plural(transfers.discrepancyPending.count, 'écart', 'écarts')} à décider`
          : ''
      }`,
      tone: inTransit.overdueCount + transfers.discrepancyPending.count > 0 ? 'warn' : 'neutral',
    }),
  );
  if (critical > 0) {
    built.signals.push(
      signal({
        code: 'CASH_VARIANCE',
        severity: 'CRITICAL',
        title: `${plural(critical, 'écart de caisse critique', 'écarts de caisse critiques')} aujourd’hui`,
        detail: 'Écart courant au-delà du seuil critique du site : vérifier le comptage.',
        count: critical,
      }),
    );
  }
  if (openLong > 0) {
    built.signals.push(
      signal({
        code: 'CASH_SESSION_OPEN_LONG',
        severity: 'WARNING',
        title: plural(
          openLong,
          'caisse ouverte depuis trop longtemps',
          'caisses ouvertes depuis trop longtemps',
        ),
        detail: 'Faire clôturer la session, ou la clôturer d’office.',
        count: openLong,
      }),
    );
  }
  if (inTransit.overdueCount > 0) {
    built.signals.push(
      signal({
        code: 'CASH_TRANSFER_NOT_RECEIVED',
        severity: 'WARNING',
        title: `${plural(inTransit.overdueCount, 'remise de fonds non reçue', 'remises de fonds non reçues')} après ${inTransit.unreceivedHours} h`,
        detail: `${formatXaf(inTransit.overdueXaf)} en route : relancer le destinataire.`,
        count: inTransit.overdueCount,
      }),
    );
  }
  return merge(built, devices);
}

/**
 * Magasinier : produits à réapprovisionner (BR-STK-051) et quotas à régulariser sur les emplacements de
 * vente des PDV de ses sites, appareils de ces PDV. Ni caisse ni vente (AV-208). Aucun PDV : aucun bloc.
 */
async function distributionStoreBlock(ctx: Context, scope: ReadScope): Promise<Built> {
  const targets = await distributionTargetsFor(ctx, scope);
  if (targets.pointsOfSale.length === 0) return empty();
  const built = empty();
  const [thresholds, positions, devices] = await Promise.all([
    stockThresholdsOf(ctx.executor, { locationIds: targets.salesLocationIds }),
    allocationPositions(ctx.executor, { locationIds: targets.salesLocationIds, now: ctx.at }),
    devicesBlock(ctx, targets),
  ]);
  if (thresholds.length > 0) {
    const toReplenish = thresholds.filter((line) => line.suggestedQty > 0).length;
    built.kpis.push(
      kpi({
        code: 'KPI-DIS-07',
        label: 'Produits à réapprovisionner',
        value: toReplenish,
        unit: 'COUNT',
        detail: `sur ${plural(thresholds.length, 'seuil suivi', 'seuils suivis')} des PDV`,
        tone: toReplenish > 0 ? 'warn' : 'good',
      }),
    );
  }
  const toSettle = positions.reduce((sum, line) => sum + line.toSettleAllocations, 0);
  if (toSettle > 0) {
    built.kpis.push(
      kpi({
        code: 'KPI-DIS-QUOTAS',
        label: 'Quotas à régulariser',
        value: toSettle,
        unit: 'COUNT',
        detail: 'échus ou en cours de révocation : restituer le reste',
        tone: 'warn',
      }),
    );
  }
  return merge(built, devices);
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
      const [sales, receivables, cash, suspects, distribution, base] = await Promise.all([
        salesBlock(ctx, scope, { cashed: true, period: 'DAY' }),
        receivablesBlock(ctx, scope),
        cashPosition(ctx.executor),
        suspectPaymentsCount(ctx.executor, scope),
        ctx.canReadDistribution ? distributionFinanceBlock(ctx) : Promise.resolve(empty()),
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
        distribution,
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
      const [stock, distribution, base] = await Promise.all([
        stockBlock(ctx, scope, { value: true }),
        ctx.canReadDistribution ? distributionStoreBlock(ctx, scope) : Promise.resolve(empty()),
        coordination,
      ]);
      return merge(stock, distribution, base);
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
    canReadDistribution: await hasPermissionAt(
      input.executor,
      toBin(input.userId),
      DISTRIBUTION_READ,
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
  // L'Admin a déjà le signal de tous les appareils en attente (section ADMIN).
  if (!roleCodes.includes('ADMIN')) {
    const pending = await pendingDeviceApprovalsFor(input.executor, { userId: input.userId, at });
    if (pending.count > 0) {
      signals.push(
        signal({
          code: 'DEVICES_PENDING',
          severity: 'WARNING',
          title: `${pending.capped ? 'Au moins ' : ''}${plural(
            pending.count,
            'appareil attend votre approbation',
            'appareils attendent votre approbation',
          )}`,
          detail: 'Un appareil non approuvé ne peut pas envoyer d’opérations.',
          count: pending.count,
          action: { label: 'Voir les appareils', route: null },
        }),
      );
    }
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

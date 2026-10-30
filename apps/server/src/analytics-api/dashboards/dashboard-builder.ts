/**
 * Composition d'un tableau de bord pour un utilisateur (P9-17 ; ADR-066 §1 et §2) : appelée par les routes
 * `GET /analytics/dashboards/{code}` et par la tâche d'instantanés, qui produisent donc **les mêmes chiffres**
 * (AT-054). Le périmètre est l'étendue exacte de la permission `analytics.dashboard.<code>` de l'utilisateur,
 * jamais élargie ; les blocs se calculent en parallèle et chacun est isolé.
 *
 * Deux étapes (TB-8) : {@link prepareDashboard} (droit, limites, étendue exacte, valorisation, plafond : une fois par
 * utilisateur et tableau) et {@link buildDashboardBlocks} (les blocs d'une période, sans fraîcheur) ; la tâche
 * d'instantanés prépare une fois puis calcule les trois périodes, `buildDashboard` enchaîne les deux et ajoute la
 * fraîcheur. Tout champ de contexte indépendant de la période s'ajoute dans `prepareDashboard`.
 *
 * `distribution` garde son contrôleur HTTP (`distribution-api/`) ; sa composition par bloc (`DISTRIBUTION`) ne sert
 * que la tâche d'instantanés, qui lui donne ainsi le même contenu que le bloc de la tour de contrôle (TB-4, AV-467).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DashboardBlock, DashboardCode, DashboardResponse } from '@gic/contracts';
import { businessDayOf, type AnalyticsPeriod } from '@gic/domain';
import type { DB } from '../../platform/kysely/database.js';
import { toBin } from '../../platform/kysely/uuid-columns.js';
import {
  evaluateAccess,
  hasPermissionAt,
} from '../../modules/identity/application/public/index.js';
import { currentSettingValue } from '../../modules/organization/application/public/index.js';
import {
  readExplorerLimits,
  resolveExactScope,
  type ExactScope,
} from '../../modules/analytics/application/public/index.js';
import { explorerFreshness } from '../explorer-freshness.js';
import { readScopeOf, scopeIssueOf } from './scope-adapter.js';
import { BLOCK_BUILDERS, guarded, type DashboardContext } from './dashboard-blocks.js';

type Executor = Kysely<DB> | Transaction<DB>;
type BlockCode = DashboardResponse['blocks'][number]['code'];

/**
 * Blocs de chaque tableau, dans l'ordre de D11 §7.2. `distribution` : le bloc `DISTRIBUTION` de la tour de contrôle,
 * soit les quatre indicateurs d'origine de l'instantané personnel du titulaire de `analytics.dashboard.distribution`
 * (TB-4 ; AV-467), plus KPI-OPS-02 (et son compteur de conflits avec le droit de les lire : six au plus, AV-480).
 */
export const DASHBOARD_BLOCKS: Readonly<Record<DashboardCode, readonly BlockCode[]>> = {
  direction: [
    'PRODUCTION',
    'STOCK',
    'DISTRIBUTION',
    'VENTES',
    'FINANCES',
    'EQUIPES',
    'ALERTES',
    'COORDINATION',
  ],
  commercial: ['COMMERCIAL', 'VENTES', 'EQUIPES', 'ALERTES'],
  stock: ['STOCK', 'DISTRIBUTION', 'ALERTES'],
  production: ['PRODUCTION', 'ALERTES'],
  finance: ['FINANCES', 'VENTES', 'ALERTES', 'COORDINATION'],
  distribution: ['DISTRIBUTION'],
};

export const dashboardPermission = (code: DashboardCode): string => `analytics.dashboard.${code}`;
export const VALUATION_READ = 'inventory.valuation.read';
export const PENDING_APPROVALS_CAP_KEY = 'analytics.pending_approvals_count_cap';
const DEFAULT_PENDING_APPROVALS_CAP = 500;

export async function pendingApprovalsCap(executor: Executor, at: Date): Promise<number> {
  const value = await currentSettingValue(executor, {
    key: PENDING_APPROVALS_CAP_KEY,
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_PENDING_APPROVALS_CAP;
}

/**
 * Les valeurs au coût s'additionnent sur plusieurs sites : le droit doit être détenu sans borne (portée ALL, seule
 * portée accordée à `inventory.valuation.read`, 01-rbac.md §5.4), c'est-à-dire permis pour une ressource vide
 * (modèle : `ReadAccess.allowsAll`, read-access.ts). Un droit borné masque ces valeurs au lieu de les révéler pour
 * tous les sites (TB-11) : durcissement à échec fermé, sans changement de comportement tant que tous les octrois
 * sont en ALL ; l'essai de garde sur le catalogue (analytics-dashboard-blocks) échoue si cela change.
 */
async function canReadValuationOnAll(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<boolean> {
  const access = await evaluateAccess(executor, {
    userId,
    permissionCode: VALUATION_READ,
    occurredAt: at,
    resource: {},
  });
  return access.allowed;
}

export interface PrepareDashboardInput {
  readonly userId: string;
  readonly at: Date;
  readonly code: DashboardCode;
}

export interface BuildDashboardInput extends PrepareDashboardInput {
  readonly period: AnalyticsPeriod;
}

/** Ce qui ne dépend pas de la période : calculé une fois par utilisateur et tableau (TB-8). */
export interface PreparedDashboard {
  readonly code: DashboardCode;
  readonly exact: ExactScope;
  readonly context: Omit<DashboardContext, 'period'>;
}

/**
 * Première étape : le droit, les limites, l'étendue exacte, la valorisation et le plafond du tableau `code` de
 * l'utilisateur ; `null` si l'utilisateur ne détient pas la permission du tableau (la tâche d'instantanés saute alors
 * le tableau, la route répond 403 avant d'appeler).
 */
export async function prepareDashboard(
  executor: Executor,
  input: PrepareDashboardInput,
): Promise<PreparedDashboard | null> {
  const permission = dashboardPermission(input.code);
  const userBin = toBin(input.userId);
  if (!(await hasPermissionAt(executor, userBin, permission, input.at))) return null;
  const limits = await readExplorerLimits(executor, input.at);
  const exact = await resolveExactScope(
    executor,
    { userId: input.userId, permission, at: input.at },
    { maxCandidates: limits.scopeMaxCandidates },
  );
  return {
    code: input.code,
    exact,
    context: {
      executor,
      userId: input.userId,
      at: input.at,
      today: businessDayOf(input.at),
      // Là où l'étendue exacte est traduite en ReadScope ; une étendue tronquée n'est pas traduite (TB-6).
      scope: await readScopeOf(executor, exact),
      scopeIssue: scopeIssueOf(exact),
      canReadValuation: await canReadValuationOnAll(executor, input.userId, input.at),
      pendingApprovalsCap: await pendingApprovalsCap(executor, input.at),
    },
  };
}

/** Seconde étape : les blocs du tableau préparé sur `period`, calculés en parallèle et chacun isolé. */
export async function buildDashboardBlocks(
  prepared: PreparedDashboard,
  period: AnalyticsPeriod,
): Promise<DashboardBlock[]> {
  const context: DashboardContext = { ...prepared.context, period };
  return Promise.all(
    DASHBOARD_BLOCKS[prepared.code].map((code) =>
      guarded(code, BLOCK_BUILDERS[code].title, () => BLOCK_BUILDERS[code].build(context)),
    ),
  );
}

/**
 * Le tableau `code` de l'utilisateur sur `period` ; `null` si l'utilisateur ne détient pas la permission du
 * tableau (la route répond 403 avant d'appeler).
 */
export async function buildDashboard(
  executor: Executor,
  input: BuildDashboardInput,
): Promise<DashboardResponse | null> {
  const prepared = await prepareDashboard(executor, input);
  if (prepared === null) return null;
  const blocks = await buildDashboardBlocks(prepared, input.period);
  const freshness = await explorerFreshness(executor, { scope: prepared.exact, now: input.at });
  const view = (window: { fromDay: string; toDay: string; days: number }) => ({
    code: input.period.code,
    fromDay: window.fromDay,
    toDay: window.toDay,
    days: window.days,
  });
  return {
    code: input.code,
    period: view(input.period),
    previousPeriod: view(input.period.previous),
    blocks,
    freshness,
    computedAt: input.at.toISOString(),
  };
}

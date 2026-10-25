/**
 * Composition d'un tableau de bord pour un utilisateur (P9-17 ; ADR-076 §1 et §2) : appelée par les routes
 * `GET /analytics/dashboards/{code}` et par la tâche d'instantanés, qui produisent donc **les mêmes chiffres**
 * (AT-054). Le périmètre est l'étendue exacte de la permission `analytics.dashboard.<code>` de l'utilisateur,
 * jamais élargie ; les blocs se calculent en parallèle et chacun est isolé.
 */
import type { Kysely, Transaction } from 'kysely';
import { DASHBOARD_CODES, type DashboardCode, type DashboardResponse } from '@gic/contracts';
import { businessDayOf, type AnalyticsPeriod } from '@gic/domain';
import type { DB } from '../../platform/kysely/database.js';
import { toBin } from '../../platform/kysely/uuid-columns.js';
import { hasPermissionAt } from '../../modules/identity/application/public/index.js';
import { currentSettingValue } from '../../modules/organization/application/public/index.js';
import {
  readExplorerLimits,
  resolveExactScope,
} from '../../modules/analytics/application/public/index.js';
import { explorerFreshness } from '../explorer-freshness.js';
import { readScopeOf } from './scope-adapter.js';
import { BLOCK_BUILDERS, guarded, type DashboardContext } from './dashboard-blocks.js';

type Executor = Kysely<DB> | Transaction<DB>;
type BlockCode = DashboardResponse['blocks'][number]['code'];

/** Les tableaux de rôle et la tour de contrôle (`distribution` garde son contrôleur). */
export const ROLE_DASHBOARD_CODES: readonly DashboardCode[] = DASHBOARD_CODES.filter(
  (code) => code !== 'distribution',
);

/** Blocs de chaque tableau, dans l'ordre de D11 §7.2. */
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
  distribution: [],
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

export interface BuildDashboardInput {
  readonly userId: string;
  readonly at: Date;
  readonly code: DashboardCode;
  readonly period: AnalyticsPeriod;
}

/**
 * Le tableau `code` de l'utilisateur sur `period` ; `null` si l'utilisateur ne détient pas la permission du
 * tableau (la tâche d'instantanés saute alors l'utilisateur, la route répond 403 avant d'appeler).
 */
export async function buildDashboard(
  executor: Executor,
  input: BuildDashboardInput,
): Promise<DashboardResponse | null> {
  const permission = dashboardPermission(input.code);
  const userBin = toBin(input.userId);
  if (!(await hasPermissionAt(executor, userBin, permission, input.at))) return null;
  const limits = await readExplorerLimits(executor, input.at);
  const exact = await resolveExactScope(
    executor,
    { userId: input.userId, permission, at: input.at },
    { maxCandidates: limits.scopeMaxCandidates },
  );
  const context: DashboardContext = {
    executor,
    userId: input.userId,
    at: input.at,
    today: businessDayOf(input.at),
    period: input.period,
    scope: await readScopeOf(executor, exact),
    canReadValuation: await hasPermissionAt(executor, userBin, VALUATION_READ, input.at),
    pendingApprovalsCap: await pendingApprovalsCap(executor, input.at),
  };
  const blocks = await Promise.all(
    DASHBOARD_BLOCKS[input.code].map((code) =>
      guarded(code, BLOCK_BUILDERS[code].title, () => BLOCK_BUILDERS[code].build(context)),
    ),
  );
  const freshness = await explorerFreshness(executor, { scope: exact, now: input.at });
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

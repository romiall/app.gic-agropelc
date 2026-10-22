/**
 * Période d'un tableau de bord (P9-16 ; AV-207, ADR-075 §3) : une période nommée (`period`, défaut `TODAY`) ou une
 * plage `from`/`to` (jours métier inclus, au plus `analytics.dashboard_max_period_days` jours), résolue par le
 * résolveur commun du domaine (`resolveAnalyticsPeriod`) — la même pour le tableau de distribution, la tour de
 * contrôle, les tableaux de rôle et les instantanés. Une période invalide ou trop longue est une erreur 400.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  DomainError,
  businessDayOf,
  resolveAnalyticsPeriod,
  type AnalyticsPeriod,
  type AnalyticsPeriodCode,
} from '@gic/domain';
import type { DB } from '../platform/kysely/database.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { currentSettingValue } from '../modules/organization/application/public/index.js';

export const DASHBOARD_MAX_PERIOD_DAYS_KEY = 'analytics.dashboard_max_period_days';
/** Défaut du paramètre semé (AV-207) quand il manque ou est mal formé. */
export const DEFAULT_DASHBOARD_MAX_PERIOD_DAYS = 366;

type Executor = Kysely<DB> | Transaction<DB>;

export async function dashboardMaxPeriodDays(executor: Executor, at: Date): Promise<number> {
  const value = await currentSettingValue(executor, {
    key: DASHBOARD_MAX_PERIOD_DAYS_KEY,
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_DASHBOARD_MAX_PERIOD_DAYS;
}

export interface DashboardPeriodQuery {
  readonly period?: Exclude<AnalyticsPeriodCode, 'CUSTOM'> | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export async function resolveDashboardPeriod(
  executor: Executor,
  now: Date,
  query: DashboardPeriodQuery,
): Promise<AnalyticsPeriod> {
  const maxDays = await dashboardMaxPeriodDays(executor, now);
  try {
    return resolveAnalyticsPeriod({
      code: query.from !== undefined ? 'CUSTOM' : (query.period ?? 'TODAY'),
      today: businessDayOf(now),
      fromDay: query.from,
      toDay: query.to,
      ...(query.from !== undefined ? { maxDays } : {}),
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        error.code === 'PERIOD_TOO_LONG' ? `Période limitée à ${maxDays} jours.` : 'Période invalide.',
      );
    }
    throw error;
  }
}

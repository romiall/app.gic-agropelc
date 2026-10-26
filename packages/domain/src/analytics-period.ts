/**
 * Résolveur de périodes d'analyse (P9 ; BR-ANA-002 ; ADR-075 §3 ; AV-207) : extension de
 * `BUSINESS_PERIOD_CODES`, `businessPeriodOf` et `businessPeriodDays` (`business-day.ts`), pas une
 * seconde implémentation. Il ajoute :
 * - la plage personnalisée (`CUSTOM`, jours métier inclus) ;
 * - les instants UTC `startUtc` et `endUtc` (exclu), pour les fonctions qui lisent `[from, to[` ;
 * - la **période précédente** (comparaison des flux dans la tour de contrôle) : pour une période nommée,
 *   la période civile précédente complète de même nature ; pour une plage personnalisée, la plage de
 *   même durée qui la précède ;
 * - le plafond de durée d'une période (`analytics.dashboard_max_period_days`, AV-207).
 */
import {
  addBusinessDays,
  BUSINESS_PERIOD_CODES,
  businessDayEndUtc,
  businessDayStartUtc,
  businessPeriodDays,
  businessPeriodOf,
  type BusinessPeriodCode,
} from './business-day.js';
import { DomainError } from './errors.js';

export const ANALYTICS_PERIOD_CODES = [...BUSINESS_PERIOD_CODES, 'CUSTOM'] as const;
export type AnalyticsPeriodCode = (typeof ANALYTICS_PERIOD_CODES)[number];

/** Une fenêtre de jours métier (bornes incluses) et ses instants UTC (fin exclue). */
export interface AnalyticsPeriodWindow {
  readonly fromDay: string;
  readonly toDay: string;
  readonly days: number;
  readonly startUtc: Date;
  readonly endUtc: Date;
}

export interface AnalyticsPeriod extends AnalyticsPeriodWindow {
  readonly code: AnalyticsPeriodCode;
  readonly previous: AnalyticsPeriodWindow;
}

export interface ResolveAnalyticsPeriodInput {
  readonly code: AnalyticsPeriodCode;
  /** Jour métier de référence (aujourd'hui, `AAAA-MM-JJ`). */
  readonly today: string;
  /** Bornes d'une plage `CUSTOM` (jours métier inclus). */
  readonly fromDay?: string | undefined;
  readonly toDay?: string | undefined;
  /** Durée maximale en jours (`PERIOD_TOO_LONG` au-delà) ; absent : sans plafond. */
  readonly maxDays?: number | undefined;
}

export function isAnalyticsPeriodCode(value: unknown): value is AnalyticsPeriodCode {
  return typeof value === 'string' && (ANALYTICS_PERIOD_CODES as readonly string[]).includes(value);
}

function windowOf(fromDay: string, toDay: string): AnalyticsPeriodWindow {
  return {
    fromDay,
    toDay,
    days: businessPeriodDays({ fromDay, toDay }),
    startUtc: businessDayStartUtc(fromDay),
    endUtc: businessDayEndUtc(toDay),
  };
}

/** Première période civile précédente de même nature que `code`, relative à la période courante. */
function previousNamed(
  code: BusinessPeriodCode,
  current: { readonly fromDay: string; readonly toDay: string },
): { readonly fromDay: string; readonly toDay: string } {
  switch (code) {
    case 'TODAY':
    case 'YESTERDAY': {
      const day = addBusinessDays(current.fromDay, -1);
      return { fromDay: day, toDay: day };
    }
    case 'WEEK':
      return {
        fromDay: addBusinessDays(current.fromDay, -7),
        toDay: addBusinessDays(current.toDay, -7),
      };
    case 'MONTH':
      return businessPeriodOf('MONTH', addBusinessDays(current.fromDay, -1));
    case 'YEAR':
      return businessPeriodOf('YEAR', addBusinessDays(current.fromDay, -1));
  }
}

/**
 * Période d'analyse résolue. Erreurs : `PERIOD_INVALID` (bornes manquantes pour `CUSTOM`, ou inversées)
 * et `PERIOD_TOO_LONG` (au-delà de `maxDays`).
 */
export function resolveAnalyticsPeriod(input: ResolveAnalyticsPeriodInput): AnalyticsPeriod {
  let bounds: { readonly fromDay: string; readonly toDay: string };
  let previous: { readonly fromDay: string; readonly toDay: string };
  if (input.code === 'CUSTOM') {
    if (input.fromDay === undefined || input.toDay === undefined) {
      throw new DomainError(
        'Une plage personnalisée exige un premier et un dernier jour.',
        'PERIOD_INVALID',
      );
    }
    bounds = { fromDay: input.fromDay, toDay: input.toDay };
    const length = businessPeriodDays(bounds);
    previous = {
      fromDay: addBusinessDays(bounds.fromDay, -length),
      toDay: addBusinessDays(bounds.fromDay, -1),
    };
  } else {
    bounds = businessPeriodOf(input.code, input.today);
    previous = previousNamed(input.code, bounds);
  }
  const current = windowOf(bounds.fromDay, bounds.toDay);
  if (input.maxDays !== undefined && current.days > input.maxDays) {
    throw new DomainError(
      `Période de ${current.days} jours : au plus ${input.maxDays} jours.`,
      'PERIOD_TOO_LONG',
    );
  }
  return { code: input.code, ...current, previous: windowOf(previous.fromDay, previous.toDay) };
}

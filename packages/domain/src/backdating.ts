/**
 * Fenêtre de saisie rétroactive (AV-078, BR-SYN-012), partagée appareil et serveur (ADR-021) : une opération dont la date
 * (`occurred_at`) précède l'instant où elle a été saisie (`client_created_at`) est une saisie rétroactive. Jusqu'à
 * `sync.justification_after_hours` (24 h), aucune formalité ; au-delà, un motif est exigé (`backdated_reason`) ; au-delà de
 * `sync.backdate_max_hours` (72 h), la saisie est refusée, sauf à qui a le droit de dépasser la fenêtre
 * (`sync.backdate.exceed` : chargement de l'historique). Pur : l'appelant fournit les valeurs des réglages.
 */

export const JUSTIFICATION_AFTER_HOURS_SETTING = 'sync.justification_after_hours';
export const BACKDATE_MAX_HOURS_SETTING = 'sync.backdate_max_hours';
export const DEFAULT_JUSTIFICATION_AFTER_HOURS = 24;
export const DEFAULT_BACKDATE_MAX_HOURS = 72;

/** Droit de saisir au-delà de la fenêtre : celui qui charge l'historique (pièces papier anciennes). */
export const BACKDATE_EXCEED_PERMISSION = 'sync.backdate.exceed';

const HOUR_MS = 60 * 60 * 1000;

export interface BackdatingWindow {
  readonly justificationAfterHours: number;
  readonly maxHours: number;
}

function hoursOr(value: unknown, fallback: number): number {
  const hours = typeof value === 'string' ? Number(value) : value;
  return typeof hours === 'number' && Number.isFinite(hours) && hours >= 0 ? hours : fallback;
}

/**
 * La fenêtre d'après les deux réglages. Une valeur absente ou absurde (négative, non numérique) prend le défaut d'AV-078 ;
 * le maximum n'est jamais inférieur au seuil du motif (sinon une saisie serait refusée avant d'avoir pu être justifiée).
 */
export function backdatingWindowFrom(
  justificationAfterHours: unknown,
  maxHours: unknown,
): BackdatingWindow {
  const after = hoursOr(justificationAfterHours, DEFAULT_JUSTIFICATION_AFTER_HOURS);
  const max = hoursOr(maxHours, DEFAULT_BACKDATE_MAX_HOURS);
  return { justificationAfterHours: after, maxHours: Math.max(max, after) };
}

export interface BackdatingEvaluation {
  /** Heures entre la date du fait et la saisie, arrondies au dixième ; négatif : date postérieure à la saisie. */
  readonly gapHours: number;
  /** Plus que `justificationAfterHours` : un motif est exigé et la saisie est signalée. */
  readonly requiresReason: boolean;
  /** Plus que `maxHours` : refusée, sauf pour qui a le droit de dépasser la fenêtre. */
  readonly exceedsWindow: boolean;
}

/**
 * Évalue l'écart `client_created_at − occurred_at` (en millisecondes) contre la fenêtre. Strict : une saisie d'exactement
 * 24 h, ou 72 h, est dans la fenêtre.
 */
export function evaluateBackdatingGap(
  gapMs: number,
  window: BackdatingWindow,
): BackdatingEvaluation {
  const finite = Number.isFinite(gapMs) ? gapMs : 0;
  return {
    gapHours: Math.round((finite / HOUR_MS) * 10) / 10,
    requiresReason: finite > window.justificationAfterHours * HOUR_MS,
    exceedsWindow: finite > window.maxHours * HOUR_MS,
  };
}

export type BackdatingRefusal = 'BACKDATE_EXCEEDED' | 'JUSTIFICATION_REQUIRED';

/**
 * Le refus d'une saisie rétroactive, ou `null` si elle passe. Le dépassement de la fenêtre prime : une saisie trop ancienne
 * n'est pas sauvée par un motif. Qui a le droit de dépasser la fenêtre l'est du refus, pas de l'obligation du motif.
 */
export function backdatingRefusal(
  evaluation: BackdatingEvaluation,
  input: { readonly hasReason: boolean; readonly canExceedWindow: boolean },
): BackdatingRefusal | null {
  if (evaluation.exceedsWindow && !input.canExceedWindow) return 'BACKDATE_EXCEEDED';
  if (evaluation.requiresReason && !input.hasReason) return 'JUSTIFICATION_REQUIRED';
  return null;
}

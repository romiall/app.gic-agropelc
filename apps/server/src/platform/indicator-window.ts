/**
 * Fenêtres et ratios communs des fonctions de référence des indicateurs (P9-15 ; ADR-075 §1) : une période est
 * soit des jours métier inclus, soit des instants UTC `[from, to[` ; un ratio est arrondi à 4 décimales (demi
 * supérieur, D07 « Taux ») et vaut `null` quand le dénominateur est nul — jamais une valeur trompeuse.
 */
export interface DayWindow {
  readonly fromDay: string;
  readonly toDay: string;
}

export interface UtcWindow {
  readonly fromUtc: Date;
  readonly toUtc: Date;
}

export function ratio(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/** Un nombre lu en base (décimal en chaîne, entier, `null`) ; `0` quand il est vide. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

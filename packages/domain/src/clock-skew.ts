/**
 * BR-SYN-011 (06-offline-sync/02-synchronisation.md §9) : écart entre l'horloge d'un
 * appareil et l'horloge serveur au-delà duquel une opération est signalée comme suspecte
 * (jeton `CLOCK_SUSPECT`, `[STD-ORIGIN].clock_suspect` — 03-data/01-identifiants-et-
 * conventions.md §3.3) — jamais corrigée pour autant (ADR-016).
 *
 * P5-23 :
 * - AV-216 : le seuil se lit dans le paramètre `sync.clock_skew_flag_minutes` (règle 8 du CLAUDE.md) ;
 *   `CLOCK_SKEW_SUSPECT_MS` n'est plus que le repli d'une valeur absente ou absurde.
 * - AV-226 : la tolérance de date future du pipeline (`OCCURRED_AT_FUTURE`, INV-GLO-02) se lit dans
 *   `sync.occurred_at_future_tolerance_minutes`, paramètre distinct (élargir le drapeau ne doit pas élargir
 *   une fenêtre de rejet).
 * - AV-227 : l'écart est borné à ce que stockent les colonnes `INT` (≈ ±24,8 jours) ; au-delà, une tablette
 *   remise à une date lointaine faisait échouer l'enregistrement de tout son lot, rejoué sans fin.
 */
export const CLOCK_SKEW_SUSPECT_MS = 5 * 60 * 1000;

/** Repli de la tolérance de date future (INV-GLO-02, BR-SYN-011) : 5 min. */
export const OCCURRED_AT_FUTURE_TOLERANCE_DEFAULT_MS = 5 * 60 * 1000;

/** Plus grand écart stockable (colonnes `INT` de `sync_command_inbox` et `sync_device_sync_state`). */
export const CLOCK_SKEW_STORED_MAX_MS = 2_147_483_647;

/** Écart borné à ±`CLOCK_SKEW_STORED_MAX_MS`, en millisecondes entières (AV-227). */
export function clampClockSkewMs(clockSkewMs: number): number {
  if (!Number.isFinite(clockSkewMs)) {
    return clockSkewMs > 0 ? CLOCK_SKEW_STORED_MAX_MS : -CLOCK_SKEW_STORED_MAX_MS;
  }
  return Math.max(
    -CLOCK_SKEW_STORED_MAX_MS,
    Math.min(CLOCK_SKEW_STORED_MAX_MS, Math.trunc(clockSkewMs)),
  );
}

/** Minutes d'un paramètre en millisecondes : nombre fini, plafonné ; `undefined` si absurde. */
function minutesToMs(value: unknown, admitsZero: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || (!admitsZero && value === 0)) return undefined;
  return Math.min(CLOCK_SKEW_STORED_MAX_MS, Math.round(value * 60_000));
}

/** Seuil du drapeau (`sync.clock_skew_flag_minutes`) : minutes > 0, sinon 5 min (AV-216). */
export function clockSkewThresholdMsFrom(minutes: unknown): number {
  return minutesToMs(minutes, false) ?? CLOCK_SKEW_SUSPECT_MS;
}

/** Tolérance de date future (`sync.occurred_at_future_tolerance_minutes`) : minutes ≥ 0, sinon 5 min (AV-226). */
export function futureToleranceMsFrom(minutes: unknown): number {
  return minutesToMs(minutes, true) ?? OCCURRED_AT_FUTURE_TOLERANCE_DEFAULT_MS;
}

export function isClockSkewSuspect(
  clockSkewMs: number | null,
  thresholdMs: number = CLOCK_SKEW_SUSPECT_MS,
): boolean {
  return clockSkewMs !== null && Math.abs(clockSkewMs) > thresholdMs;
}

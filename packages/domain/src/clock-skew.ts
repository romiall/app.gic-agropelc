/**
 * BR-SYN-011 (06-offline-sync/02-synchronisation.md §9) : écart entre l'horloge d'un
 * appareil et l'horloge serveur au-delà duquel une opération est signalée comme suspecte
 * (jeton `CLOCK_SUSPECT`, `[STD-ORIGIN].clock_suspect` — 03-data/01-identifiants-et-
 * conventions.md §3.3) — jamais corrigée pour autant (ADR-016).
 */
export const CLOCK_SKEW_SUSPECT_MS = 5 * 60 * 1000;

export function isClockSkewSuspect(clockSkewMs: number | null): boolean {
  return clockSkewMs !== null && Math.abs(clockSkewMs) > CLOCK_SKEW_SUSPECT_MS;
}

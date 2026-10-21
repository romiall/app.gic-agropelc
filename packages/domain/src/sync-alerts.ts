/**
 * Règles pures des alertes de synchronisation (P9-10 ; D13 §7.1 `SYNC_ERROR`, `SYNC_STALE`, `DEVICE_SEQ_GAP`,
 * `CLOCK_SKEW` ; AV-442, AV-471 à AV-474) : réglages et règles de décision, sans entrée-sortie. Aucune
 * fonction ne lève.
 */

/** Plafond d'un délai en heures (dix ans) : au-delà, l'instant de coupure ne serait plus une date valide. */
export const MAX_SYNC_ALERT_HOURS = 87_600;
/** Plafond de l'horizon d'oubli d'un appareil (dix ans, en jours). */
export const MAX_SYNC_STALE_HORIZON_DAYS = 3_650;

/** `sync.stale_hours` (D13 §7.1 : appareil actif sans synchronisation depuis plus de 24 h). */
export const DEFAULT_SYNC_STALE_HOURS = 24;
/** `sync.error_alert_window_hours` (AV-442 : fenêtre de 24 h). */
export const DEFAULT_SYNC_ERROR_WINDOW_HOURS = 24;
/** `sync.seq_gap_alert_hours` (BR-SYN-003, D13 §7.1 : trou de séquence non comblé depuis plus de 24 h). */
export const DEFAULT_SYNC_SEQ_GAP_HOURS = 24;
/** `sync.stale_horizon_days` : au-delà, un appareil silencieux est tenu pour abandonné (AV-472). */
export const DEFAULT_SYNC_STALE_HORIZON_DAYS = 30;
/** Codes d'erreur qui ne signalent aucun défaut de l'appareil : décision de l'Admin, conséquence d'un autre rejet. */
export const DEFAULT_SYNC_ERROR_EXCLUDED_CODES: readonly string[] = [
  'COMMAND_DISCARDED',
  'DEPENDENCY_REJECTED',
];

function hoursOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_SYNC_ALERT_HOURS)
    : fallback;
}

/** `sync.stale_hours` : un nombre fini strictement positif (plafonné), sinon 24. */
export function syncStaleHoursOrDefault(value: unknown): number {
  return hoursOrDefault(value, DEFAULT_SYNC_STALE_HOURS);
}

/** `sync.error_alert_window_hours` : un nombre fini strictement positif (plafonné), sinon 24. */
export function syncErrorAlertWindowHoursOrDefault(value: unknown): number {
  return hoursOrDefault(value, DEFAULT_SYNC_ERROR_WINDOW_HOURS);
}

/** `sync.seq_gap_alert_hours` : un nombre fini strictement positif (plafonné), sinon 24. */
export function syncSeqGapAlertHoursOrDefault(value: unknown): number {
  return hoursOrDefault(value, DEFAULT_SYNC_SEQ_GAP_HOURS);
}

/**
 * `sync.stale_horizon_days` : jours entiers ≥ 0 (plafonnés), sinon 30 ; `0` supprime l'horizon (un appareil
 * actif reste signalé tant qu'il se tait).
 */
export function syncStaleHorizonDaysOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), MAX_SYNC_STALE_HORIZON_DAYS)
    : DEFAULT_SYNC_STALE_HORIZON_DAYS;
}

/**
 * `sync.error_alert_excluded_codes` : liste de codes d'erreur à ne pas signaler. Une liste vide est admise
 * (rien n'est exclu) ; une valeur qui n'est pas une liste de chaînes retombe sur le défaut. Les éléments
 * qui ne sont pas des chaînes non vides sont ignorés.
 */
export function syncErrorExcludedCodesOrDefault(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_SYNC_ERROR_EXCLUDED_CODES;
  return value
    .filter((code): code is string => typeof code === 'string' && code.trim() !== '')
    .map((code) => code.trim());
}

/**
 * Code d'erreur d'une commande rejetée ou en conflit, regroupant les variantes d'une même cause : le suffixe
 * d'un code détaillé (`VALIDATION_ERROR:<raison>`) est retiré ; une commande en conflit sans code propre prend
 * le type de son conflit encore ouvert. `null` si la commande n'a aucune cause à signaler (conflit refermé).
 */
export function syncErrorCodeOf(input: {
  readonly errorCode: string | null;
  readonly openConflictType: string | null;
}): string | null {
  const raw = input.errorCode ?? input.openConflictType;
  if (raw === null) return null;
  const code = raw.split(':')[0]!.trim();
  return code === '' ? null : code;
}

/** Vrai si le code d'erreur est à signaler (absent de la liste des exclus). */
export function isSyncErrorAlertable(code: string, excluded: readonly string[]): boolean {
  return !excluded.includes(code);
}

export interface DeviceStalenessInput {
  /** Dernier contact connu (connexion, envoi ou pull) ; `null` si l'appareil n'a jamais contacté le serveur. */
  readonly lastContactAt: Date | null;
  /** Date de passage à l'état actif : un appareil approuvé n'est pas « en retard » avant de s'en être servi. */
  readonly activatedAt: Date;
  readonly now: Date;
  readonly staleHours: number;
  /** Jours après lesquels un appareil silencieux est tenu pour abandonné ; `0` : aucun horizon. */
  readonly horizonDays: number;
}

export interface DeviceStaleness {
  readonly stale: boolean;
  /** Référence du délai : le plus récent du dernier contact et de l'activation. */
  readonly sinceAt: Date;
  /** Heures entières écoulées depuis la référence (jamais négatives). */
  readonly hoursSince: number;
}

/**
 * Appareil actif sans synchronisation « depuis plus de » `staleHours` (borne exclue), mesuré depuis le plus
 * récent du dernier contact et de l'activation ; il cesse d'être signalé au-delà de l'horizon d'oubli
 * (AV-472, appareil abandonné sans être retiré).
 */
export function deviceStaleness(input: DeviceStalenessInput): DeviceStaleness {
  const sinceAt =
    input.lastContactAt !== null && input.lastContactAt.getTime() > input.activatedAt.getTime()
      ? input.lastContactAt
      : input.activatedAt;
  const elapsedMs = input.now.getTime() - sinceAt.getTime();
  const withinHorizon = input.horizonDays === 0 || elapsedMs <= input.horizonDays * 86_400_000;
  return {
    stale: elapsedMs > input.staleHours * 3_600_000 && withinHorizon,
    sinceAt,
    hoursSince: Math.max(0, Math.floor(elapsedMs / 3_600_000)),
  };
}

/** Plage de `device_seq` absente de la boîte des commandes (bornes comprises). */
export interface SequenceGap {
  readonly from: number;
  readonly to: number;
  /** Réception de la première commande de séquence supérieure : depuis quand le trou est visible. */
  readonly openedAt: Date;
}

/** Nombre de numéros manquants d'une liste de plages. */
export function missingSequenceCount(
  gaps: readonly { readonly from: number; readonly to: number }[],
): number {
  return gaps.reduce((total, gap) => total + (gap.to - gap.from + 1), 0);
}

/** Plages visibles depuis plus de `hours` heures (borne exclue : « plus de »). */
export function agedSequenceGaps(
  gaps: readonly SequenceGap[],
  now: Date,
  hours: number,
): readonly SequenceGap[] {
  const limit = now.getTime() - hours * 3_600_000;
  return gaps.filter((gap) => gap.openedAt.getTime() < limit);
}

/**
 * Vrai si les restes déclarés par l'appareil suffisent à expliquer **tous** les numéros manquants : une
 * commande encore dans son outbox (tablette partagée dont un auteur n'a pas ouvert sa session, envoi
 * interrompu) n'est pas perdue. Sans déclaration (`null`), rien n'est supposé (AV-473).
 */
export function gapsExplainedByPending(
  gaps: readonly { readonly from: number; readonly to: number }[],
  pendingReported: number | null,
): boolean {
  return pendingReported !== null && pendingReported >= missingSequenceCount(gaps);
}

/** Plage mémorisée `[début, fin]` d'un trou déjà signalé (`known_gaps`). */
export type KnownGap = readonly [number, number];

/** Paires `[début, fin]` mémorisées d'une valeur JSON (`known_gaps`) ; ce qui n'est pas une paire valide est ignoré. */
export function parseKnownGaps(value: unknown): readonly KnownGap[] {
  if (!Array.isArray(value)) return [];
  const pairs: [number, number][] = [];
  for (const item of value) {
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      Number.isSafeInteger(item[0]) &&
      Number.isSafeInteger(item[1]) &&
      item[0] >= 1 &&
      item[1] >= item[0]
    ) {
      pairs.push([item[0] as number, item[1] as number]);
    }
  }
  return pairs;
}

/**
 * Plages de `current` que la mémoire ne couvre pas encore : une plage **contenue** dans une plage déjà signalée
 * n'est pas nouvelle (le trou s'est réduit parce qu'une commande tardive est arrivée, ou scindé), alors qu'une
 * plage nouvelle ou plus large l'est (AV-473).
 */
export function unsignaledSequenceGaps<T extends { readonly from: number; readonly to: number }>(
  current: readonly T[],
  known: readonly KnownGap[],
): readonly T[] {
  return current.filter((gap) => !known.some(([from, to]) => gap.from >= from && gap.to <= to));
}

/**
 * Mémoire après une passe : les plages déjà signalées dont un numéro manque encore (une plage dont toutes les
 * commandes sont arrivées sort de la mémoire) et celles signalées par cette passe, triées, sans plage contenue
 * dans une autre. Elle ne dépend **pas** de l'explication par les restes déclarés ni de l'âge des plages : une
 * alerte déjà traitée ne renaît pas quand les restes déclarés de l'appareil oscillent.
 */
export function nextKnownGaps(input: {
  /** Mémoire avant la passe. */
  readonly known: readonly KnownGap[];
  /** Tous les trous présents (anciens ou non, expliqués ou non). */
  readonly present: readonly { readonly from: number; readonly to: number }[];
  /** Plages signalées par cette passe. */
  readonly signaled: readonly { readonly from: number; readonly to: number }[];
}): readonly KnownGap[] {
  const kept = input.known.filter(([from, to]) =>
    input.present.some((gap) => gap.from <= to && gap.to >= from),
  );
  const all: KnownGap[] = [...kept, ...input.signaled.map((gap): KnownGap => [gap.from, gap.to])];
  return all
    .filter(
      ([from, to], index) =>
        !all.some(
          // Une plage ne se compare pas à elle-même : à égalité parfaite, seule la première est gardée.
          ([otherFrom, otherTo], other) =>
            otherFrom <= from &&
            otherTo >= to &&
            (otherFrom < from || otherTo > to || other < index),
        ),
    )
    .sort((a, b) => a[0] - b[0]);
}

/** Même contenu (ordre compris) : évite de réécrire `known_gaps` à l'identique. */
export function sameSequenceGaps(a: readonly KnownGap[], b: readonly KnownGap[]): boolean {
  return (
    a.length === b.length &&
    a.every(([from, to], index) => b[index]![0] === from && b[index]![1] === to)
  );
}

/**
 * Écart d'horloge en minutes entières, signé (heure du serveur moins heure de l'appareil), arrondi à la minute
 * **supérieure** en valeur absolue : l'alerte se lève quand l'écart dépasse strictement le seuil en
 * millisecondes, et l'arrondi au plus proche l'afficherait égal au seuil (300,4 s pour un seuil de 5 min).
 */
export function clockSkewMinutes(skewMs: number): number {
  const minutes = Math.ceil(Math.abs(skewMs) / 60_000);
  return skewMs < 0 ? -minutes : minutes;
}

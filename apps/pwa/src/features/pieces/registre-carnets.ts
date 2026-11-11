/**
 * Contrôle de continuité des souches de carnets et fenêtre d'antidatage (AV-308, AV-312, AV-078).
 * Logique PURE sans dépendance UI : testable unitairement et réutilisable dans l'écran de report
 * et dans la consultation du registre des carnets.
 */
import { backdatingWindowFrom, evaluateBackdatingGap, type BackdatingWindow } from '@gic/domain';

export interface ContinuityReport {
  readonly totalCount: number;
  readonly uniqueCount: number;
  readonly minNumber: number | null;
  readonly maxNumber: number | null;
  /** Numéros manquants entre min et max dans la série observée. */
  readonly missingNumbers: readonly number[];
  /** Références en double (au moins 2 occurrences). */
  readonly duplicates: readonly { readonly ref: string; readonly count: number }[];
}

export interface InputContinuityCheck {
  readonly isDuplicate: boolean;
  readonly isGap: boolean;
  /** Numéros manquants entre le dernier max observé et le nouveau numéro. */
  readonly missingBefore: readonly number[];
  readonly lastMaxNumber: number | null;
}

export interface BackdatingEvaluation {
  readonly diffHours: number;
  /** Dépassant le seuil d'usage courant (24 h, AV-078). */
  readonly isBackdated: boolean;
  /** Dépassant le délai maximal d'antidatage (72 h, AV-078). */
  readonly isCriticalDelay: boolean;
  readonly isFuture: boolean;
  /** Motif obligatoire si > 24 h. */
  readonly requiresReason: boolean;
}

/** Extrait la partie numérique d'une référence de pièce (ex. "BV-000142" -> 142, "RE 45" -> 45). */
export function extractSlipNumber(ref: string): number | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(\d+)(?!.*\d)/);
  if (!match || match[1] === undefined) return null;
  const num = parseInt(match[1], 10);
  return Number.isSafeInteger(num) ? num : null;
}

/** Nettoie une référence de pièce papier. */
export function normalizeSlipRef(ref: string): string {
  return ref.trim().toUpperCase().replace(/\s+/g, '-');
}

/**
 * Analyse la continuité d'un ensemble de références de pièces pour un type donné.
 * Détecte les sauts dans la numérotation (numéros manquants) et les doublons (AV-312).
 */
export function analyzeContinuity(refs: readonly string[]): ContinuityReport {
  if (refs.length === 0) {
    return {
      totalCount: 0,
      uniqueCount: 0,
      minNumber: null,
      maxNumber: null,
      missingNumbers: [],
      duplicates: [],
    };
  }

  const countsByRef = new Map<string, number>();
  const parsedNumbers = new Set<number>();

  for (const raw of refs) {
    const clean = normalizeSlipRef(raw);
    if (!clean) continue;
    countsByRef.set(clean, (countsByRef.get(clean) ?? 0) + 1);

    const num = extractSlipNumber(clean);
    if (num !== null) {
      parsedNumbers.add(num);
    }
  }

  const duplicates: { ref: string; count: number }[] = [];
  for (const [ref, count] of countsByRef.entries()) {
    if (count > 1) {
      duplicates.push({ ref, count });
    }
  }

  const numbersSorted = Array.from(parsedNumbers).sort((a, b) => a - b);
  const minNumber = numbersSorted.length > 0 ? numbersSorted[0]! : null;
  const maxNumber = numbersSorted.length > 0 ? numbersSorted[numbersSorted.length - 1]! : null;

  const missingNumbers: number[] = [];
  if (minNumber !== null && maxNumber !== null && maxNumber - minNumber > 1) {
    const presentSet = new Set(numbersSorted);
    // Plafond de sécurité à 1 000 sauts consécutifs pour éviter les boucles démesurées en cas d'erreur de saisie
    const limit = Math.min(maxNumber, minNumber + 1000);
    for (let i = minNumber + 1; i < limit; i += 1) {
      if (!presentSet.has(i)) {
        missingNumbers.push(i);
      }
    }
  }

  return {
    totalCount: refs.length,
    uniqueCount: countsByRef.size,
    minNumber,
    maxNumber,
    missingNumbers,
    duplicates,
  };
}

/** Continuité de plusieurs carnets : chaque type de pièce a sa propre suite de numéros (AV-312). */
export interface TypedContinuity {
  readonly totalCount: number;
  /** Plage des numéros quand un seul type de carnet est concerné, sinon `null` (suites distinctes). */
  readonly range: { readonly min: number; readonly max: number } | null;
  readonly missing: readonly { readonly type: string; readonly numbers: readonly number[] }[];
  readonly missingCount: number;
  readonly duplicates: readonly {
    readonly type: string;
    readonly ref: string;
    readonly count: number;
  }[];
}

/**
 * Contrôle de continuité d'un registre qui mêle plusieurs carnets : une suite par type de pièce, jamais
 * une suite unique (le bon de vente n° 142 et le reçu n° 99 ne forment pas un « saut » de 43 numéros).
 */
export function analyzeContinuityByType(
  slips: readonly { readonly slipType: string; readonly paperSlipRef: string }[],
): TypedContinuity {
  const byType = new Map<string, string[]>();
  for (const slip of slips) {
    byType.set(slip.slipType, [...(byType.get(slip.slipType) ?? []), slip.paperSlipRef]);
  }
  const missing: { type: string; numbers: readonly number[] }[] = [];
  const duplicates: { type: string; ref: string; count: number }[] = [];
  let range: TypedContinuity['range'] = null;
  for (const [type, refs] of byType) {
    const report = analyzeContinuity(refs);
    if (report.missingNumbers.length > 0) missing.push({ type, numbers: report.missingNumbers });
    for (const duplicate of report.duplicates) duplicates.push({ type, ...duplicate });
    if (report.minNumber !== null && report.maxNumber !== null) {
      range = { min: report.minNumber, max: report.maxNumber };
    }
  }
  return {
    totalCount: slips.length,
    range: byType.size === 1 ? range : null,
    missing,
    missingCount: missing.reduce((sum, entry) => sum + entry.numbers.length, 0),
    duplicates,
  };
}

/**
 * Vérifie une nouvelle référence en cours de saisie par rapport aux références déjà enregistrées.
 */
export function checkInputContinuity(
  candidateRef: string,
  existingRefs: readonly string[],
): InputContinuityCheck {
  const cleanCandidate = normalizeSlipRef(candidateRef);
  if (!cleanCandidate) {
    return { isDuplicate: false, isGap: false, missingBefore: [], lastMaxNumber: null };
  }

  const isDuplicate = existingRefs.some((r) => normalizeSlipRef(r) === cleanCandidate);
  const candidateNum = extractSlipNumber(cleanCandidate);

  const existingNumbers: number[] = [];
  for (const r of existingRefs) {
    const num = extractSlipNumber(r);
    if (num !== null) existingNumbers.push(num);
  }

  if (existingNumbers.length === 0 || candidateNum === null) {
    return { isDuplicate, isGap: false, missingBefore: [], lastMaxNumber: null };
  }

  const lastMax = Math.max(...existingNumbers);
  const missingBefore: number[] = [];

  if (candidateNum > lastMax + 1) {
    const start = lastMax + 1;
    const end = Math.min(candidateNum, lastMax + 100); // Plafond à 100 sauts signalés
    for (let i = start; i < end; i += 1) {
      missingBefore.push(i);
    }
  }

  return {
    isDuplicate,
    isGap: missingBefore.length > 0,
    missingBefore,
    lastMaxNumber: lastMax,
  };
}

/**
 * Évalue la fenêtre d'antidatage (AV-078, BR-SYN-012) : l'écart entre l'heure de la pièce et maintenant, contre la fenêtre
 * des paramètres `sync.justification_after_hours` et `sync.backdate_max_hours` (24 h et 72 h par défaut). Même
 * calcul que le serveur (`@gic/domain`).
 */
export function evaluateBackdating(
  occurredAtIso: string,
  now: Date = new Date(),
  window: BackdatingWindow = backdatingWindowFrom(undefined, undefined),
): BackdatingEvaluation {
  const occurredMs = Date.parse(occurredAtIso);
  if (Number.isNaN(occurredMs)) {
    return {
      diffHours: 0,
      isBackdated: false,
      isCriticalDelay: false,
      isFuture: false,
      requiresReason: false,
    };
  }

  const evaluation = evaluateBackdatingGap(now.getTime() - occurredMs, window);
  return {
    diffHours: evaluation.gapHours,
    isBackdated: evaluation.requiresReason,
    isCriticalDelay: evaluation.exceedsWindow,
    isFuture: evaluation.gapHours < -0.25, // 15 min de tolérance d'horloge
    requiresReason: evaluation.requiresReason,
  };
}

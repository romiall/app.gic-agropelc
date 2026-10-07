/**
 * Aides de calcul et de présentation de l'accueil par rôle (ADR-030) : jours métier (UTC pur sur la
 * chaîne `AAAA-MM-JJ`, le jour métier de Douala étant déjà fixé par `businessDayOf`), montants en
 * français, variations et indicateurs.
 */
import type { HomeKpi, HomeSignal, HomeTone, HomeUnit } from '@gic/contracts';

/** Décale un jour métier de `days` jours (négatif : passé). */
export function shiftDay(day: string, days: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Lundi de la semaine du jour métier (BR-ANA-002 : semaine du lundi au dimanche). */
export function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

/** Les `count` derniers jours métier, du plus ancien au plus récent, `day` compris. */
export function lastDays(day: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => shiftDay(day, index - (count - 1)));
}

/** « 1 250 000 F » : séparateur de milliers insécable, sans décimale (XAF entiers, ADR-013). */
export function formatXaf(value: number): string {
  return `${Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0F`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

export function kpi(input: {
  readonly code: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: HomeUnit;
  readonly detail?: string | null;
  readonly delta?: HomeKpi['delta'];
  readonly series?: HomeKpi['series'];
  readonly tone?: HomeTone;
}): HomeKpi {
  return {
    code: input.code,
    label: input.label,
    value: input.value,
    unit: input.unit,
    detail: input.detail ?? null,
    delta: input.delta ?? null,
    series: input.series ?? null,
    tone: input.tone ?? 'neutral',
  };
}

/**
 * Variation entre deux valeurs d'une même période de comparaison. `upIsGood` : une hausse est
 * favorable (chiffre d'affaires) ou non (créances). Sans valeur de référence (`previous` nul ou
 * absent), aucune variation n'est calculée : un pourcentage sur zéro n'a pas de sens.
 */
export function variation(
  current: number,
  previous: number,
  label: string,
  upIsGood = true,
): HomeKpi['delta'] {
  if (previous <= 0) return null;
  const percent = Math.round(((current - previous) / previous) * 100);
  const direction = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat';
  const tone: HomeTone =
    direction === 'flat' ? 'neutral' : (direction === 'up') === upIsGood ? 'good' : 'bad';
  return {
    label: `${percent > 0 ? '+' : ''}${percent} % ${label}`,
    direction,
    tone,
  };
}

export function signal(input: {
  readonly code: string;
  readonly severity: HomeSignal['severity'];
  readonly title: string;
  readonly detail?: string | null;
  readonly count?: number | null;
  readonly action?: HomeSignal['action'];
}): HomeSignal {
  return {
    code: input.code,
    severity: input.severity,
    title: input.title,
    detail: input.detail ?? null,
    count: input.count ?? null,
    action: input.action ?? null,
  };
}

const SEVERITY_ORDER: Record<HomeSignal['severity'], number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** Signaux triés par gravité (stable : l'ordre d'insertion départage), sans doublon de code. */
export function sortSignals(signals: readonly HomeSignal[]): readonly HomeSignal[] {
  const seen = new Set<string>();
  return signals
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.index - b.index,
    )
    .map(({ item }) => item)
    .filter((item) => (seen.has(item.code) ? false : (seen.add(item.code), true)));
}

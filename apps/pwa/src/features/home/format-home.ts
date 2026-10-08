/**
 * Mise en forme de l'accueil par rôle (ECR-ADM-03) : montants en francs CFA entiers (ADR-013),
 * quantités, jour et heure du fuseau métier `Africa/Douala` (ADR-016). Fonctions pures, sans état.
 */
import type { HomeUnit } from '@gic/contracts';

const BUSINESS_TIME_ZONE = 'Africa/Douala';
const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const INTEGER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** Le séparateur de milliers français est une espace fine insécable : on la rend ordinaire pour la copie. */
const plainSpaces = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ');

/** `null` : valeur non disponible (droit manquant, aucune donnée), affichée « — ». */
export function formatKpiValue(value: number | null, unit: HomeUnit): string {
  if (value === null) return '—';
  switch (unit) {
    case 'XAF':
      return plainSpaces(`${INTEGER.format(Math.round(value))} F CFA`);
    case 'PERCENT':
      return plainSpaces(`${NUMBER.format(value)} %`);
    case 'HEADS':
      return plainSpaces(`${INTEGER.format(value)} ${Math.abs(value) === 1 ? 'tête' : 'têtes'}`);
    case 'KG':
      return plainSpaces(`${NUMBER.format(value)} kg`);
    case 'COUNT':
      return plainSpaces(INTEGER.format(value));
  }
}

/** « mercredi 8 octobre » depuis un jour métier `AAAA-MM-JJ` (aucun décalage de fuseau). */
export function formatBusinessDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

/** « 14:32 » à l'heure de Douala. */
export function formatClockTime(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  return plainSpaces(
    new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: BUSINESS_TIME_ZONE,
    }).format(instant),
  );
}

/** Jour métier (`AAAA-MM-JJ`) d'un instant, à l'heure de Douala. */
function businessDayOfInstant(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: BUSINESS_TIME_ZONE,
  }).format(instant);
}

/** « 14:32 » le jour même, « 6 oct. 14:32 » un autre jour (activité récente). */
export function formatMoment(iso: string, today: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const time = formatClockTime(iso);
  if (businessDayOfInstant(instant) === today) return time;
  const date = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: BUSINESS_TIME_ZONE,
  }).format(instant);
  return plainSpaces(`${date} ${time}`);
}

/** Points d'une courbe miniature dans un cadre `width` × `height` (axe vertical inversé). */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  padding = 3,
): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const stepX = values.length > 1 ? (width - 2 * padding) / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = padding + index * stepX;
      // Courbe plate : trait à mi-hauteur plutôt qu'au bord.
      const ratio = span === 0 ? 0.5 : (value - min) / span;
      const y = height - padding - ratio * (height - 2 * padding);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

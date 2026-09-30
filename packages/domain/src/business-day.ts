/**
 * Jour métier en fuseau `Africa/Douala` (UTC+1, pas d'heure d'été — 00-reference/
 * 00-conventions.md, ADR-016). Le décalage étant fixe, ces conversions sont de
 * l'arithmétique pure, sans dépendance à une base de données de fuseaux horaires
 * (poids nul sur le bundle, NFR-05, et déterministe sur l'appareil comme sur le
 * serveur, K1).
 *
 * Tous les horodatages métier (`occurred_at`, `received_at`…) sont stockés en UTC
 * (`DATETIME(6)`, ADR-023) ; le jour métier n'est qu'une **projection d'affichage et de
 * regroupement** (rapports, performances, caisses et soldes « à date »), jamais une
 * donnée stockée qui ferait autorité.
 */
import { DomainError } from './errors.js';

const DOUALA_OFFSET_MS = 60 * 60 * 1000; // UTC+1, fixe

const BUSINESS_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Jour métier (`AAAA-MM-JJ`) d'un instant, en heure de Douala. */
export function businessDayOf(instant: Date): string {
  const doualaMs = instant.getTime() + DOUALA_OFFSET_MS;
  const douala = new Date(doualaMs);
  const year = douala.getUTCFullYear();
  const month = String(douala.getUTCMonth() + 1).padStart(2, '0');
  const day = String(douala.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseBusinessDay(businessDay: string): { year: number; month: number; day: number } {
  if (!BUSINESS_DAY_RE.test(businessDay)) {
    throw new DomainError(
      `Jour métier invalide (attendu AAAA-MM-JJ) : ${businessDay}`,
      'INVALID_BUSINESS_DAY',
    );
  }
  const [year, month, day] = businessDay.split('-').map(Number) as [number, number, number];
  // Date du calendrier : `2026-02-30` n'existe pas (Date.UTC la reporterait au 2 mars).
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new DomainError(
      `Jour métier invalide (date inexistante) : ${businessDay}`,
      'INVALID_BUSINESS_DAY',
    );
  }
  return { year, month, day };
}

/** Instant UTC du tout début (00:00:00.000, heure de Douala) d'un jour métier. */
export function businessDayStartUtc(businessDay: string): Date {
  const { year, month, day } = parseBusinessDay(businessDay);
  return new Date(Date.UTC(year, month - 1, day) - DOUALA_OFFSET_MS);
}

/** Instant UTC exclusif de fin (minuit suivant, heure de Douala) d'un jour métier. */
export function businessDayEndUtc(businessDay: string): Date {
  const { year, month, day } = parseBusinessDay(businessDay);
  return new Date(Date.UTC(year, month - 1, day + 1) - DOUALA_OFFSET_MS);
}

/** Vrai si `instant` tombe dans le jour métier `businessDay` (borne de fin exclusive). */
export function isWithinBusinessDay(instant: Date, businessDay: string): boolean {
  const t = instant.getTime();
  return (
    t >= businessDayStartUtc(businessDay).getTime() && t < businessDayEndUtc(businessDay).getTime()
  );
}

/** Jour métier suivant (chaîne `AAAA-MM-JJ`), ex. pour la clôture automatique à 23:59 (BR-TER-008). */
export function nextBusinessDay(businessDay: string): string {
  return businessDayOf(businessDayEndUtc(businessDay));
}

/**
 * Jour métier décalé de `days` jours (négatif possible) : péremption d'une collecte (AV-122),
 * échéances d'incubation (BR-INC-008). Douala n'a pas d'heure d'été : un jour = 24 h.
 */
export function addBusinessDays(businessDay: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new DomainError(`Nombre de jours entier attendu : ${days}`, 'INVALID_BUSINESS_DAY');
  }
  return businessDayOf(new Date(businessDayStartUtc(businessDay).getTime() + days * 86_400_000));
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Jours métier d'un mois `AAAA-MM` (répartition des frais généraux, ADR-026), jusqu'à `untilDay`
 * inclus s'il tombe dans le mois (mois en cours : jours écoulés seulement). Vide si `untilDay`
 * précède le mois.
 */
export function businessMonthDays(period: string, untilDay?: string): readonly string[] {
  const match = PERIOD_RE.exec(period);
  if (!match) {
    throw new DomainError(`Période invalide (attendu AAAA-MM) : ${period}`, 'PERIOD_INVALID');
  }
  const days: string[] = [];
  let day = `${period}-01`;
  while (day.startsWith(period) && (untilDay === undefined || day <= untilDay)) {
    days.push(day);
    day = nextBusinessDay(day);
  }
  return days;
}

/** Mois métier `AAAA-MM` d'un jour métier. */
export function periodOfBusinessDay(businessDay: string): string {
  parseBusinessDay(businessDay);
  return businessDay.slice(0, 7);
}

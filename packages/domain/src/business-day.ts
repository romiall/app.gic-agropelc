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

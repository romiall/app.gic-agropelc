/**
 * Pointage terrain et géolocalisation des visites (D03-TER, D02-CRM) : calculs partagés appareil
 * et serveur (ADR-021). L'appareil en tire un résultat immédiat ; le serveur recalcule avec le
 * géorepère en vigueur à `occurred_at` et son résultat fait foi (BR-TER-003). Pur, sans
 * entrée-sortie : l'appelant fournit le géorepère, les seuils (paramètres système, jamais codés
 * en dur — CLAUDE.md règle 8) et l'historique utile.
 */
import { DomainError } from './errors.js';
import type { Geofence } from './geofence.js';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/** Rayon terrestre moyen (UGGI), en mètres. */
const EARTH_RADIUS_M = 6_371_008.8;

/** Distances et précisions : `DECIMAL(8,1)` (conventions §2) — arrondi au décimètre. */
function roundMeters(value: number): number {
  return Math.round(value * 10) / 10;
}

/** BR-TER-012 / §8 D03 : latitude ∈ [−90, 90], longitude ∈ [−180, 180] (`GEO_INVALID`). */
export function assertGeoPoint(point: GeoPoint): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new DomainError('Latitude hors limites (−90 à 90).', 'GEO_INVALID');
  }
  if (!Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
    throw new DomainError('Longitude hors limites (−180 à 180).', 'GEO_INVALID');
  }
}

/** BR-TER-003 : distance orthodromique (haversine), en mètres, arrondie au décimètre. */
export function haversineDistanceM(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return roundMeters(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

export type CheckinResult =
  'ACCEPTED' | 'REJECTED_OUT_OF_ZONE' | 'REJECTED_LOW_ACCURACY' | 'NO_POSITION';

export interface CheckinEvaluation {
  readonly result: CheckinResult;
  /** Nulle seulement sans position. Calculée aussi pour un refus (audit, BR-TER-001). */
  readonly distanceM: number | null;
}

/**
 * BR-TER-002 : `ACCEPTED` si distance ≤ rayon **et** précision ≤ maximum ;
 * `REJECTED_LOW_ACCURACY` si la précision dépasse le maximum — ou est inconnue (DÉDUIT : une
 * précision absente ne peut pas être vérifiée) ; `REJECTED_OUT_OF_ZONE` si la précision est
 * acceptable mais la distance supérieure au rayon ; `NO_POSITION` sans position.
 */
export function evaluateCheckin(input: {
  readonly position: GeoPoint | null;
  readonly accuracyM: number | null;
  readonly geofence: Geofence;
  readonly maxAccuracyM: number;
}): CheckinEvaluation {
  if (input.position === null) return { result: 'NO_POSITION', distanceM: null };
  assertGeoPoint(input.position);
  if (input.accuracyM !== null && (!Number.isFinite(input.accuracyM) || input.accuracyM < 0)) {
    throw new DomainError('Précision GPS invalide (≥ 0 attendue).', 'GEO_INVALID');
  }
  const distanceM = haversineDistanceM(input.position, input.geofence);
  if (input.accuracyM === null || input.accuracyM > input.maxAccuracyM) {
    return { result: 'REJECTED_LOW_ACCURACY', distanceM };
  }
  if (distanceM > input.geofence.radiusM) return { result: 'REJECTED_OUT_OF_ZONE', distanceM };
  return { result: 'ACCEPTED', distanceM };
}

/**
 * BR-TER-005 : après au moins `minAttempts` refus étalés sur au moins `minMinutes`, une
 * dérogation peut être demandée. `rejectedAt` : instants des tentatives refusées depuis la
 * dernière prise de service acceptée (l'appelant les sélectionne).
 */
export function canRequestOverride(
  rejectedAt: readonly Date[],
  minAttempts: number,
  minMinutes: number,
): boolean {
  if (rejectedAt.length < minAttempts) return false;
  const times = rejectedAt.map((d) => d.getTime());
  const spanMs = Math.max(...times) - Math.min(...times);
  return spanMs >= minMinutes * 60_000;
}

export type CheckinSuspicionFlag =
  'SPEED_IMPLAUSIBLE' | 'ACCURACY_ZERO' | 'COORDINATES_REPEATED' | 'ACCURACY_REPEATED';

/**
 * BR-TER-010 : signaux `CHECKIN_SUSPICIOUS` (limite L-02 — ils signalent, ne bloquent jamais).
 * - vitesse implicite depuis la position précédente de l'utilisateur > `maxSpeedKmh` ;
 * - précision exactement nulle ;
 * - coordonnées identiques au mètre près à une position d'un **autre jour** ;
 * - même précision sur plus de `repeatedAccuracyCount` pointages consécutifs (courant compris).
 */
export function detectCheckinSuspicion(input: {
  readonly position: GeoPoint | null;
  readonly accuracyM: number | null;
  readonly occurredAt: Date;
  /** Dernière position connue de l'utilisateur (pointage, visite, vente terrain), antérieure. */
  readonly previous: { readonly position: GeoPoint; readonly occurredAt: Date } | null;
  /** Positions de pointages de l'utilisateur à d'autres jours métier (l'appelant les borne). */
  readonly otherDayPositions: readonly GeoPoint[];
  /** Précisions des pointages précédents, du plus récent au plus ancien. */
  readonly previousAccuracies: readonly (number | null)[];
  readonly maxSpeedKmh: number;
  readonly repeatedAccuracyCount: number;
}): readonly CheckinSuspicionFlag[] {
  const flags: CheckinSuspicionFlag[] = [];
  if (input.position === null) return flags;

  if (input.previous !== null) {
    const distanceM = haversineDistanceM(input.previous.position, input.position);
    // Au moins une seconde : deux positions simultanées et distinctes restent « impossibles ».
    const seconds = Math.max(
      1,
      Math.abs(input.occurredAt.getTime() - input.previous.occurredAt.getTime()) / 1000,
    );
    if ((distanceM / seconds) * 3.6 > input.maxSpeedKmh) flags.push('SPEED_IMPLAUSIBLE');
  }
  if (input.accuracyM === 0) flags.push('ACCURACY_ZERO');
  if (input.otherDayPositions.some((p) => haversineDistanceM(p, input.position!) < 1)) {
    flags.push('COORDINATES_REPEATED');
  }
  if (input.accuracyM !== null) {
    let identical = 1; // le pointage courant
    for (const previous of input.previousAccuracies) {
      if (previous !== input.accuracyM) break;
      identical++;
    }
    if (identical > input.repeatedAccuracyCount) flags.push('ACCURACY_REPEATED');
  }
  return flags;
}

export type VisitFlag = 'OUT_OF_SESSION' | 'FAR_FROM_CUSTOMER' | 'SESSION_REJECTED';

/**
 * BR-CRM-012, 013, 015 : distance de la visite au compte (si les deux sont géolocalisés) et
 * indicateurs — hors session de travail, loin du compte (> `maxDistanceM`), session dont la
 * dérogation a été rejetée (SM-WORK-SESSION). Signalent, ne bloquent jamais (AV-023).
 */
export function evaluateVisit(input: {
  readonly visitPosition: GeoPoint | null;
  readonly customerPosition: GeoPoint | null;
  readonly maxDistanceM: number;
  readonly session: 'NONE' | 'OPEN' | 'OPEN_REJECTED';
}): { readonly distanceToCustomerM: number | null; readonly flags: readonly VisitFlag[] } {
  const flags: VisitFlag[] = [];
  if (input.session === 'NONE') flags.push('OUT_OF_SESSION');
  if (input.session === 'OPEN_REJECTED') flags.push('SESSION_REJECTED');
  let distanceToCustomerM: number | null = null;
  if (input.visitPosition !== null && input.customerPosition !== null) {
    assertGeoPoint(input.visitPosition);
    distanceToCustomerM = haversineDistanceM(input.visitPosition, input.customerPosition);
    if (distanceToCustomerM > input.maxDistanceM) flags.push('FAR_FROM_CUSTOMER');
  }
  return { distanceToCustomerM, flags };
}

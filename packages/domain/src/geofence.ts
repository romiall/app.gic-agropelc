/**
 * Géorepère d'une zone (organization.zones, BR-ADM-012 ; docs/03-data/dictionnaire/
 * 02-organization.md) : point de référence + rayon, « ensemble ou pas du tout ». Le défaut
 * de rayon (500 m) s'applique ici, jamais comme `DEFAULT` de colonne — un défaut de colonne
 * s'appliquerait aussi en l'absence de tout géorepère (lat/lng nuls), ce qui violerait la
 * règle « ensemble ou pas du tout ». Même calcul appareil et serveur (ADR-021).
 */
import { DomainError } from './errors.js';

export interface Geofence {
  readonly lat: number;
  readonly lng: number;
  readonly radiusM: number;
}

export interface GeofenceInput {
  readonly lat?: number | null;
  readonly lng?: number | null;
  readonly radiusM?: number | null;
}

const DEFAULT_RADIUS_M = 500;
const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 5000;

/** `null` si aucun géorepère fourni (ni latitude ni longitude) ; valide et applique le rayon par défaut sinon. */
export function buildGeofence(input: GeofenceInput): Geofence | null {
  const hasLat = input.lat !== undefined && input.lat !== null;
  const hasLng = input.lng !== undefined && input.lng !== null;
  if (!hasLat && !hasLng) return null;
  if (hasLat !== hasLng) {
    throw new DomainError(
      'Un géorepère exige latitude et longitude ensemble (ou aucune des deux).',
      'GEOFENCE_INVALID',
    );
  }
  const lat = input.lat as number;
  const lng = input.lng as number;
  if (lat < -90 || lat > 90) {
    throw new DomainError('Latitude hors limites (-90 à 90).', 'GEOFENCE_INVALID');
  }
  if (lng < -180 || lng > 180) {
    throw new DomainError('Longitude hors limites (-180 à 180).', 'GEOFENCE_INVALID');
  }
  const radiusM = input.radiusM ?? DEFAULT_RADIUS_M;
  if (radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
    throw new DomainError(
      `Rayon hors limites (${MIN_RADIUS_M} à ${MAX_RADIUS_M} m).`,
      'GEOFENCE_INVALID',
    );
  }
  return { lat, lng, radiusM };
}

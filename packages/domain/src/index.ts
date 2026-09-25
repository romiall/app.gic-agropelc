// Bibliothèque métier partagée (appareil + serveur), sans entrée-sortie — ADR-021.
// Portée de P0-02 : identifiants, horloge, argent, quantités, jour métier, arrondis.
// P0-11 : géorepère (organization.zones, BR-ADM-012).
// Le moteur de prix, l'évaluation des politiques et les calculs de disponibilité
// arrivent avec les modules qui les motivent (pricing en P1, inventory en P2).

export { DomainError, assertSafeInteger } from './errors.js';

export type { Clock } from './clock.js';
export { FixedClock } from './clock.js';
export { SystemClock } from './system-clock.js';

export type { IdGenerator } from './id.js';
export {
  buildUuidv7,
  isUuidv7,
  extractUuidv7Timestamp,
  checkClientProvidedUuidv7,
  uuidToBin,
  binToUuid,
} from './uuid.js';
export type { ClientProvidedIdCheck } from './uuid.js';
export { Uuidv7Generator } from './uuidv7-generator.js';

export type { Xaf } from './money.js';
export {
  xaf,
  ZERO_XAF,
  addXaf,
  differenceXaf,
  splitSignedXaf,
  compareXaf,
  formatXaf,
} from './money.js';

export type { Quantity } from './quantity.js';
export {
  quantityFromDecimal,
  quantityFromMilli,
  ZERO_QUANTITY,
  quantityMilliUnits,
  quantityToDecimal,
  addQuantity,
  subtractQuantity,
  isPositiveQuantity,
  isZeroQuantity,
  isWholeQuantity,
  compareQuantity,
  formatQuantity,
} from './quantity.js';

export {
  businessDayOf,
  businessDayStartUtc,
  businessDayEndUtc,
  isWithinBusinessDay,
  nextBusinessDay,
} from './business-day.js';

export { roundHalfUpMilliXafToFranc, lineAmountXaf } from './rounding.js';

export type { Geofence, GeofenceInput } from './geofence.js';
export { buildGeofence } from './geofence.js';

export { CLOCK_SKEW_SUSPECT_MS, isClockSkewSuspect } from './clock-skew.js';

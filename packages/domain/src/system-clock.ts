import type { Clock } from './clock.js';

/**
 * Implémentation concrète de {@link Clock} adossée à l'horloge système.
 *
 * Seul fichier de `packages/domain` autorisé à lire `Date` directement (exclusion
 * explicite dans eslint.config.mjs) : c'est le point de composition unique, branché par
 * `apps/server` (horloge NTP) et `apps/pwa` (horloge de l'appareil). Aucun autre module
 * ne doit importer ce fichier — il importe `Clock` et reçoit une instance par injection.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

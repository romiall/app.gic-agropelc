import type { Clock } from './clock.js';
import type { IdGenerator } from './id.js';
import { buildUuidv7 } from './uuid.js';

/**
 * Implémentation de {@link IdGenerator} : UUIDv7 construit à partir de l'horloge
 * injectée et de `crypto.getRandomValues` (Web Crypto, disponible nativement dans
 * Node.js ≥ 19 et dans tous les navigateurs ciblés — aucune dépendance, K1).
 */
export class Uuidv7Generator implements IdGenerator {
  constructor(private readonly clock: Clock) {}

  newId(): string {
    const random = new Uint8Array(10);
    globalThis.crypto.getRandomValues(random);
    return buildUuidv7(this.clock.now().getTime(), random);
  }
}

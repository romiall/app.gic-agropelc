/**
 * Racine de composition (ADR-021, K1) : seul point de l'appareil qui instancie les
 * implémentations concrètes de `@gic/domain` (horloge système, générateur UUIDv7) — le reste
 * du code appareil les reçoit par injection, jamais `new Date()` ni `crypto.randomUUID()`
 * directement (règle ESLint `packages/domain`, étendue ici par discipline même si non
 * imposée par lint hors de ce paquet).
 */
import { SystemClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';

export const clock: Clock = new SystemClock();
export const idGenerator: IdGenerator = new Uuidv7Generator(clock);

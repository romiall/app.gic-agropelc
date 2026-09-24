/**
 * Composition racine de l'horloge (packages/domain/src/system-clock.ts) : seul point du
 * serveur qui construit un `SystemClock`. Les tests substituent ce fournisseur par un
 * `FixedClock` (@gic/domain) via `overrideProvider(CLOCK)`.
 */
import type { Provider } from '@nestjs/common';
import type { Clock } from '@gic/domain';
import { SystemClock } from '@gic/domain';

export const CLOCK = Symbol('CLOCK');

export const clockProvider: Provider = {
  provide: CLOCK,
  useValue: new SystemClock() satisfies Clock,
};

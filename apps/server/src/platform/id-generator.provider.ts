import type { Provider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import { Uuidv7Generator } from '@gic/domain';
import { CLOCK } from './clock.provider.js';

export const ID_GENERATOR = Symbol('ID_GENERATOR');

export const idGeneratorProvider: Provider = {
  provide: ID_GENERATOR,
  useFactory: (clock: Clock): IdGenerator => new Uuidv7Generator(clock),
  inject: [CLOCK],
};

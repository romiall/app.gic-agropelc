import type { Provider } from '@nestjs/common';
import { loadEnv } from './env.js';

export const ENV = Symbol('ENV');

export const envProvider: Provider = {
  provide: ENV,
  useValue: loadEnv(),
};

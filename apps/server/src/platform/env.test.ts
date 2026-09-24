import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const BASE = { SERVER_DATABASE_URL: 'mysql://gic_app:x@127.0.0.1:3306/db' };

describe('loadEnv (01-architecture-logicielle.md §7 « Configuration »)', () => {
  it('applique les valeurs par défaut hors production', () => {
    const env = loadEnv(BASE);
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, HOST: '0.0.0.0' });
  });

  it('rejette une configuration sans SERVER_DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/Configuration invalide/);
  });

  it('accepte development/test sans clés JWT (paire éphémère, jwt-keys.provider.ts)', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'test' })).not.toThrow();
  });

  it('refuse la production sans JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (aucune clé éphémère en production)', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(
      /JWT_PRIVATE_KEY et JWT_PUBLIC_KEY sont obligatoires en production/,
    );
  });

  it('accepte la production avec les deux clés JWT fournies', () => {
    expect(() =>
      loadEnv({ ...BASE, NODE_ENV: 'production', JWT_PRIVATE_KEY: 'pk', JWT_PUBLIC_KEY: 'pub' }),
    ).not.toThrow();
  });
});

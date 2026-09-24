/**
 * Composition racine de la connexion Kysely + pool mysql2 (`SERVER_DATABASE_URL`,
 * identifiants `gic_app`, distincts de `DATABASE_URL` réservée aux migrations : voir
 * env.ts). Le pool est fermé à l'arrêt du module (tests compris).
 */
import { Inject, Injectable, type OnModuleDestroy, type Provider } from '@nestjs/common';
import type { Pool } from 'mysql2';
import type { Env } from '../env.js';
import { ENV } from '../env.provider.js';
import { createDatabase, type Database } from './database.js';

export { type Database } from './database.js';
export const DATABASE = Symbol('DATABASE');
const DATABASE_POOL = Symbol('DATABASE_POOL');

@Injectable()
class DatabaseLifecycle implements OnModuleDestroy {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.pool.end((error) => (error ? reject(error) : resolve()));
    });
  }
}

const HOLDER = Symbol('DATABASE_HOLDER');

export const databaseProviders: Provider[] = [
  {
    provide: HOLDER,
    useFactory: (env: Env) => createDatabase(env.SERVER_DATABASE_URL),
    inject: [ENV],
  },
  {
    provide: DATABASE,
    useFactory: (holder: { db: Database }) => holder.db,
    inject: [HOLDER],
  },
  {
    provide: DATABASE_POOL,
    useFactory: (holder: { pool: Pool }) => holder.pool,
    inject: [HOLDER],
  },
  DatabaseLifecycle,
];

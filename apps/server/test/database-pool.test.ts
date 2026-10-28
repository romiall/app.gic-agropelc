/**
 * Taille du pool de connexions (P9-25, EP-2) : le paramètre `connectionLimit` de l'URI `SERVER_DATABASE_URL`
 * fixe la taille du pool de `createDatabase` (10 par défaut, pilote mysql2). Fige la procédure documentée dans
 * `.env.example` contre une mise à jour du pilote. Essai sans base : le pool est paresseux, aucune connexion
 * n'est ouverte.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2';
import { createDatabase } from '../src/platform/kysely/database.js';

const connectionLimitOf = (pool: Pool): number =>
  (pool as unknown as { config: { connectionLimit: number } }).config.connectionLimit;

const closePool = (pool: Pool): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    pool.end((error) => (error ? reject(error) : resolve()));
  });

describe('taille du pool de connexions', () => {
  it('10 connexions par défaut', async () => {
    const { pool } = createDatabase('mysql://u:p@127.0.0.1:3306/d');
    try {
      expect(connectionLimitOf(pool)).toBe(10);
    } finally {
      await closePool(pool);
    }
  });

  it('le paramètre connectionLimit de l’URI fixe la taille', async () => {
    const { pool } = createDatabase('mysql://u:p@127.0.0.1:3306/d?connectionLimit=3');
    try {
      expect(connectionLimitOf(pool)).toBe(3);
    } finally {
      await closePool(pool);
    }
  });
});

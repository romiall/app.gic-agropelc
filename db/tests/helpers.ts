// Utilitaires des tests d'intégration : connexion à DATABASE_URL (déjà migré),
// exécution de chaque test dans une transaction annulée à la fin (isolation, y compris
// vis-à-vis des déclencheurs BEFORE DELETE qui empêchent tout nettoyage a posteriori par
// simple DELETE — voir db/README.md §5).
import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL non définie : ces tests exigent une base MySQL déjà migrée (voir db/README.md).',
  );
}

const pool = mysql.createPool(DATABASE_URL);

/** Exécute `fn(connection)` dans une transaction toujours annulée (ROLLBACK) à la fin. */
export async function withRollback<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      return await fn(conn);
    } finally {
      await conn.rollback();
    }
  } finally {
    conn.release();
  }
}

/** 16 octets pseudo-aléatoires valides pour une colonne BINARY(16) (pas un vrai UUIDv7 :
 * ces tests portent sur le SQL, pas sur packages/domain, qui a ses propres tests). */
export function randomId(): Buffer {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export async function closePool(): Promise<void> {
  await pool.end();
}

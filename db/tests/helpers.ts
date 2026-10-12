// Utilitaires des tests d'intégration : connexion à DATABASE_URL (déjà migré),
// exécution de chaque test dans une transaction annulée à la fin (isolation, y compris
// vis-à-vis des déclencheurs BEFORE DELETE qui empêchent tout nettoyage a posteriori par
// simple DELETE — voir db/README.md §5).
import { randomInt } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { poolUtc } from '../seeds/connection.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL non définie : ces tests exigent une base MySQL déjà migrée (voir db/README.md).',
  );
}

const pool = poolUtc(DATABASE_URL);

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

const MAX_DRAWS = 20;
/** Valeurs déjà délivrées par ce processus, par espace (`phone`, `short_code`). */
const issued = new Map<string, Set<string>>();

/**
 * Tire jusqu'à une valeur jamais délivrée par ce processus et absente de la base. Chaque test tourne
 * dans une transaction annulée, mais les index uniques voient les fixtures **validées** de la base
 * partagée (tests serveur, exécutions précédentes : des milliers de lignes) : un tirage brut y
 * collisionnait à l'échelle d'une suite.
 */
async function freshValue(
  space: string,
  draw: () => string,
  taken: (value: string) => Promise<boolean>,
): Promise<string> {
  const seen = issued.get(space) ?? new Set<string>();
  issued.set(space, seen);
  for (let attempt = 1; attempt <= MAX_DRAWS; attempt++) {
    const value = draw();
    if (seen.has(value)) continue;
    seen.add(value);
    if (!(await taken(value))) return value;
  }
  throw new Error(`Aucune valeur de test libre (${space}) après ${MAX_DRAWS} tirages.`);
}

async function exists(
  conn: mysql.PoolConnection,
  query: string,
  params: unknown[],
): Promise<boolean> {
  const [rows] = await conn.query(query, params);
  return (rows as unknown[]).length > 0;
}

/** Numéro E.164 camerounais de test : `+2376` puis 8 chiffres (aléa cryptographique). */
export function drawPhone(): string {
  return `+2376${String(randomInt(100_000_000)).padStart(8, '0')}`;
}

/**
 * Téléphone de test libre : ni porté par un utilisateur non désactivé
 * (`uq_identity_users_active_phone`) ni par un client (principal ou secondaire ;
 * `uq_crm_customers_phone`), vu de la transaction du test.
 */
export async function freshPhone(
  conn: mysql.PoolConnection,
  draw: () => string = drawPhone,
): Promise<string> {
  return freshValue('phone', draw, (phone) =>
    exists(
      conn,
      `SELECT 1 FROM identity_users WHERE active_phone = ?
       UNION ALL
       SELECT 1 FROM crm_customers WHERE phone_primary = ? OR phone_secondary = ?
       LIMIT 1`,
      [phone, phone, phone],
    ),
  );
}

const SHORT_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Code court d'appareil de test : 4 caractères `[A-Z0-9]` (aléa cryptographique). */
export function drawShortCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += SHORT_CODE_CHARS[randomInt(SHORT_CODE_CHARS.length)];
  return code;
}

/** Code court d'appareil libre (`uq_identity_devices_short_code`, 36^4 codes seulement). */
export async function freshShortCode(
  conn: mysql.PoolConnection,
  draw: () => string = drawShortCode,
): Promise<string> {
  return freshValue('short_code', draw, (code) =>
    exists(conn, 'SELECT 1 FROM identity_devices WHERE short_code = ? LIMIT 1', [code]),
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}

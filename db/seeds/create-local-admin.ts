/**
 * Développement local uniquement : crée un utilisateur ADMIN utilisable pour se connecter à
 * la PWA après `db:migrate` + `db:seed` (le seed P0-05 ne crée que le bootstrap `is_system`,
 * sans mot de passe utilisable — 07-security-rbac/02-securite.md §2, ADR-023 §1 « admin » /
 * `gic_app`). Idempotent : ne recrée rien si le téléphone existe déjà, mais met alors à jour
 * le mot de passe (pratique en local si on relance ce script après avoir oublié le sien).
 *
 * Usage : `DATABASE_URL=... pnpm --filter @gic/db run create-local-admin -- <téléphone> <mot de passe>`
 * (valeurs par défaut si omises — voir ci-dessous).
 */
import mysql from 'mysql2/promise';
import { hash } from '@node-rs/argon2';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL non définie (voir db/README.md).');
}

const ARGON2ID = 2; // Algorithm.Argon2id — const enum, valeur brute (voir password.ts serveur)
const ARGON2ID_OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

// `--` isolé : artefact possible du transfert d'arguments à travers deux niveaux de scripts
// pnpm (`pnpm run db:create-local-admin -- <tel> <mdp>` → `pnpm --filter @gic/db run
// create-local-admin --` → ce script) — jamais une valeur voulue pour le téléphone/mot de passe.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const phone = args[0] ?? '+237600000001';
const password = args[1] ?? 'ChangeMe123!';

function randomId(): Buffer {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

async function main(): Promise<void> {
  const conn = await mysql.createConnection(DATABASE_URL!);
  try {
    const passwordHash = await hash(password, ARGON2ID_OPTIONS);

    const [existing] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT id FROM identity_users WHERE phone = ?',
      [phone],
    );

    let userId: Buffer;
    if (existing.length > 0) {
      userId = existing[0]!.id as Buffer;
      await conn.query('UPDATE identity_users SET password_hash = ? WHERE id = ?', [
        passwordHash,
        userId,
      ]);
      console.log(`  ~ identity_users : mot de passe mis à jour pour ${phone}`);
    } else {
      userId = randomId();
      await conn.query(
        `INSERT INTO identity_users (id, full_name, phone, password_hash, status, locale, created_by)
         VALUES (?, 'Administrateur local', ?, ?, 'ACTIVE', 'fr-CM', ?)`,
        [userId, phone, passwordHash, userId],
      );
      console.log(`  + identity_users : ${phone} créé`);
    }

    const [[role]] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT id FROM identity_roles WHERE code = 'ADMIN' LIMIT 1",
    );
    if (!role) {
      throw new Error("Rôle ADMIN introuvable : lancer 'pnpm run db:seed' avant ce script.");
    }

    const [[assignment]] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT id FROM identity_user_role_assignments
       WHERE user_id = ? AND role_id = ? AND scope_type = 'GLOBAL' AND revoked_at IS NULL
       LIMIT 1`,
      [userId, role.id],
    );
    if (!assignment) {
      await conn.query(
        `INSERT INTO identity_user_role_assignments
           (id, user_id, role_id, scope_type, valid_from, created_by)
         VALUES (?, ?, ?, 'GLOBAL', '2020-01-01 00:00:00', ?)`,
        [randomId(), userId, role.id, userId],
      );
      console.log('  + identity_user_role_assignments : ADMIN (GLOBAL) affecté');
    }

    console.log('\nIdentifiants de connexion locale (PWA) :');
    console.log(`  Téléphone     : ${phone}`);
    console.log(`  Mot de passe  : ${password}`);
  } finally {
    await conn.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

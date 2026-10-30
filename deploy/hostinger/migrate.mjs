// Applique les migrations de db/migrations sur la base de l'hebergement (Hostinger, MariaDB 11.8).
// dbmate n'existe pas sur l'hebergement : meme table de suivi (schema_migrations.version), meme format
// (-- migrate:up / -- migrate:down). Adaptations a MariaDB et a l'utilisateur de base de donnees unique :
//   - les lignes GRANT / REVOKE vers 'gic_app' sont retirees (l'hebergement n'a qu'un seul utilisateur) ;
//   - DROP CHECK devient DROP CONSTRAINT (syntaxe MariaDB).
// Usage : node --env-file=.env migrate.mjs [--dir ./db/migrations]
//         node deploy/hostinger/migrate.mjs --dry-run [--since 20261201090600] [--dir db/migrations]
// L'essai a blanc n'ouvre aucune connexion : il affiche le SQL qui serait execute.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const dryRun = args.includes('--dry-run');
const dir = valueOf('--dir', './db/migrations');
const since = valueOf('--since', '');

export function upSqlOf(raw, file) {
  const parts = raw.split(/^--\s*migrate:up.*$/m);
  if (parts.length < 2) throw new Error('Pas de migrate:up dans ' + file);
  const up = parts[1].split(/^--\s*migrate:down.*$/m)[0];
  return up
    .split('\n')
    .filter((line) => !/^\s*(GRANT|REVOKE)\s+.*\b(TO|FROM)\b\s+'gic_app'/i.test(line))
    .join('\n')
    .replace(/\bDROP\s+CHECK\b/gi, 'DROP CONSTRAINT');
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (dryRun) {
  let shown = 0;
  for (const file of files) {
    const version = file.split('_')[0];
    if (since && version <= since) continue;
    const sql = upSqlOf(fs.readFileSync(path.join(dir, file), 'utf8'), file).trim();
    shown += 1;
    console.log(
      '--- ' + file + (sql ? '' : ' (rien a executer : seule la version est enregistree)'),
    );
    if (sql) console.log(sql.length > 900 ? sql.slice(0, 900) + '\n[...]' : sql);
  }
  console.log('--- ' + shown + ' migration(s) listee(s), aucune connexion ouverte.');
  process.exit(0);
}

const { default: mysql } = await import('mysql2/promise');
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL absente (lancer avec --env-file=.env).');
const conn = await mysql.createConnection({
  uri: process.env.DATABASE_URL,
  multipleStatements: true,
  timezone: 'Z',
});
await conn.query("SET time_zone = '+00:00'");
await conn.query(
  'CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(128) PRIMARY KEY) ENGINE=InnoDB',
);
const [appliedRows] = await conn.query('SELECT version FROM schema_migrations');
const applied = new Set(appliedRows.map((r) => r.version));

let count = 0;
for (const file of files) {
  const version = file.split('_')[0];
  if (applied.has(version)) continue;
  const sql = upSqlOf(fs.readFileSync(path.join(dir, file), 'utf8'), file);
  if (sql.trim()) {
    try {
      await conn.query(sql);
    } catch (err) {
      console.error('ECHEC sur ' + file + ' : ' + err.message);
      await conn.end();
      process.exit(1);
    }
  }
  await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
  count += 1;
  console.log('Appliquee : ' + file);
}
console.log(count === 0 ? 'Aucune migration a appliquer.' : count + ' migration(s) appliquee(s).');
await conn.end();

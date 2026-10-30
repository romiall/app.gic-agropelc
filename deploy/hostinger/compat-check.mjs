/**
 * Controle de compatibilite SQL sur la base REELLE, avant le redemarrage de l'application. Execute sur le serveur
 * par remote-update.sh (node --env-file=.env compat-check.mjs) ; un echec declenche le retour a la version precedente.
 *
 * Il rejoue, sur une table temporaire (rien n'est ecrit dans les tables de l'application), les ecritures et lectures
 * que le serveur fait le plus souvent, avec le vrai `jsonValue` du code construit et la couche mariadb-compat.mjs :
 *   - ecriture d'une colonne JSON (audit, evenements, commandes, taches) et relecture ;
 *   - lecture verrouillante en partage (`.forShare()`) et en ecriture (`.forUpdate()`) ;
 *   - ecriture JSON dans un ON DUPLICATE KEY UPDATE ;
 *   - JSON_OVERLAPS (avertissement seulement : n'est utilise que par les vues enregistrees de l'analyse).
 * Le 30/10/2026, la mise en ligne a casse la connexion et l'ordonnanceur faute de ce controle : MariaDB refuse
 * CAST(? AS JSON) et FOR SHARE (voir README.md, section sur la compatibilite MariaDB).
 */
import assert from 'node:assert/strict';
import { createPool } from 'mysql2';
import { Kysely, MysqlDialect, DefaultQueryCompiler, sql } from 'kysely';
import { installMariaDbCompat } from './mariadb-compat.mjs';
import { jsonValue } from './dist/platform/kysely/json-value.js';

const url = process.env.SERVER_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('SERVER_DATABASE_URL (ou DATABASE_URL) absent du .env.');

installMariaDbCompat(DefaultQueryCompiler);
const pool = createPool({ uri: url, timezone: 'Z', connectionLimit: 1 });
const db = new Kysely({ dialect: new MysqlDialect({ pool }) });

const failures = [];
const warnings = [];
async function step(name, run, required = true) {
  try {
    await run();
    console.log('  ok  ' + name);
  } catch (error) {
    const line = name + ' : ' + (error instanceof Error ? error.message : String(error));
    (required ? failures : warnings).push(line);
    console.log((required ? '  ECHEC  ' : '  avertissement  ') + line);
  }
}

try {
  await db.connection().execute(async (c) => {
    await step('table temporaire (droit CREATE TEMPORARY TABLES)', async () => {
      await sql`create temporary table _gic_compat_probe (id int not null primary key, j json not null)`.execute(
        c,
      );
    });
    // Une lettre accentuee (e aigu, code 233) : l'encodage doit survivre a l'aller-retour.
    const document = { roles: ['ADMIN'], note: 'caf' + String.fromCharCode(233), n: 12 };
    await step('ecriture JSON (jsonValue)', async () => {
      await c
        .insertInto('_gic_compat_probe')
        .values({ id: 1, j: jsonValue(document) })
        .execute();
    });
    await step('relecture JSON et lecture verrouillante en partage (forShare)', async () => {
      const row = await c
        .selectFrom('_gic_compat_probe')
        .select(['id', 'j'])
        .where('id', '=', 1)
        .forShare()
        .executeTakeFirstOrThrow();
      console.log(
        '      colonne JSON relue en ' +
          (typeof row.j === 'string' ? 'texte (MariaDB)' : 'objet (MySQL)'),
      );
      assert.deepEqual(typeof row.j === 'string' ? JSON.parse(row.j) : row.j, document);
    });
    await step('lecture verrouillante en ecriture (forUpdate)', async () => {
      await c
        .selectFrom('_gic_compat_probe')
        .select('id')
        .where('id', '=', 1)
        .forUpdate()
        .executeTakeFirstOrThrow();
    });
    await step('ON DUPLICATE KEY UPDATE avec une colonne JSON', async () => {
      await c
        .insertInto('_gic_compat_probe')
        .values({ id: 1, j: jsonValue([]) })
        .onDuplicateKeyUpdate({ j: jsonValue(['ADMIN', 'DIRECTION']) })
        .execute();
    });
    await step(
      "JSON_OVERLAPS (vues enregistrees de l'analyse)",
      async () => {
        const row = await c
          .selectFrom('_gic_compat_probe')
          .select('id')
          .where(sql`JSON_OVERLAPS(j, CAST(${JSON.stringify(['ADMIN'])} AS JSON))`)
          .executeTakeFirst();
        assert.ok(row, 'aucune ligne trouvee');
      },
      false,
    );
    await sql`drop temporary table if exists _gic_compat_probe`.execute(c);
  });
} catch (error) {
  failures.push(
    'connexion a la base : ' + (error instanceof Error ? error.message : String(error)),
  );
} finally {
  await db.destroy().catch(() => undefined);
}

for (const w of warnings) console.log('AVERTISSEMENT : ' + w);
if (failures.length > 0) {
  console.log('ECHEC du controle de compatibilite SQL (' + failures.length + ').');
  process.exit(1);
}
console.log(
  'Compatibilite SQL : OK' +
    (warnings.length > 0 ? ' (avec ' + warnings.length + ' avertissement)' : '') +
    '.',
);

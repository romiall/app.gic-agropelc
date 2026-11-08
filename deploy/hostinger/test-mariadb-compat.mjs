/**
 * Essai local de mariadb-compat.mjs : compile des requetes Kysely (sans base) et verifie le SQL rendu.
 * Usage, a la racine du depot :  node deploy/hostinger/test-mariadb-compat.mjs
 * Utilise le Kysely de apps/server (celui du serveur) ; si apps/server/dist existe, essaie aussi le vrai `jsonValue`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adaptRawFragments, installMariaDbCompat } from './mariadb-compat.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', '..', 'apps', 'server');
const kysely = await import(
  pathToFileURL(path.join(serverDir, 'node_modules', 'kysely', 'dist', 'index.js')).href
);
const {
  Kysely,
  sql,
  DefaultQueryCompiler,
  DummyDriver,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
} = kysely;

const makeDb = () =>
  new Kysely({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log('  ok  ' + name);
};

// Avant : le SQL de MySQL, avec les deux constructions que MariaDB refuse (l'essai detecte donc un oubli d'installation).
const before = makeDb();
const castSql = (db) =>
  db
    .insertInto('t')
    .values({ id: 1, j: sql`CAST(${JSON.stringify({ a: 1 })} AS JSON)` })
    .compile().sql;
const shareSql = (db) =>
  db.selectFrom('t').select('id').where('id', '=', 1).forShare().compile().sql;
const updateOfSql = (db) =>
  db.selectFrom('t').select('id').where('id', '=', 1).forUpdate('t').compile().sql;
assert.match(castSql(before), /CAST\(\? AS JSON\)/, 'avant installation : CAST(? AS JSON) attendu');
assert.match(shareSql(before), /for share$/, 'avant installation : for share attendu');
assert.match(
  updateOfSql(before),
  /for update of `t`$/,
  'avant installation : for update of attendu',
);

assert.equal(installMariaDbCompat(DefaultQueryCompiler), true);
assert.equal(
  installMariaDbCompat(DefaultQueryCompiler),
  false,
  'la seconde installation ne fait rien',
);
const db = makeDb();

// Piege constate en ligne le 01/11/2026 (outil de reprise du reporting) : le compilateur retient ses methodes a sa
// construction, une instance creee AVANT l'installation n'est jamais corrigee. Installer la couche avant createDatabase.
check(
  "une instance creee AVANT l'installation n'est pas corrigee (installer avant createDatabase)",
  () => {
    assert.match(castSql(before), /CAST\(\? AS JSON\)/);
    assert.match(shareSql(before), /for share$/);
    assert.match(updateOfSql(before), /for update of/);
    assert.doesNotMatch(castSql(db), /AS JSON/);
  },
);

check("jsonValue : CAST(? AS JSON) devient JSON_EXTRACT(?, '$')", () => {
  const q = db
    .insertInto('t')
    .values({ id: 1, j: sql`CAST(${JSON.stringify({ a: 1 })} AS JSON)` })
    .compile();
  assert.equal(q.sql, "insert into `t` (`id`, `j`) values (?, JSON_EXTRACT(?, '$'))");
  assert.deepEqual(q.parameters, [1, '{"a":1}']);
});

check("sql.raw('CAST(? AS JSON)' ecrit en entier) est reecrit aussi", () => {
  const q = db
    .selectFrom('t')
    .select(sql`${sql.raw('CAST(? AS JSON)')}`.as('v'))
    .compile();
  assert.ok(q.sql.includes("JSON_EXTRACT(?, '$')") && !q.sql.includes('AS JSON'), q.sql);
});

check('JSON_OVERLAPS(..., CAST(? AS JSON)) du magasin de vues', () => {
  const q = db
    .selectFrom('t')
    .select('id')
    .where(sql`JSON_OVERLAPS(shared_with_roles, CAST(${JSON.stringify(['ADMIN'])} AS JSON))`)
    .compile();
  assert.ok(q.sql.includes("JSON_OVERLAPS(shared_with_roles, JSON_EXTRACT(?, '$'))"), q.sql);
  assert.deepEqual(q.parameters, ['["ADMIN"]']);
});

check('plusieurs colonnes JSON dans une meme requete (audit : roles, avant, apres)', () => {
  const j = (v) => sql`CAST(${JSON.stringify(v)} AS JSON)`;
  const q = db
    .insertInto('t')
    .values({ id: 1, a: j([]), b: j(null), c: j({ x: 'e' }) })
    .compile();
  assert.equal(q.sql.match(/JSON_EXTRACT\(\?, '\$'\)/g)?.length, 3, q.sql);
  assert.ok(!q.sql.includes('AS JSON'), q.sql);
});

check('ON DUPLICATE KEY UPDATE avec une colonne JSON', () => {
  const q = db
    .insertInto('t')
    .values({ id: 1, j: sql`CAST(${'{}'} AS JSON)` })
    .onDuplicateKeyUpdate({ j: sql`CAST(${'[]'} AS JSON)` })
    .compile();
  assert.ok(!q.sql.includes('AS JSON') && q.sql.match(/JSON_EXTRACT/g).length === 2, q.sql);
});

check('forShare : lock in share mode (et skip locked / nowait a la suite)', () => {
  assert.equal(shareSql(db), 'select `id` from `t` where `id` = ? lock in share mode');
  const q = db.selectFrom('t').select('id').limit(1).forShare().skipLocked().compile();
  assert.equal(q.sql, 'select `id` from `t` limit ? lock in share mode skip locked');
  const n = db.selectFrom('t').select('id').forShare().noWait().compile();
  assert.equal(n.sql, 'select `id` from `t` lock in share mode nowait');
});

// Trouve le 08/11/2026 par le filet AV-540, a sa premiere analyse en ligne : la selection FIFO des lots de recordStockMove
// (record-move.ts, stock-lots.ts) ecrit `.forUpdate('inventory_stock_balances')` ; MariaDB 11.8 refuse `FOR UPDATE OF`.
check("forUpdate('table') : la clause OF de MySQL 8 est retiree (MariaDB la refuse)", () => {
  assert.equal(updateOfSql(db), 'select `id` from `t` where `id` = ? for update');
  assert.equal(
    db
      .selectFrom('t')
      .innerJoin('u', 'u.id', 't.u_id')
      .select('t.id')
      .where('t.k', '=', 1)
      .orderBy('u.rank_at', 'asc')
      .forUpdate('t')
      .compile().sql,
    'select `t`.`id` from `t` inner join `u` on `u`.`id` = `t`.`u_id` where `t`.`k` = ? order by `u`.`rank_at` asc for update',
  );
  // Plusieurs tables, puis nowait / skip locked (modificateurs distincts) qui suivent comme avant.
  assert.equal(
    db.selectFrom('t').select('id').forUpdate(['t', 'u']).compile().sql,
    'select `id` from `t` for update',
  );
  assert.equal(
    db.selectFrom('t').select('id').forUpdate('t').noWait().compile().sql,
    'select `id` from `t` for update nowait',
  );
  assert.equal(
    db.selectFrom('t').select('id').forUpdate('t').skipLocked().compile().sql,
    'select `id` from `t` for update skip locked',
  );
  assert.equal(
    db.selectFrom('t').select('id').forShare('t').compile().sql,
    'select `id` from `t` lock in share mode',
  );
});

check('forUpdate et les autres requetes ne changent pas', () => {
  assert.equal(
    db.selectFrom('t').select('id').forUpdate().compile().sql,
    'select `id` from `t` for update',
  );
  assert.equal(
    db
      .selectFrom('t')
      .select(sql`CAST(${'1'} AS DECIMAL(14,3))`.as('d'))
      .compile().sql,
    'select CAST(? AS DECIMAL(14,3)) as `d` from `t`',
  );
  assert.equal(
    db
      .selectFrom('t')
      .select(sql`'$' as dollar`.as('x'))
      .compile().sql,
    "select '$' as dollar as `x` from `t`",
  );
});

check("adaptRawFragments rend le meme tableau quand il n'y a rien a changer", () => {
  const fragments = ['select ', ' + ', ''];
  assert.equal(adaptRawFragments(fragments), fragments);
});

// Le vrai code du serveur, s'il est construit.
const realHelper = path.join(serverDir, 'dist', 'platform', 'kysely', 'json-value.js');
if (fs.existsSync(realHelper)) {
  const { jsonValue } = await import(pathToFileURL(realHelper).href);
  check('jsonValue du serveur construit (apps/server/dist)', () => {
    const q = db
      .insertInto('t')
      .values({ id: 1, j: jsonValue({ roles: ['A'] }) })
      .compile();
    assert.equal(q.sql, "insert into `t` (`id`, `j`) values (?, JSON_EXTRACT(?, '$'))");
    assert.deepEqual(q.parameters, [1, '{"roles":["A"]}']);
  });
} else {
  console.log(
    '  --  jsonValue du serveur : apps/server/dist absent (pnpm run build), essai ignore',
  );
}

console.log(`Compatibilite MariaDB : ${checks} controles passes.`);

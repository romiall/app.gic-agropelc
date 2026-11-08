/**
 * Essais du filet de compatibilite MariaDB (AV-540) : forme canonique des requetes, reecritures appliquees avant
 * l'analyse, classement des refus, regroupement et fusion du corpus. Aucune base, aucun reseau :
 *   node deploy/hostinger/test-sql-corpus.mjs
 * Fichier ASCII volontairement.
 */
import assert from 'node:assert/strict';

process.env.SQL_CORPUS_NO_RUN = '1';
const {
  adaptForMariaDb,
  checkStatements,
  classifyPrepareError,
  compactSql,
  failureSignature,
  groupFailures,
  normalizeStatement,
  statementSha,
} = await import('./check-sql-corpus.mjs');
const { corpusText, mergeStatements, parseCaptureLines } = await import('./build-sql-corpus.mjs');

// -- Espaces compactes hors des chaines : un litteral SQL n'est jamais altere ---------------------------------------
assert.equal(compactSql('select  a ,\n  b\tfrom   t'), 'select a , b from t');
assert.equal(compactSql("select  'a   b'  from t"), "select 'a   b' from t");
assert.equal(compactSql("select 'it\\'s   ok'   from t"), "select 'it\\'s   ok' from t");
assert.equal(compactSql('select  `a   b`  from t'), 'select `a   b` from t');
assert.equal(compactSql('  select 1  '), 'select 1');

// -- Forme canonique : listes de parametres et insertions de plusieurs lignes ----------------------------------------
assert.equal(
  normalizeStatement('select * from t where id in (?, ?, ?) and k not in (?, ?)'),
  'select * from t where id in (?) and k not in (?)',
);
assert.equal(
  normalizeStatement('select * from t where id in (?)'),
  'select * from t where id in (?)',
);
assert.equal(
  normalizeStatement('insert into t (a, b) values (?, ?), (?, ?), (?, ?)'),
  'insert into t (a, b) values (?, ?)',
);
assert.equal(
  normalizeStatement('insert into t (a, j) values (?, CAST(? AS JSON)), (?, CAST(? AS JSON))'),
  'insert into t (a, j) values (?, CAST(? AS JSON))',
);
// Une insertion d'une seule ligne et une liste de colonnes ne sont pas touchees.
assert.equal(
  normalizeStatement('insert into t (a, b, c) values (?, ?, ?)'),
  'insert into t (a, b, c) values (?, ?, ?)',
);
assert.equal(
  normalizeStatement('select a, b, c from t where x = ? and y in (?, ?)'),
  'select a, b, c from t where x = ? and y in (?)',
);

// -- Les deux reecritures du serveur sous MariaDB, appliquees au texte ---------------------------------------------
assert.equal(adaptForMariaDb('values (?, CAST(? AS JSON))'), "values (?, JSON_EXTRACT(?, '$'))");
assert.equal(adaptForMariaDb('x = cast( ?  as json )'), "x = JSON_EXTRACT(?, '$')");
assert.equal(
  adaptForMariaDb('select * from t where id = ? for share'),
  'select * from t where id = ? lock in share mode',
);
assert.equal(
  adaptForMariaDb('select * from t where id = ? for update'),
  'select * from t where id = ? for update',
);
assert.equal(adaptForMariaDb('select 1'), 'select 1');
// FOR UPDATE OF <tables> : MariaDB 11.8 n'a pas la clause OF (trouve par la premiere analyse en ligne, 08/11/2026).
assert.equal(
  adaptForMariaDb(
    'select a from `b` inner join `l` on `l`.`id` = `b`.`k` where x = ? order by y asc for update of `b`',
  ),
  'select a from `b` inner join `l` on `l`.`id` = `b`.`k` where x = ? order by y asc for update',
);
assert.equal(
  adaptForMariaDb('select 1 from `a` for update of `a`, `db`.`b`, c nowait'),
  'select 1 from `a` for update nowait',
);
assert.equal(
  adaptForMariaDb('select 1 from t for update of t skip locked'),
  'select 1 from t for update skip locked',
);
assert.equal(
  adaptForMariaDb('select 1 from t for share of t'),
  'select 1 from t lock in share mode',
);
assert.equal(
  adaptForMariaDb('select 1 from t where note = ? for update'),
  'select 1 from t where note = ? for update',
);

// -- Empreinte et classement des refus -----------------------------------------------------------------------------
assert.match(statementSha('select 1'), /^[0-9a-f]{12}$/);
assert.equal(statementSha('select 1'), statementSha('select 1'));
assert.notEqual(statementSha('select 1'), statementSha('select 2'));
assert.equal(
  classifyPrepareError({ errno: 1295, code: 'ER_UNSUPPORTED_PS', sqlMessage: 'x' }).kind,
  'skip',
);
const parse = classifyPrepareError({
  errno: 1064,
  code: 'ER_PARSE_ERROR',
  sqlMessage: "You have an error near ' 0) OVER w' at line 3",
});
assert.equal(parse.kind, 'fail');
assert.equal(parse.code, 'ER_PARSE_ERROR');
assert.equal(classifyPrepareError(new Error('boum')).kind, 'fail');

// Deux refus de syntaxe qui ne different que par la position ou le texte cite se regroupent.
const a = { code: 'ER_PARSE_ERROR', message: "You have an error near ' 0) OVER w' at line 3" };
const b = { code: 'ER_PARSE_ERROR', message: "You have an error near 'JSON), X' at line 17" };
const c = { code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'x' in 'field list'" };
assert.equal(failureSignature(a), failureSignature(b));
assert.notEqual(failureSignature(a), failureSignature(c));

// -- Analyse d'un lot de requetes avec une base simulee ------------------------------------------------------------
const seen = [];
const prepare = async (sql) => {
  seen.push(sql);
  if (sql.includes('LAG(x, 1, 0)')) {
    throw Object.assign(new Error('syntax'), {
      errno: 1064,
      code: 'ER_PARSE_ERROR',
      sqlMessage: "near ', 0)' at line 1",
    });
  }
  if (sql.startsWith('lock tables')) {
    throw Object.assign(new Error('ps'), {
      errno: 1295,
      code: 'ER_UNSUPPORTED_PS',
      sqlMessage: 'not supported',
    });
  }
  if (sql.includes('no_such_table')) {
    throw Object.assign(new Error('table'), {
      errno: 1146,
      code: 'ER_NO_SUCH_TABLE',
      sqlMessage: "Table 'x.no_such_table' doesn't exist",
    });
  }
};
const known = new Set([statementSha('select no_such_table from t')]);
const result = await checkStatements(
  [
    'select 1',
    'insert into t (j) values (CAST(? AS JSON))',
    'select * from t where id = ? for share',
    'select LAG(x, 1, 0) over w from t window w as (order by n)',
    'lock tables t write',
    'select no_such_table from t',
    'select y from missing_for_real where id = ? and no_such_table = 1',
  ],
  prepare,
  known,
);
assert.equal(result.analysed, 3);
assert.equal(result.skipped, 1);
assert.equal(result.knownHits, 1);
assert.equal(result.failures.length, 2);
assert.deepEqual(result.failures.map((f) => f.code).sort(), ['ER_NO_SUCH_TABLE', 'ER_PARSE_ERROR']);
// La base voit le texte reecrit (comme en production), pas l'original.
assert.ok(seen.includes("insert into t (j) values (JSON_EXTRACT(?, '$'))"));
assert.ok(seen.includes('select * from t where id = ? lock in share mode'));
// Le refus garde l'empreinte de la requete d'origine (celle qu'on inscrit dans sql-corpus-known.json).
assert.equal(
  result.failures.find((f) => f.code === 'ER_PARSE_ERROR').sha,
  statementSha('select LAG(x, 1, 0) over w from t window w as (order by n)'),
);
const groups = groupFailures([...result.failures, ...result.failures]);
assert.equal(groups.length, 2);
assert.equal(groups[0].count, 2);

// -- Fusion des fichiers de captation en corpus ---------------------------------------------------------------------
const lines = [
  JSON.stringify('select 1'),
  JSON.stringify('select  2'),
  '{"coupee',
  '',
  JSON.stringify(''),
  JSON.stringify(42),
  JSON.stringify('select 1'),
].join('\n');
assert.deepEqual(parseCaptureLines(lines), ['select 1', 'select  2', 'select 1']);
assert.deepEqual(
  mergeStatements(
    ['select 2', 'select 3 where id in (?, ?)'],
    ['select 1', 'select 3 where id in (?)'],
  ),
  ['select 1', 'select 2', 'select 3 where id in (?)'],
);
const text = corpusText(['select 1', 'select "a,b"'], '2026-11-08T00:00:00.000Z');
const parsed = JSON.parse(text);
assert.equal(parsed.count, 2);
assert.deepEqual(parsed.statements, ['select 1', 'select "a,b"']);
assert.equal(text.trimEnd().split('\n').length, 8, 'une requete par ligne');

console.log('sql-corpus : tous les essais passent.');

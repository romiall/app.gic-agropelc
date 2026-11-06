// Controle statique de portabilite MariaDB (AV-485) : l'application vise MySQL 8.4, l'hebergement (Hostinger) est une
// MariaDB 11.8. Les ecarts connus sont absorbes ailleurs (mariadb-compat.mjs reecrit CAST(? AS JSON) et .forShare() a
// l'execution ; migrate.mjs retire les GRANT et change DROP CHECK ; build-bundle.ps1 adapte les semis). Ce controle
// cherche, sans base de donnees, les constructions SQL propres a MySQL que RIEN de tout cela ne rattrape : elles feraient
// echouer une requete ou une migration en ligne apres coup (la mise en ligne du 30/10/2026 avait casse la connexion ainsi).
//
//   node deploy/hostinger/test-mariadb-portability.mjs
//
// Sources examinees : apps/server/src et db/seeds (*.ts), db/migrations (*.sql, partie "migrate:up"). Les commentaires
// sont ignores. Une construction connue et deja appliquee peut etre inscrite dans ALLOWED (avec sa raison) ; toute autre
// occurrence fait echouer le controle. Ne remplace pas un essai sur la vraie base (compat-check.mjs, a chaque livraison).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  {
    id: 'json-path-arrow',
    // Avant la fleche : un identifiant, un `)`, un `]`, un guillemet inverse ou double (colonne citee), un `}` (colonne
    // interpolee dans un gabarit Kysely : `${col}->>'$.x'`).
    re: /[\w`)\]}"]\s*->>?\s*['"]\$/,
    why: 'operateur -> / ->> de chemin JSON : MariaDB ne le connait pas (utiliser JSON_EXTRACT / JSON_VALUE)',
    bad: "SELECT data->>'$.name' FROM t",
    good: "SELECT JSON_VALUE(data, '$.name') FROM t",
  },
  {
    id: 'member-of',
    re: /\bMEMBER\s+OF\s*\(/i,
    why: 'MEMBER OF() : MySQL 8.0.17 et plus seulement (utiliser JSON_CONTAINS)',
    bad: "SELECT 1 WHERE 'a' MEMBER OF (roles)",
    good: 'SELECT 1 WHERE JSON_CONTAINS(roles, \'"a"\')',
  },
  {
    id: 'any-value',
    re: /\bANY_VALUE\s*\(/i,
    why: 'ANY_VALUE() : fonction MySQL absente de MariaDB',
    bad: 'SELECT ANY_VALUE(name) FROM t GROUP BY id',
    good: 'SELECT MIN(name) FROM t GROUP BY id',
  },
  {
    id: 'uuid-bin',
    re: /\b(UUID_TO_BIN|BIN_TO_UUID)\s*\(/i,
    why: 'UUID_TO_BIN() / BIN_TO_UUID() : fonctions MySQL 8 absentes de MariaDB (les identifiants se fabriquent dans le code, uuid.ts)',
    bad: 'INSERT INTO t SELECT UUID_TO_BIN(UUID())',
    good: 'INSERT INTO t SELECT id FROM u',
  },
  {
    id: 'lock-of',
    re: /\bFOR\s+(UPDATE|SHARE)\s+OF\b/i,
    why: 'FOR UPDATE OF / FOR SHARE OF : syntaxe MySQL 8 absente de MariaDB',
    bad: 'SELECT * FROM a JOIN b FOR UPDATE OF a',
    good: 'SELECT * FROM a JOIN b FOR UPDATE',
  },
  {
    id: 'lateral',
    re: /\bLATERAL\b/,
    why: 'jointure LATERAL : absente de MariaDB',
    bad: 'SELECT * FROM a, LATERAL (SELECT 1) AS x',
    good: 'SELECT * FROM a, (SELECT 1) AS x',
  },
  {
    id: 'json-value-returning',
    re: /\bJSON_VALUE\s*\([^)]*\bRETURNING\b/i,
    why: 'JSON_VALUE(... RETURNING type) : option MySQL absente de MariaDB',
    bad: "SELECT JSON_VALUE(d, '$.n' RETURNING SIGNED) FROM t",
    good: "SELECT CAST(JSON_VALUE(d, '$.n') AS SIGNED) FROM t",
  },
  {
    id: 'upsert-row-alias',
    re: /\bVALUES\s*\([^)]*\)\s+AS\s+\w+\s+ON\s+DUPLICATE\b/i,
    why: 'alias de ligne dans INSERT ... ON DUPLICATE KEY UPDATE : syntaxe MySQL 8.0.19+ absente de MariaDB (utiliser VALUES(col))',
    bad: 'INSERT INTO t (a) VALUES (1) AS new ON DUPLICATE KEY UPDATE a = new.a',
    good: 'INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = VALUES(a)',
  },
  {
    id: 'raw-for-share',
    re: /\bFOR\s+SHARE\b/i,
    why: 'FOR SHARE ecrit en SQL brut : seul .forShare() de Kysely est reecrit en LOCK IN SHARE MODE par mariadb-compat.mjs',
    bad: 'SELECT 1 FROM t FOR SHARE',
    good: 'SELECT 1 FROM t LOCK IN SHARE MODE',
  },
  {
    id: 'cast-json-operand',
    re: /CAST\s*\(\s*(?!\?|\$\{)[^)]*?\s+AS\s+JSON\s*\)/i,
    why: "CAST(x AS JSON) dont l'operande n'est pas un parametre : seul CAST(? AS JSON) / CAST(${...} AS JSON) est reecrit (mariadb-compat.mjs)",
    bad: 'SELECT CAST(col AS JSON) FROM t',
    good: 'SELECT CAST(? AS JSON)',
  },
];

/** Occurrences connues et deja appliquees : { rule, file (fin du chemin), why }. Chaque entree dit pourquoi elle est sans danger. */
export const ALLOWED = [
  {
    rule: 'uuid-bin',
    file: 'db/migrations/20261013090200_create_organization_location_custody_periods.sql',
    why: 'migration deja appliquee en ligne (installation du 26/10/2026, adaptee a la main) ; ne se rejoue jamais',
  },
];

/**
 * Retire les commentaires : `// ...` et `/* ... *\/` (TypeScript), `-- ...` et `/* ... *\/` (SQL). Les numeros de ligne
 * sont conserves. Un commentaire ne commence jamais DANS une chaine (`'**\/*.ts'`, `https://...`) : les chaines sont
 * copiees telles quelles, ce qui peut seulement laisser passer un faux positif apres une chaine mal reconnue (un
 * litteral d'expression reguliere portant une apostrophe), jamais masquer du code.
 */
export function stripComments(text, kind) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const n = text.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (kind === 'sql' ? c === '-' && next === '-' : c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Partie "migrate:up" d'une migration dbmate (la partie "down" ne s'applique jamais en ligne). */
export function upPart(raw) {
  const parts = raw.split(/^--\s*migrate:up.*$/m);
  if (parts.length < 2) return raw;
  return parts[1].split(/^--\s*migrate:down.*$/m)[0];
}

/** Violations d'un texte : [{ rule, line, text }]. */
export function scanText(text, kind) {
  const body = kind === 'sql' ? upPart(text) : text;
  const clean = stripComments(body, kind);
  const found = [];
  for (const rule of RULES) {
    const flags = rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g';
    const re = new RegExp(rule.re.source, flags);
    for (const match of clean.matchAll(re)) {
      const line = clean.slice(0, match.index).split('\n').length;
      found.push({ rule: rule.id, line, text: match[0].trim().slice(0, 120) });
    }
  }
  return found;
}

function walk(dir, extensions, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, out);
    else if (
      extensions.some((ext) => entry.name.endsWith(ext)) &&
      !entry.name.endsWith('.generated.ts')
    )
      out.push(full);
  }
  return out;
}

export function scanRepository(root) {
  const targets = [
    ...walk(path.join(root, 'apps/server/src'), ['.ts']).map((file) => ({ file, kind: 'ts' })),
    ...walk(path.join(root, 'db/seeds'), ['.ts']).map((file) => ({ file, kind: 'ts' })),
    ...walk(path.join(root, 'db/migrations'), ['.sql']).map((file) => ({ file, kind: 'sql' })),
  ];
  const violations = [];
  for (const { file, kind } of targets) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    for (const hit of scanText(fs.readFileSync(file, 'utf8'), kind)) {
      if (ALLOWED.some((a) => a.rule === hit.rule && relative.endsWith(a.file))) continue;
      violations.push({ file: relative, ...hit });
    }
  }
  return { examined: targets.length, violations };
}

// -- essai des regles elles-memes : chacune voit son mauvais exemple et laisse passer le bon ---------------------------
for (const rule of RULES) {
  assert.ok(
    scanText(rule.bad, 'ts').some((hit) => hit.rule === rule.id),
    `${rule.id} : le mauvais exemple doit etre vu`,
  );
  assert.ok(
    !scanText(rule.good, 'ts').some((hit) => hit.rule === rule.id),
    `${rule.id} : le bon exemple ne doit pas etre vu`,
  );
}
// Les commentaires et la partie "down" d'une migration ne comptent pas.
assert.deepEqual(scanText('// SELECT ANY_VALUE(x)\n/* UUID_TO_BIN(a) */\nconst a = 1;', 'ts'), []);
assert.deepEqual(scanText('-- ANY_VALUE(x)\nSELECT 1;', 'sql'), []);
assert.deepEqual(
  scanText('-- migrate:up\nSELECT 1;\n-- migrate:down\nSELECT ANY_VALUE(x);', 'sql'),
  [],
);
// Une construction dans du code l'est, avec sa ligne.
assert.deepEqual(
  scanText('const a = 1;\nsql`SELECT ANY_VALUE(x)`', 'ts').map((h) => [h.rule, h.line]),
  [['any-value', 2]],
);
// La fleche JSON precedee d'une colonne interpolee (gabarit Kysely) ou citee est vue, comme celle d'une colonne nue.
for (const sample of [
  "sql`SELECT ${col}->>'$.x'`",
  'SELECT "col"->\'$.x\' FROM t',
  "SELECT `col` -> '$.x' FROM t",
]) {
  assert.ok(
    scanText(sample, 'ts').some((hit) => hit.rule === 'json-path-arrow'),
    `fleche JSON non vue : ${sample}`,
  );
}
// Un motif glob dans une chaine ne commence pas un commentaire (il avalait le code jusqu'au prochain `*/`).
assert.deepEqual(
  scanText("const g = '**/*.ts';\nsql`SELECT ANY_VALUE(x)`;\n/* fin */", 'ts').map((h) => [
    h.rule,
    h.line,
  ]),
  [['any-value', 2]],
  'un motif glob dans une chaine masquait le code qui suit',
);
// Une URL dans une chaine n'est pas un commentaire de ligne ; un vrai commentaire apres elle l'est.
assert.deepEqual(
  scanText("const u = 'https://x.cm'; // ANY_VALUE(x)\nsql`ANY_VALUE(y)`", 'ts').map((h) => h.line),
  [2],
);
// CAST(${...} AS JSON) (jsonValue) et CAST(? AS JSON) (semis) sont absorbes par le kit, pas signales.
assert.deepEqual(scanText('sql`CAST(${JSON.stringify(v)} AS JSON)`', 'ts'), []);
assert.deepEqual(scanText('VALUES (?, CAST(? AS JSON), ?)', 'ts'), []);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { examined, violations } = scanRepository(root);
if (violations.length > 0) {
  for (const v of violations) {
    const rule = RULES.find((r) => r.id === v.rule);
    console.error(`${v.file}:${v.line} [${v.rule}] ${v.text}\n    ${rule.why}`);
  }
  console.error(
    `ECHEC : ${violations.length} construction(s) propre(s) a MySQL (voir ci-dessus ; une exception connue s'inscrit dans ALLOWED avec sa raison).`,
  );
  process.exit(1);
}
console.log(
  `OK : ${examined} fichiers examines, aucune construction SQL propre a MySQL hors liste connue (${ALLOWED.length} exception(s) historique(s))`,
);

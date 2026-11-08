/**
 * Filet de compatibilite MariaDB (AV-540) : fait ANALYSER par la vraie base, sans rien executer, chaque requete SQL que
 * le serveur emet dans ses essais (le corpus `sql-corpus.json`, capte par apps/server/test/sql-corpus-setup.ts et fusionne
 * par build-sql-corpus.mjs). Une requete que MariaDB refuse (syntaxe, fonction inconnue, table ou colonne absente) apparait
 * ici AVANT le redemarrage, au lieu de ne se voir qu'en production le jour ou le parcours est utilise (la tache horaire
 * sync.devices.seq_gap_check a echoue pendant trois jours sur LAG(x, 1, 0) sans qu'aucun essai ne le voie).
 *
 * Methode : pour chaque requete, protocole PREPARE seul (COM_STMT_PREPARE puis COM_STMT_CLOSE, jamais COM_STMT_EXECUTE) : le
 * serveur analyse la requete et resout ses tables et colonnes, il ne l'execute pas, ne lit aucune donnee et n'en ecrit
 * aucune. Les deux ecarts que le serveur absorbe a l'execution (mariadb-compat.mjs : CAST(? AS JSON) et FOR SHARE)
 * sont appliques au texte avant l'analyse, comme en production. Les requetes que le protocole PREPARE ne sait pas analyser
 * (erreur 1295) sont comptees a part.
 *
 * Usage, sur le serveur, apres les migrations (le corpus vient du code livre, qui peut employer une colonne nouvelle) :
 *   node --env-file=.env check-sql-corpus.mjs [--strict]
 * Par defaut un refus est un AVERTISSEMENT (code de sortie 0) ; --strict (ou SQL_CORPUS_STRICT=1) fait echouer la livraison.
 * Requetes connues et acceptees : sql-corpus-known.json, liste de { "sha": "<12 premiers hexa du SHA-1 de la requete>",
 * "why": "..." } (le sha est affiche pour chaque refus).
 * Fichier ASCII volontairement.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Espaces compactes hors des chaines et identifiants entre guillemets (un litteral SQL n'est jamais altere). */
export function compactSql(sql) {
  let out = '';
  let quote = null;
  let pendingSpace = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote !== null) {
      out += char;
      if (char === '\\' && quote !== '`') {
        out += sql[i + 1] ?? '';
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      if (pendingSpace && out.length > 0) out += ' ';
      pendingSpace = false;
      quote = char;
      out += char;
    } else if (/\s/.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && out.length > 0) out += ' ';
      pendingSpace = false;
      out += char;
    }
  }
  return out;
}

const TUPLE = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const MULTI_ROW_VALUES = new RegExp(String.raw`(\bvalues\s*${TUPLE})(?:\s*,\s*${TUPLE})+`, 'gi');
const PLACEHOLDER_LIST = /\b(not\s+in|in)\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi;

/**
 * Forme canonique d'une requete du corpus : espaces compactes, liste de parametres d'un IN ramenee a un seul
 * (`in (?, ?, ?)` -> `in (?)`) et insertion de plusieurs lignes ramenee a la premiere : deux appels qui ne different que
 * par le nombre de valeurs donnent la meme entree.
 */
export function normalizeStatement(sql) {
  return compactSql(sql)
    .replace(PLACEHOLDER_LIST, (_all, word) => `${word} (?)`)
    .replace(MULTI_ROW_VALUES, (_all, first) => first);
}

/**
 * Les deux reecritures que le serveur applique a la compilation sous MariaDB (mariadb-compat.mjs), appliquees ici au texte
 * final : CAST(? AS JSON) -> JSON_EXTRACT(?, '$') et FOR SHARE -> LOCK IN SHARE MODE.
 */
export function adaptForMariaDb(sql) {
  return sql
    .replace(/CAST\(\s*\?\s+AS\s+JSON\s*\)/gi, () => "JSON_EXTRACT(?, '$')")
    .replace(/\bfor share\b/gi, () => 'lock in share mode');
}

/** Empreinte courte d'une requete (identifie un refus connu dans sql-corpus-known.json). */
export function statementSha(sql) {
  return createHash('sha1').update(sql).digest('hex').slice(0, 12);
}

/** Erreur du protocole PREPARE : { kind: 'skip' } si la requete n'est pas analysable ainsi, sinon { kind: 'fail', ... }. */
export function classifyPrepareError(error) {
  const errno = Number(error?.errno ?? 0);
  const code = String(error?.code ?? 'ERREUR');
  const message = String(error?.sqlMessage ?? error?.message ?? error ?? '');
  // 1295 ER_UNSUPPORTED_PS : commande que le protocole PREPARE ne prend pas en charge (ce n'est pas un refus de MariaDB).
  if (errno === 1295 || code === 'ER_UNSUPPORTED_PS') return { kind: 'skip', errno, code, message };
  return { kind: 'fail', errno, code, message };
}

/** Message d'erreur sans les noms propres a une requete (nombres, positions) pour regrouper les refus semblables. */
export function failureSignature(failure) {
  return `${failure.code} ${failure.message}`
    .replace(/near '[^']*'/g, "near '...'")
    .replace(/at line \d+/g, 'at line N')
    .replace(/\b\d+\b/g, 'N')
    .slice(0, 200);
}

/**
 * Analyse chaque requete par `prepare(sql)` (qui rejette si la base refuse). Rend { analysed, skipped, failures, known }.
 * Une requete dont l'empreinte est dans `known` n'est pas comptee comme un refus.
 */
export async function checkStatements(statements, prepare, known = new Set()) {
  let analysed = 0;
  let skipped = 0;
  let knownHits = 0;
  const failures = [];
  for (const statement of statements) {
    const adapted = adaptForMariaDb(statement);
    try {
      await prepare(adapted);
      analysed += 1;
    } catch (error) {
      const verdict = classifyPrepareError(error);
      if (verdict.kind === 'skip') {
        skipped += 1;
      } else if (known.has(statementSha(statement))) {
        knownHits += 1;
      } else {
        failures.push({ ...verdict, sha: statementSha(statement), statement, adapted });
      }
    }
  }
  return { analysed, skipped, knownHits, failures };
}

/** Refus regroupes par signature d'erreur : [{ signature, count, example }], les plus nombreux d'abord. */
export function groupFailures(failures) {
  const groups = new Map();
  for (const failure of failures) {
    const key = failureSignature(failure);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { signature: key, count: 1, example: failure });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function main() {
  const strict = process.argv.includes('--strict') || process.env.SQL_CORPUS_STRICT === '1';
  const corpusFile = process.env.SQL_CORPUS_FILE || path.join(HERE, 'sql-corpus.json');
  const knownFile = process.env.SQL_CORPUS_KNOWN_FILE || path.join(HERE, 'sql-corpus-known.json');
  const url = process.env.SERVER_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('SERVER_DATABASE_URL (ou DATABASE_URL) absent du .env.');
  if (!existsSync(corpusFile)) {
    console.log(
      '  corpus absent (' + path.basename(corpusFile) + ') : controle des requetes ignore',
    );
    return;
  }
  const corpus = readJson(corpusFile);
  const statements = corpus.statements;
  const known = new Set(
    (existsSync(knownFile) ? readJson(knownFile) : []).map((entry) => String(entry.sha)),
  );

  // Import tardif : le module se charge (essais) sans mysql2, qui n'est resolu que sur le serveur.
  const { createPool } = await import('mysql2');
  const pool = createPool({ uri: url, timezone: 'Z', connectionLimit: 1 });
  const conn = await new Promise((resolve, reject) =>
    pool.getConnection((error, c) => (error ? reject(error) : resolve(c))),
  );
  const query = (sql) =>
    new Promise((resolve, reject) =>
      conn.query(sql, (error, rows) => (error ? reject(error) : resolve(rows))),
    );
  const prepare = (sql) =>
    new Promise((resolve, reject) =>
      conn.prepare(sql, (error, statement) => {
        if (error) return reject(error);
        statement.close();
        return resolve();
      }),
    );

  // Le protocole PREPARE n'execute jamais la requete (COM_STMT_PREPARE puis COM_STMT_CLOSE, jamais COM_STMT_EXECUTE) ; une
  // session en lecture seule ferait refuser par MySQL l'analyse des ecritures (erreur 1792), elle n'est donc pas posee.
  const version = (await query('SELECT VERSION() AS v'))[0]?.v;
  const started = Date.now();
  const result = await checkStatements(statements, prepare, known);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  conn.release();
  await new Promise((resolve) => pool.end(() => resolve()));

  console.log(
    '  base ' +
      version +
      ' : ' +
      statements.length +
      ' requete(s) du corpus' +
      (corpus.generated ? ' (genere le ' + String(corpus.generated).slice(0, 10) + ')' : '') +
      ', analysees ' +
      result.analysed +
      ', non analysables par PREPARE ' +
      result.skipped +
      ', connues et acceptees ' +
      result.knownHits +
      ', refusees ' +
      result.failures.length +
      ' (' +
      seconds +
      ' s)',
  );
  if (result.failures.length === 0) {
    console.log("  OK : aucune requete du corpus n'est refusee par la base.");
    return;
  }
  console.log('  REFUSEES (regroupees par erreur) :');
  for (const group of groupFailures(result.failures).slice(0, 20)) {
    console.log('    ' + String(group.count).padStart(4) + ' x ' + group.signature);
    console.log(
      '         exemple [' + group.example.sha + '] : ' + group.example.adapted.slice(0, 300),
    );
  }
  if (strict) {
    console.log(
      'ECHEC du controle des requetes (mode strict) : ' +
        result.failures.length +
        ' requete(s) refusee(s).',
    );
    process.exitCode = 1;
  } else {
    console.log(
      '  AVERTISSEMENT : ' +
        result.failures.length +
        ' requete(s) refusee(s) ; la livraison continue (mode strict : --strict).',
    );
  }
}

// Appele directement (ou par l'entree standard) : lance le controle ; importe (essai) : rien ne s'execute.
if (!process.env.SQL_CORPUS_NO_RUN) {
  main().catch((error) => {
    console.error(
      'Echec du controle des requetes : ' + (error instanceof Error ? error.message : error),
    );
    process.exitCode = 1;
  });
}

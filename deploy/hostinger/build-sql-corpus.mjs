/**
 * Fusionne les fichiers de captation des essais du serveur (apps/server/test/sql-corpus-setup.ts) en
 * `deploy/hostinger/sql-corpus.json`, le corpus que check-sql-corpus.mjs fait analyser par la vraie base (AV-540).
 *
 * Etape 1, depuis apps/server (un dossier de captation vide ou nouveau, essais lances par fichiers ou en lots) :
 *   GIC_SQL_CORPUS_DIR=<dossier> npx vitest run <fichiers d'essai> --maxWorkers=2 --minWorkers=1
 * Etape 2, depuis la racine du depot :
 *   node deploy/hostinger/build-sql-corpus.mjs <dossier> [--replace] [--out <fichier>]
 * Par defaut le corpus existant est CONSERVE et complete (union) ; --replace repart de la seule captation (a faire apres
 * une suite complete, pour retirer les requetes d'un code disparu). Les requetes sont ramenees a leur forme canonique
 * (IN et insertions de plusieurs lignes), dedoublonnees et triees : le fichier ne change que si le code change.
 * Fichier ASCII volontairement.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SQL_CORPUS_NO_RUN = '1';
const { normalizeStatement } = await import('./check-sql-corpus.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Requetes d'un contenu NDJSON (une chaine JSON par ligne) ; une ligne illisible est ignoree. */
export function parseCaptureLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value === 'string' && value.trim() !== '') out.push(value);
    } catch {
      // ligne coupee par un processus interrompu : ignoree
    }
  }
  return out;
}

/** Union canonique, triee et sans doublon. */
export function mergeStatements(...lists) {
  const all = new Set();
  for (const list of lists) for (const sql of list) all.add(normalizeStatement(sql));
  return [...all].sort();
}

/**
 * Texte du fichier de corpus : un objet JSON valide, une requete par ligne, indentation de Prettier (le fichier passe
 * `prettier --check` sans etre reformate).
 */
export function corpusText(statements, generated) {
  return (
    '{\n  "generated": ' +
    JSON.stringify(generated) +
    ',\n  "count": ' +
    statements.length +
    ',\n  "statements": [\n' +
    statements.map((sql) => '    ' + JSON.stringify(sql)).join(',\n') +
    '\n  ]\n}\n'
  );
}

function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : path.join(HERE, 'sql-corpus.json');
  const dir = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--out');
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      'Usage : node deploy/hostinger/build-sql-corpus.mjs <dossier de captation> [--replace] [--out <fichier>]',
    );
  }
  const captured = [];
  const files = readdirSync(dir).filter((name) => name.endsWith('.ndjson'));
  for (const name of files)
    captured.push(...parseCaptureLines(readFileSync(path.join(dir, name), 'utf8')));
  const previous =
    !replace && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).statements : [];
  const statements = mergeStatements(previous, captured);
  const added = statements.length - mergeStatements(previous).length;
  // Une requete par ligne (differences lisibles dans git) ; JSON valide.
  writeFileSync(out, corpusText(statements, new Date().toISOString()));
  console.log(
    files.length +
      ' fichier(s) de captation, ' +
      captured.length +
      ' ligne(s), corpus de ' +
      statements.length +
      ' requete(s) (' +
      (replace ? 'remplace' : added + " ajoutee(s) a l'existant") +
      ') : ' +
      out,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

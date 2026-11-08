/**
 * Captation des requêtes SQL du serveur pendant les essais (filet MariaDB, AV-540) — inactive sauf si la variable
 * d'environnement `GIC_SQL_CORPUS_DIR` désigne un dossier.
 *
 * Chaque requête que Kysely compile et dont la pile d'appel passe par `apps/server/src` (code du produit, pas les
 * insertions de préparation des essais) est ajoutée, une fois par processus, à un fichier `<pid>-<instant>.ndjson`
 * de ce dossier : une chaîne JSON par ligne, le SQL compilé avec ses paramètres `?`, espaces compactés. Rien n'est
 * exécuté ni modifié ; le comportement des essais ne change pas. `deploy/hostinger/build-sql-corpus.mjs` fusionne ces
 * fichiers en `deploy/hostinger/sql-corpus.json`, que `check-sql-corpus.mjs` fait analyser (PREPARE) par la vraie
 * MariaDB avant chaque redémarrage.
 *
 * Usage : `GIC_SQL_CORPUS_DIR=<dossier> npx vitest run <fichiers d'essai>` depuis `apps/server`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const directory = process.env.GIC_SQL_CORPUS_DIR;

/** Espaces compactés hors des chaînes et identifiants entre guillemets (un littéral SQL n'est jamais altéré). */
function compact(sql: string): string {
  let out = '';
  let quote: string | null = null;
  let pendingSpace = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
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

if (directory) {
  const { DefaultQueryCompiler } = await import('kysely');
  const proto = DefaultQueryCompiler.prototype as unknown as {
    compileQuery: (node: unknown, queryId: unknown) => { sql: string };
    __gicSqlCorpus?: true;
  };
  if (!proto.__gicSqlCorpus) {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${process.pid}-${Date.now()}.ndjson`);
    const seen = new Set<string>();
    const compile = proto.compileQuery;
    Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 40);
    proto.compileQuery = function compileQueryAndRecord(this: unknown, node, queryId) {
      const compiled = compile.call(this, node, queryId);
      try {
        // Seulement le code du produit : les requêtes écrites par un essai pour préparer son décor n'ont aucun cadre
        // de `apps/server/src` dans leur pile.
        if (/apps[\\/]server[\\/]src[\\/]/.test(new Error().stack ?? '')) {
          const sql = compact(compiled.sql);
          if (sql !== '' && !seen.has(sql)) {
            seen.add(sql);
            appendFileSync(file, `${JSON.stringify(sql)}\n`);
          }
        }
      } catch {
        // La captation ne doit jamais faire échouer un essai.
      }
      return compiled;
    };
    Object.defineProperty(proto, '__gicSqlCorpus', { value: true });
  }
}

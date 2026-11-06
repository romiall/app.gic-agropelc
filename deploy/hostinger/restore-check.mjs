// Essai de restauration d'une sauvegarde de la base : une sauvegarde qu'on n'a jamais restauree n'est qu'une esperance.
//
// Le script lit une sauvegarde gic-daily-*.sql.gz (ou une sauvegarde de livraison gic-*.sql.gz), la restaure dans une
// base JETABLE d'un serveur MySQL ou MariaDB LOCAL (jamais l'hebergement), controle ce qu'elle contient, puis supprime
// la base jetable. Il ne touche a aucune autre base.
//
// Usage :
//   node deploy/hostinger/restore-check.mjs <sauvegarde.sql.gz> --defaults-file <fichier.cnf>
//        [--mysql-bin <dossier ou mysql.exe>] [--min-tables 100] [--expect-version <version>|auto] [--keep] [--allow-remote]
//   --expect-version <v> : la derniere migration enregistree doit etre exactement <v>. auto : elle doit etre une version
//   du depot ET toutes les migrations du depot jusque-la doivent etre enregistrees (la base en ligne peut etre en retard
//   sur le depot : les migrations posterieures a la sauvegarde ne sont pas des manques).
//
// Le fichier .cnf est un fichier d'options du client mysql, prepare par le porteur et jamais versionne ni colle dans
// une commande (le mot de passe n'apparait donc ni dans la ligne de commande ni dans l'historique) :
//   [client]
//   user=...        (un compte qui peut creer et supprimer des bases sur ce serveur local)
//   password=...
//   host=127.0.0.1
//   port=3306
// Garde-fous : le serveur doit etre local (localhost, 127.0.0.1, ::1 ; --allow-remote le leve, sciemment) ; la base creee
// s'appelle toujours gic_agropelc_restore_check_<horodatage> et c'est la seule que le script supprime.
//
// Limite a connaitre : une sauvegarde de l'hebergement vient de MariaDB 11.8. La restaurer dans MySQL 8.4 peut echouer
// pour des raisons d'ecart entre les deux moteurs (collations, syntaxe des declencheurs) qui n'en font pas une mauvaise
// sauvegarde ; l'essai le plus parlant se fait sur un MariaDB 11.x. L'erreur du client est affichee telle quelle.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const DATABASE_PREFIX = 'gic_agropelc_restore_check_';

/** Nom de la base jetable : prefixe fixe et chiffres de l'horodatage UTC, rien d'autre. */
export function restoreDatabaseName(now) {
  return DATABASE_PREFIX + now.toISOString().replace(/\D/g, '').slice(0, 14);
}

/** Hote declare dans un fichier d'options du client (`host=...`), `localhost` s'il n'en declare pas. */
export function hostOfDefaults(text) {
  let host = 'localhost';
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*host\s*=\s*"?([^"\s#;]+)"?/i.exec(raw);
    if (m) host = m[1];
  }
  return host;
}

export const isLocalHost = (host) =>
  ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());

/**
 * Retire la clause DEFINER d'une ligne de dump : le compte qui l'a creee n'existe pas sur le serveur de l'essai et
 * MySQL refuse alors de recreer un declencheur sans privilege special.
 */
export function stripDefiner(line) {
  if (!line.includes('DEFINER')) return line;
  return line
    .replace(/\/\*!\d+\s+DEFINER\s*=\s*`[^`]*`@`[^`]*`\s*\*\//g, '')
    .replace(/\bDEFINER\s*=\s*`[^`]*`@`[^`]*`/g, '')
    .replace(/\bDEFINER\s*=\s*'[^']*'@'[^']*'/g, '');
}

/** Versions de migration d'une liste de noms de fichiers (AAAAMMJJHHMMSS_nom.sql), triees. */
export function migrationVersions(files) {
  return files
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => f.split('_')[0])
    .sort();
}

/** Version de migration la plus recente d'une liste de noms de fichiers (AAAAMMJJHHMMSS_nom.sql). */
export function newestMigrationVersion(files) {
  const versions = migrationVersions(files);
  return versions.length ? versions[versions.length - 1] : null;
}

/**
 * Mode `--expect-version auto` : la sauvegarde vient de la base EN LIGNE, dont les migrations peuvent etre en retard sur
 * le depot courant (migrations ecrites en local, pas encore appliquees en ligne). Comparer sa derniere version a celle
 * du depot ferait echouer par construction une sauvegarde saine. Elle est coherente si sa derniere version est une
 * version connue du depot et si toutes les versions du depot jusqu'a celle-la sont enregistrees ; les versions du depot
 * posterieures a la sauvegarde ne sont pas des manques.
 */
export function autoVersionProblems(repoVersions, appliedVersions) {
  const applied = new Set(appliedVersions);
  const latest = [...applied].sort().pop() ?? null;
  const known = latest !== null && repoVersions.includes(latest);
  const missing = known ? repoVersions.filter((v) => v <= latest && !applied.has(v)) : [];
  return { latest, known, missing };
}

/**
 * Transform ligne a ligne qui retire les clauses DEFINER (les fins de ligne sont conservees). Le flux est lu en latin1 :
 * un octet = un caractere, aller-retour sans perte, car un dump sans --hex-blob contient les octets bruts des colonnes
 * BINARY(16) (identifiants) qu'une lecture UTF-8 corromprait ; les motifs recherches sont en ASCII.
 */
export function definerStripper() {
  let carry = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      const text = carry + chunk.toString('latin1');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      callback(
        null,
        Buffer.from(lines.map((line) => stripDefiner(line) + '\n').join(''), 'latin1'),
      );
    },
    flush(callback) {
      callback(null, Buffer.from(stripDefiner(carry), 'latin1'));
    },
  });
}

/** Lecture complete de l'archive : integrite gzip, pied du dump, nombre de tables et de declencheurs annonces. */
export async function inspectDump(file) {
  const result = { createTables: 0, triggers: 0, completed: false, lines: 0 };
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const tail = [];
  for await (const line of lines) {
    result.lines += 1;
    if (line.startsWith('CREATE TABLE')) result.createTables += 1;
    else if (/^(\/\*!\d+\s+)?CREATE\b.*\bTRIGGER\b/.test(line.slice(0, 400))) result.triggers += 1;
    tail.push(line);
    if (tail.length > 5) tail.shift();
  }
  result.completed = tail.some((line) => line.includes('Dump completed'));
  return result;
}

function clientBinary(mysqlBin, name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (!mysqlBin) return name;
  const stat = fs.statSync(mysqlBin, { throwIfNoEntry: false });
  return stat?.isDirectory() ? path.join(mysqlBin, exe) : mysqlBin;
}

function runClient(binary, defaultsFile, args, { input, timeoutMs = 3_600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [`--defaults-extra-file=${defaultsFile}`, '--default-character-set=utf8mb4', ...args],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `le client s'est arrete avec le code ${code}`));
    });
    if (input) {
      pipeline(input, child.stdin).catch((error) => {
        // EPIPE : le client s'est arrete avant la fin du flux ; son message d'erreur (stderr) est rendu a sa fermeture.
        if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        child.kill();
        reject(error);
      });
    } else {
      child.stdin.end();
    }
  });
}

function parseArgs(argv) {
  const withValue = new Set(['--defaults-file', '--mysql-bin', '--min-tables', '--expect-version']);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (withValue.has(argv[i])) {
      flags[argv[i]] = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--')) {
      flags[argv[i]] = true;
    } else {
      positional.push(argv[i]);
    }
  }
  return {
    dump: positional[0],
    defaultsFile: flags['--defaults-file'],
    mysqlBin: flags['--mysql-bin'],
    minTables: Number(flags['--min-tables'] ?? 100),
    expectVersion: flags['--expect-version'],
    keep: flags['--keep'] === true,
    allowRemote: flags['--allow-remote'] === true,
  };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.dump || !opts.defaultsFile || !Number.isInteger(opts.minTables) || opts.minTables < 1) {
    console.error(
      'Usage : node restore-check.mjs <sauvegarde.sql.gz> --defaults-file <fichier.cnf> [--mysql-bin <chemin>] [--min-tables N] [--expect-version <v>|auto] [--keep] [--allow-remote]',
    );
    return 2;
  }
  if (!fs.existsSync(opts.dump)) return (console.error('Sauvegarde introuvable : ' + opts.dump), 2);
  if (!fs.existsSync(opts.defaultsFile))
    return (console.error("Fichier d'options introuvable : " + opts.defaultsFile), 2);
  const host = hostOfDefaults(fs.readFileSync(opts.defaultsFile, 'utf8'));
  if (!isLocalHost(host) && !opts.allowRemote) {
    console.error(
      `Refus : le serveur de l'essai (${host}) n'est pas local. Restaurer une sauvegarde est destructif pour la base creee ; --allow-remote le permet sciemment.`,
    );
    return 2;
  }
  let expected = opts.expectVersion;
  let repoVersions = null;
  if (expected === 'auto') {
    const migrations = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'db',
      'migrations',
    );
    repoVersions = migrationVersions(fs.existsSync(migrations) ? fs.readdirSync(migrations) : []);
    expected = undefined;
    if (repoVersions.length === 0)
      return (
        console.error('--expect-version auto : db/migrations introuvable depuis ce script.'),
        2
      );
  }

  console.log(`== Lecture de la sauvegarde : ${opts.dump}`);
  const dump = await inspectDump(opts.dump);
  console.log(
    `   archive gzip lisible jusqu'au bout, ${dump.lines} lignes, ${dump.createTables} tables, ${dump.triggers} declencheurs, pied "Dump completed" : ${dump.completed ? 'oui' : 'NON'}`,
  );

  const mysql = clientBinary(opts.mysqlBin, 'mysql');
  const database = restoreDatabaseName(new Date());
  const checks = [];
  const note = (ok, label, detail) => {
    checks.push(ok);
    console.log(`   ${ok ? 'OK ' : 'ECHEC'} ${label}${detail ? ' : ' + detail : ''}`);
  };
  note(dump.completed, 'dump complet (pied "Dump completed")');
  note(
    dump.createTables >= opts.minTables,
    `au moins ${opts.minTables} tables dans le dump`,
    `${dump.createTables}`,
  );

  let restored = false;
  try {
    console.log(`== Restauration dans la base jetable ${database} (${host})`);
    await runClient(mysql, opts.defaultsFile, [
      '-e',
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`,
    ]);
    const input = fs.createReadStream(opts.dump).pipe(zlib.createGunzip()).pipe(definerStripper());
    // --one-database : les instructions d'un dump qui change de base (USE autre, CREATE DATABASE, DROP DATABASE : export
    // phpMyAdmin ou --databases) sont ignorees ; seule la base jetable est ecrite.
    await runClient(mysql, opts.defaultsFile, [`--database=${database}`, '--one-database'], {
      input,
    });
    restored = true;
    note(true, 'restauration sans erreur du client');
    const scalar = async (sql) =>
      (await runClient(mysql, opts.defaultsFile, ['-N', '-B', '-e', sql])).trim();
    const tables = Number(
      await scalar(
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${database}' AND table_type = 'BASE TABLE'`,
      ),
    );
    note(tables >= opts.minTables, `au moins ${opts.minTables} tables restaurees`, `${tables}`);
    const triggers = Number(
      await scalar(
        `SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = '${database}'`,
      ),
    );
    note(triggers >= 1, 'declencheurs restaures (rien ne disparait : ajout seul)', `${triggers}`);
    const users = Number(await scalar(`SELECT COUNT(*) FROM \`${database}\`.identity_users`));
    note(users >= 1, 'comptes restaures (identity_users)', `${users}`);
    const applied = (
      await scalar(`SELECT version FROM \`${database}\`.schema_migrations ORDER BY version`)
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const version = applied.length ? applied[applied.length - 1] : '';
    note(version !== '', 'migrations enregistrees (schema_migrations)', version);
    if (repoVersions) {
      // Mode auto : une version connue du depot, et aucune migration du depot manquante jusque-la.
      const { known, missing } = autoVersionProblems(repoVersions, applied);
      note(known, 'derniere migration connue du depot', version);
      note(
        missing.length === 0,
        'toutes les migrations du depot jusqu a celle-la sont enregistrees',
        missing.length ? 'manquantes : ' + missing.join(', ') : `${applied.length}`,
      );
    } else if (expected) {
      note(version === expected, `derniere migration = ${expected}`, version);
    }
  } catch (error) {
    note(
      false,
      restored ? 'controle apres restauration' : 'restauration',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (opts.keep) {
      console.log(
        `== Base conservee (--keep) : ${database} ; a supprimer a la main quand l'essai est fini.`,
      );
    } else {
      try {
        await runClient(mysql, opts.defaultsFile, [
          '-e',
          `DROP DATABASE IF EXISTS \`${database}\``,
        ]);
        console.log(`== Base jetable ${database} supprimee.`);
      } catch (error) {
        console.error(
          `ATTENTION : la base jetable ${database} n'a pas pu etre supprimee (${error instanceof Error ? error.message : error}) : la supprimer a la main.`,
        );
      }
    }
  }
  const ok = checks.every(Boolean);
  console.log(
    ok
      ? 'RESULTAT : la sauvegarde se restaure et son contenu est coherent.'
      : "RESULTAT : ECHEC - cette sauvegarde n'est pas fiable en l'etat (voir ci-dessus).",
  );
  return ok ? 0 : 1;
}

/** Lance `main` quand le fichier est le script executable : chemins compares apres resolution des liens symboliques. */
function isEntryPoint() {
  try {
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

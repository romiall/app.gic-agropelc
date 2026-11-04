/**
 * Diagnostic de synchronisation, EN LECTURE SEULE : la session de base est ouverte en lecture seule (aucune ecriture
 * possible) et le script ne contient que des SELECT. Sert a comprendre pourquoi des operations restent "en attente"
 * en ligne : appareils et leur etat, commandes en echec repete dans la file d'envoi (message d'erreur tronque et masque),
 * delai entre la saisie d'une commande d'appareil et sa reception, conflits de synchronisation ouverts, etat de
 * synchronisation par appareil, taille du flux de changements et fin des journaux du serveur.
 *
 * Aucun mot de passe, jeton, adresse e-mail ni numero de telephone n'est affiche (masquage de la sortie) ; les
 * contenus (payload) des operations ne sont jamais lus.
 *
 * Usage, sur le serveur, dans le dossier de l'application, sans rien y copier (le script arrive par l'entree standard) :
 *   ssh ... "cd ~/domains/gic-agropelc.com/nodejs-app && node --env-file=.env --input-type=module -" < diag-sync.mjs
 * Variable facultative : DIAG_LOG_LINES (defaut 60), nombre de lignes de journal affichees par fichier.
 * Fichier ASCII volontairement.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

/** Masque ce qui ne doit jamais sortir du serveur : URL de base, jetons, secrets, e-mails, numeros camerounais. */
export function mask(text) {
  return String(text)
    .replace(/mysql:\/\/[^\s"']+/gi, 'mysql://[masque]')
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[jeton]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [masque]')
    .replace(
      /(authorization|password|passwd|pwd|secret|token|jeton|mot de passe|api[_-]?key)(["']?\s*[:=]\s*|\s+)(?!(?:bearer|basic)\s)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1$2[masque]',
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[courriel]')
    .replace(/\+?237[\s.-]?[26]\d(?:[\s.-]?\d{2}){3}/g, '[numero]')
    .replace(/\b[62]\d{8}\b/g, '[numero]');
}

function cell(value) {
  if (value === null || value === undefined) return '-';
  if (value instanceof Date) return value.toISOString();
  return mask(String(value).replace(/\s+/g, ' ').trim());
}

function printRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('  (aucune ligne)');
    return;
  }
  for (const row of rows) {
    console.log(
      '  ' +
        Object.entries(row)
          .map(([key, value]) => key + '=' + cell(value))
          .join(' | '),
    );
  }
}

/** Fin d'un fichier de journal : les derniers octets seulement, jamais le fichier entier. */
export function tailLines(file, maxBytes, maxLines) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split(/\r?\n/);
  if (size > length) lines.shift(); // premiere ligne probablement coupee
  const all = lines.filter(Boolean);
  return { size, window: all.length, lines: all.slice(-maxLines) };
}

/** Comptage des lignes de journal structurees (JSON) par type de commande et code, hors niveau info. */
export function tallyStructured(lines) {
  const counts = new Map();
  for (const line of lines) {
    if (line[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const level = String(entry.level ?? entry.severity ?? '');
    const key = [level, entry.module ?? '-', entry.commandType ?? '-', entry.code ?? '-'].join(
      ' | ',
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
}

/** Refus (warn/error) des journaux structures, par jour (UTC) et code : montre depuis quand un refus se repete. */
export function tallyByDay(lines) {
  const counts = new Map();
  for (const line of lines) {
    if (line[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const level = String(entry.level ?? '');
    if (level !== 'warn' && level !== 'error') continue;
    const key = String(entry.ts ?? '').slice(0, 10) + ' | ' + (entry.code ?? '-');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30);
}

async function main() {
  const url = process.env.SERVER_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('SERVER_DATABASE_URL (ou DATABASE_URL) absent du .env.');
  const logLines = Math.max(10, Math.min(300, Number(process.env.DIAG_LOG_LINES) || 60));

  // Import tardif : le module se charge (essai du masquage) sans mysql2, qui n'est resolu que sur le serveur.
  const { createPool } = await import('mysql2');
  const pool = createPool({ uri: url, timezone: 'Z', dateStrings: true, connectionLimit: 1 });
  const conn = await new Promise((resolve, reject) =>
    pool.getConnection((error, c) => (error ? reject(error) : resolve(c))),
  );
  const run = (sql) =>
    new Promise((resolve, reject) =>
      conn.query(sql, (error, rows) => (error ? reject(error) : resolve(rows))),
    );

  // Lecture seule imposee par la base elle-meme, heures en UTC (comme les connexions du serveur).
  await run("SET time_zone = '+00:00'");
  await run('SET SESSION TRANSACTION READ ONLY');
  await run('START TRANSACTION READ ONLY');

  async function section(title, sql) {
    console.log('\n== ' + title);
    try {
      printRows(await run(sql));
    } catch (error) {
      console.log(
        '  ECHEC de la lecture : ' + cell(error instanceof Error ? error.message : error),
      );
    }
  }

  await section(
    'Base (version, heure UTC)',
    'SELECT VERSION() AS version, NOW(6) AS maintenant_utc',
  );
  await section(
    'Appareils par etat',
    'SELECT status, COUNT(*) AS n FROM identity_devices GROUP BY status ORDER BY n DESC',
  );
  await section(
    'Appareils les plus recents (20)',
    `SELECT d.short_code, d.status, d.created_at, d.status_changed_at, d.last_seen_at,
            LEFT(COALESCE(d.label, ''), 40) AS libelle, LEFT(COALESCE(d.platform, ''), 40) AS plateforme,
            d.app_version, d.is_shared AS partage, (d.approved_by IS NULL) AS sans_approbateur
       FROM identity_devices d ORDER BY d.created_at DESC LIMIT 20`,
  );
  await section(
    'Synchronisation par appareil (15 plus actifs) : dernier envoi, dernier tirage, restes declares',
    `SELECT d.short_code, d.status, MAX(s.last_push_at) AS dernier_envoi, MAX(s.last_pull_at) AS dernier_tirage,
            MAX(CASE WHEN s.dataset = '_device' THEN s.pending_reported END) AS restes_declares,
            SUM(s.needs_rebootstrap) AS a_reamorcer, COUNT(s.dataset) AS jeux
       FROM identity_devices d LEFT JOIN sync_device_sync_state s ON s.device_id = d.id
      GROUP BY d.id, d.short_code, d.status
      ORDER BY MAX(s.last_push_at) DESC LIMIT 15`,
  );
  await section(
    "File d'envoi (sync_command_inbox) par etat",
    `SELECT status, COUNT(*) AS n, MIN(received_at) AS plus_ancienne, MAX(received_at) AS plus_recente
       FROM sync_command_inbox GROUP BY status ORDER BY n DESC`,
  );
  await section(
    'Commandes en echec repete (FAILED_RETRYABLE), par type et code',
    `SELECT command_type, error_code, COUNT(*) AS n, MAX(attempts) AS essais_max, MIN(received_at) AS premiere
       FROM sync_command_inbox WHERE status = 'FAILED_RETRYABLE'
      GROUP BY command_type, error_code ORDER BY n DESC LIMIT 20`,
  );
  await section(
    "Commandes en echec repete : les 30 dernieres, avec le message d'erreur (tronque, masque)",
    `SELECT i.command_type, i.error_code, i.attempts AS essais, i.received_at,
            TIMESTAMPDIFF(MINUTE, i.received_at, NOW(6)) AS age_min, d.short_code AS appareil,
            HEX(SUBSTRING(i.user_id, 1, 4)) AS auteur, LEFT(COALESCE(i.error_message, ''), 300) AS erreur
       FROM sync_command_inbox i LEFT JOIN identity_devices d ON d.id = i.device_id
      WHERE i.status = 'FAILED_RETRYABLE' ORDER BY i.received_at DESC LIMIT 30`,
  );
  await section(
    "Commandes d'appareil (identity.device.*) : 15 dernieres, delai de saisie a reception et de reception a application",
    `SELECT i.command_type, i.status, i.occurred_at AS saisie, i.received_at AS recue, i.applied_at AS appliquee,
            TIMESTAMPDIFF(SECOND, i.occurred_at, i.received_at) AS attente_appareil_s,
            TIMESTAMPDIFF(SECOND, i.received_at, i.applied_at) AS traitement_s,
            i.attempts AS essais, i.captured_offline AS hors_ligne, d.short_code AS depuis_appareil
       FROM sync_command_inbox i LEFT JOIN identity_devices d ON d.id = i.device_id
      WHERE i.command_type LIKE 'identity.device.%' ORDER BY i.received_at DESC LIMIT 15`,
  );
  await section(
    'Toutes commandes : delai moyen de saisie a reception (7 derniers jours), par type (10 plus lents)',
    `SELECT command_type, COUNT(*) AS n, ROUND(AVG(TIMESTAMPDIFF(SECOND, occurred_at, received_at))) AS attente_moy_s,
            MAX(TIMESTAMPDIFF(SECOND, occurred_at, received_at)) AS attente_max_s
       FROM sync_command_inbox WHERE received_at > NOW(6) - INTERVAL 7 DAY AND transport = 'SYNC_PUSH'
      GROUP BY command_type ORDER BY attente_moy_s DESC LIMIT 10`,
  );
  await section(
    'Commandes recues par jour (7 jours)',
    `SELECT DATE(received_at) AS jour, COUNT(*) AS n, SUM(status = 'APPLIED' OR status = 'APPLIED_WITH_WARNINGS') AS appliquees,
            SUM(status = 'REJECTED') AS rejetees, SUM(status = 'CONFLICT') AS conflits, SUM(status = 'FAILED_RETRYABLE') AS a_renvoyer
       FROM sync_command_inbox WHERE received_at > NOW(6) - INTERVAL 7 DAY GROUP BY DATE(received_at) ORDER BY jour DESC`,
  );
  await section(
    'Conflits de synchronisation par type et etat',
    'SELECT conflict_type, status, COUNT(*) AS n, MIN(created_at) AS premier FROM sync_sync_conflicts GROUP BY conflict_type, status ORDER BY n DESC LIMIT 20',
  );
  await section(
    'Flux de changements (sync_change_feed) : taille et age',
    'SELECT COUNT(*) AS lignes, MAX(seq) AS seq_max, MIN(recorded_at) AS plus_ancien, MAX(recorded_at) AS plus_recent FROM sync_change_feed',
  );
  await section(
    'Flux de changements : les 15 jeux les plus volumineux',
    'SELECT dataset, COUNT(*) AS n, MAX(seq) AS seq_max FROM sync_change_feed GROUP BY dataset ORDER BY n DESC LIMIT 15',
  );
  await section(
    'Flux de changements du jeu "device" : 10 dernieres lignes (publication des appareils)',
    `SELECT seq, entity_type, change_type, scope_type, row_version, recorded_at
       FROM sync_change_feed WHERE dataset = 'device' ORDER BY seq DESC LIMIT 10`,
  );

  // Une enveloppe de commande dont l'auteur ou l'agregat n'est pas un UUIDv7 fait refuser le LOT ENTIER (HTTP 400,
  // VALIDATION_ERROR) : la file de l'appareil reste alors bloquee. On cherche donc, table par table, les `id` qui n'en sont pas.
  console.log('\n== Identifiants (colonne id BINARY(16)) qui ne sont pas des UUIDv7, par table');
  try {
    const tables = await run(
      "SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'id' AND DATA_TYPE = 'binary' AND CHARACTER_MAXIMUM_LENGTH = 16 ORDER BY TABLE_NAME",
    );
    let found = 0;
    for (const { t } of tables) {
      const rows = await run(
        'SELECT COUNT(*) AS n FROM `' +
          t +
          "` WHERE NOT (SUBSTRING(HEX(id), 13, 1) = '7' AND SUBSTRING(HEX(id), 17, 1) IN ('8', '9', 'A', 'B'))",
      );
      const n = Number(rows[0].n);
      if (n > 0) {
        found += n;
        console.log('  ' + t + ' : ' + n + ' identifiant(s) qui ne sont pas des UUIDv7');
      }
    }
    console.log('  tables examinees : ' + tables.length + ', identifiants non UUIDv7 : ' + found);
  } catch (error) {
    console.log('  ECHEC de la lecture : ' + cell(error instanceof Error ? error.message : error));
  }
  await section(
    "Appareils : forme de l'identifiant (version, variante)",
    `SELECT short_code, status, SUBSTRING(HEX(id), 13, 1) AS version, SUBSTRING(HEX(id), 17, 1) AS variante
       FROM identity_devices ORDER BY created_at`,
  );
  await section(
    "Utilisateurs : forme de l'identifiant (version, variante) et etat",
    `SELECT HEX(SUBSTRING(id, 1, 4)) AS debut_id, SUBSTRING(HEX(id), 13, 1) AS version, SUBSTRING(HEX(id), 17, 1) AS variante, status
       FROM identity_users ORDER BY created_at`,
  );

  await run('ROLLBACK').catch(() => undefined);
  conn.release();
  await new Promise((resolve) => pool.end(() => resolve()));

  for (const name of ['stderr.log', 'console.log']) {
    console.log('\n== Journal ' + name + ' (fin du fichier, masque)');
    const tail = tailLines(name, 1_500_000, 5000);
    if (!tail) {
      console.log('  (fichier absent du dossier courant)');
      continue;
    }
    console.log('  taille=' + tail.size + ' octets, lignes lues=' + tail.window);
    const errors = tail.lines.filter((line) =>
      /error|erreur|ER_|exception|ECONN|ETIMEDOUT/i.test(line),
    ).length;
    console.log('  lignes contenant error/erreur/ER_/exception dans la fin du fichier : ' + errors);
    const tally = tallyStructured(tail.lines);
    if (tally.length > 0) {
      console.log('  journaux structures par niveau | module | commande | code :');
      for (const [key, n] of tally) console.log('    ' + String(n).padStart(5) + '  ' + cell(key));
    }
    const timeline = tallyByDay(tail.lines);
    if (timeline.length > 0) {
      console.log('  refus (niveau warn/error) par jour et code, journaux structures :');
      for (const [key, n] of timeline)
        console.log('    ' + String(n).padStart(5) + '  ' + cell(key));
    }
    const device = tail.lines.filter((line) => /identity\.device/.test(line)).slice(-10);
    if (device.length > 0) {
      console.log('  dernieres lignes sur identity.device.* :');
      for (const line of device) console.log('    ' + mask(line).slice(0, 400));
    }
    console.log('  ' + logLines + ' dernieres lignes :');
    for (const line of tail.lines.slice(-logLines)) console.log('    ' + mask(line).slice(0, 400));
  }
}

// Appele directement (ou par l'entree standard) : lance le diagnostic ; importe (essai) : rien ne s'execute.
if (!process.env.DIAG_SYNC_NO_RUN) {
  main().catch((error) => {
    console.error('Echec du diagnostic : ' + mask(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}

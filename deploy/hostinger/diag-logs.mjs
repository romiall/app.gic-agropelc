/**
 * Lecture des journaux d'erreurs du serveur, EN LECTURE SEULE : le script ne lit QUE les deux fichiers de journal du
 * dossier courant (stderr.log : journal de Nest et de l'ordonnanceur ; console.log : une ligne JSON par erreur de
 * l'API) et n'ouvre ni la base ni le fichier .env. Il ecrit seulement sur la sortie standard.
 *
 * Sert a trouver les erreurs qui reviennent en ligne (par exemple une requete SQL que MariaDB refuse, comme le
 * LAG(x, 1, 0) de sync.devices.seq_gap_check le 08/11/2026) : fin de chaque fichier, erreurs regroupees par
 * signature (identifiants, dates et nombres retires) avec leur nombre et leurs premiere et derniere dates, puis les
 * dernieres lignes d'erreur distinctes.
 *
 * Aucun mot de passe, jeton, adresse e-mail ni numero de telephone n'est affiche (masquage de la sortie), les lignes
 * sont tronquees a 400 caracteres et seule la fin des fichiers est lue (jamais le fichier entier).
 *
 * Usage, sur le serveur, dans le dossier de l'application, sans rien y copier (le script arrive par l'entree standard) :
 *   ssh ... "cd ~/domains/gic-agropelc.com/nodejs-app && node --input-type=module -" < diag-logs.mjs
 * Variables facultatives : DIAG_LOG_BYTES (defaut 3000000, octets lus a la fin de chaque fichier, 200000 a 20000000),
 * DIAG_LOG_SHOWN (defaut 12, nombre de lignes d'erreur distinctes affichees par fichier).
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
    .replace(/\+?\(?237\)?[\s.-]?[26](?:[\s.-]?\d){8}/g, '[numero]')
    .replace(/(?<![\d.:-])[26](?:[ .]?\d){8}(?![\d.:-])/g, '[numero]');
}

/** Fin d'un fichier de journal : les derniers octets seulement, jamais le fichier entier. */
export function tailLines(file, maxBytes) {
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
  // Les journaux de Nest portent des codes de couleur (ESC [ ... m) : retires, ils genent les dates et les regroupements.
  const lines = buffer
    .toString('utf8')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/);
  if (size > length) lines.shift(); // premiere ligne probablement coupee
  return { size, lines: lines.filter(Boolean) };
}

/** Une ligne est-elle une erreur ? (niveau error d'un journal JSON, ou mot-cle d'erreur dans un journal texte.) */
const ERROR_WORDS =
  /\b(error|erreur|exception|fatal|failed|echec)\b|ER_[A-Z_]+|ECONN[A-Z]*|ETIMEDOUT|ENOENT|EACCES|EPIPE|syntax|not supported|doesn't exist|does not exist|Unknown (column|function|table)|deadlock|timed out|unhandled/i;

export function isErrorLine(line) {
  if (line[0] === '{') {
    try {
      const entry = JSON.parse(line);
      const level = String(entry.level ?? entry.severity ?? '').toLowerCase();
      if (level === 'error' || level === 'fatal') return true;
      if (level === 'warn' || level === 'info' || level === 'debug') return false;
    } catch {
      /* ligne JSON coupee : jugee comme un texte */
    }
  }
  return ERROR_WORDS.test(line);
}

/** Date de la ligne, telle qu'ecrite : champ ts/time d'un journal JSON, ou en-tete de Nest, sinon rien. */
export function stampOf(line) {
  if (line[0] === '{') {
    try {
      const entry = JSON.parse(line);
      const value = entry.ts ?? entry.time ?? entry.timestamp;
      if (value !== undefined) return String(value).slice(0, 19);
    } catch {
      /* texte */
    }
  }
  const nest = /^\[Nest\]\s+\d+\s+-\s+(\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M)/.exec(line);
  if (nest) return nest[1];
  const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.exec(line);
  return iso ? iso[0] : '';
}

/**
 * Signature d'une ligne d'erreur : le texte masque, sans identifiants (UUID, hexadecimal long), dates ni nombres, pour
 * regrouper les occurrences d'une meme erreur. Une ligne JSON est ramenee a niveau | module | code | message.
 */
export function signature(line) {
  let text = line;
  if (line[0] === '{') {
    try {
      const entry = JSON.parse(line);
      const message =
        entry.message ??
        entry.msg ??
        entry.error?.message ??
        entry.err?.message ??
        entry.error ??
        '';
      text = [
        entry.level ?? entry.severity ?? '-',
        entry.module ?? '-',
        entry.commandType ?? entry.route ?? entry.path ?? '-',
        entry.code ?? '-',
        typeof message === 'string' ? message : JSON.stringify(message),
      ].join(' | ');
    } catch {
      /* texte */
    }
  }
  return mask(text)
    .replace(/\[Nest\]\s+\d+\s+-\s+\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/g, '[Nest]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<date>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Erreurs regroupees par signature : nombre, premiere et derniere date, un exemple (dernier). Les plus frequentes d'abord. */
export function groupErrors(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!isErrorLine(line)) continue;
    const key = signature(line);
    const stamp = stampOf(line);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (stamp) {
        group.last = stamp;
        if (!group.first) group.first = stamp;
      }
      group.sample = line;
    } else {
      groups.set(key, { signature: key, count: 1, first: stamp, last: stamp, sample: line });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function main() {
  const bytes = Math.max(
    200_000,
    Math.min(20_000_000, Number(process.env.DIAG_LOG_BYTES) || 3_000_000),
  );
  const shown = Math.max(3, Math.min(50, Number(process.env.DIAG_LOG_SHOWN) || 12));
  for (const name of ['stderr.log', 'console.log']) {
    console.log('\n== Journal ' + name + ' (fin du fichier, masque)');
    const tail = tailLines(name, bytes);
    if (!tail) {
      console.log('  (fichier absent du dossier courant)');
      continue;
    }
    const errors = tail.lines.filter(isErrorLine);
    const firstStamp = stampOf(tail.lines[0] ?? '');
    const lastStamp = stampOf(tail.lines[tail.lines.length - 1] ?? '');
    console.log(
      '  taille=' +
        tail.size +
        ' octets, lignes lues=' +
        tail.lines.length +
        (firstStamp || lastStamp
          ? ', du ' + (firstStamp || '?') + ' au ' + (lastStamp || '?')
          : ''),
    );
    console.log('  lignes d erreur dans la fin du fichier : ' + errors.length);
    const groups = groupErrors(tail.lines);
    if (groups.length === 0) {
      console.log('  aucune erreur dans la fin du fichier');
      continue;
    }
    console.log(
      '  erreurs regroupees par signature (nombre | premiere -> derniere date | signature) :',
    );
    for (const group of groups.slice(0, 25)) {
      console.log(
        '    ' +
          String(group.count).padStart(5) +
          ' | ' +
          (group.first || '?') +
          ' -> ' +
          (group.last || '?') +
          ' | ' +
          group.signature,
      );
    }
    if (groups.length > 25)
      console.log('    ... et ' + (groups.length - 25) + ' autre(s) signature(s)');
    console.log(
      '  derniere ligne de chacune des ' +
        Math.min(shown, groups.length) +
        ' signatures les plus recentes :',
    );
    const recent = [...groups]
      .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
      .slice(0, shown);
    for (const group of recent)
      console.log('    ' + mask(group.sample).replace(/\s+/g, ' ').slice(0, 400));
  }
}

// Appele directement (ou par l'entree standard) : lit les journaux ; importe (essai) : rien ne s'execute.
if (!process.env.DIAG_LOGS_NO_RUN) {
  try {
    main();
  } catch (error) {
    console.error('Echec de la lecture : ' + mask(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}

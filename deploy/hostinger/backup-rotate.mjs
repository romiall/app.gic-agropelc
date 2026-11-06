// Rotation des sauvegardes quotidiennes de la base (kit Hostinger ; voir backup-db.sh et README.md).
//
// Regle de conservation, appliquee aux seuls fichiers nommes gic-daily-AAAAMMJJ-HHMMSS.sql.gz du dossier donne :
//   1. toute sauvegarde de moins de --keep-days jours (14 par defaut) est gardee ;
//   2. la plus recente de chacun des --keep-months derniers mois civils (6 par defaut, le mois courant compris) est gardee ;
//   3. la sauvegarde la plus recente n'est jamais supprimee, quel que soit son age.
// Tout autre fichier du dossier (sauvegardes de livraison gic-<horodatage>.sql.gz du dossier parent, notes, partiels
// en cours d'ecriture) n'est jamais touche. Les dates des noms sont en UTC.
//
// Usage : node backup-rotate.mjs <dossier> [--keep-days N] [--keep-months M] [--dry-run]
// Sortie : une ligne par fichier supprime (ou qui le serait avec --dry-run), puis un resume ; code 0 si tout va bien.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^gic-daily-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sql\.gz$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date UTC portee par le nom d'une sauvegarde quotidienne, ou `null` si le nom n'est pas celui d'une sauvegarde. */
export function parseBackupName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Refuse une date impossible (30 fevrier) que Date aurait ramenee au mois suivant.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { name, date, month: `${m[1]}-${m[2]}` };
}

/** Rang du mois civil (nombre de mois depuis l'an 0) : permet de comparer deux mois sans calendrier. */
const monthRank = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

/**
 * Noms a supprimer parmi `names`. Pur : ne lit rien, ne supprime rien. Les noms qui ne sont pas des sauvegardes
 * quotidiennes ne sont jamais rendus.
 */
export function selectBackupsToDelete(names, { now, keepDays = 14, keepMonths = 6 }) {
  const backups = names
    .map(parseBackupName)
    .filter((entry) => entry !== null)
    .sort((a, b) => b.date - a.date || (a.name < b.name ? 1 : -1));
  if (backups.length === 0) return [];
  const keep = new Set([backups[0].name]);
  const oldestRecent = now.getTime() - keepDays * DAY_MS;
  const firstMonth = monthRank(now) - (keepMonths - 1);
  const newestOfMonth = new Set();
  for (const backup of backups) {
    if (backup.date.getTime() > oldestRecent) keep.add(backup.name);
    // Tri decroissant : la premiere sauvegarde vue d'un mois est la plus recente de ce mois.
    if (!newestOfMonth.has(backup.month)) {
      newestOfMonth.add(backup.month);
      if (monthRank(backup.date) >= firstMonth && monthRank(backup.date) <= monthRank(now)) {
        keep.add(backup.name);
      }
    }
  }
  return backups.filter((backup) => !keep.has(backup.name)).map((backup) => backup.name);
}

function main(argv) {
  const dir = argv[0];
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at === -1 ? fallback : Number(argv[at + 1]);
  };
  const keepDays = value('--keep-days', 14);
  const keepMonths = value('--keep-months', 6);
  const dryRun = argv.includes('--dry-run');
  if (
    !dir ||
    dir.startsWith('--') ||
    !Number.isInteger(keepDays) ||
    keepDays < 1 ||
    !Number.isInteger(keepMonths) ||
    keepMonths < 1
  ) {
    console.error(
      'Usage : node backup-rotate.mjs <dossier> [--keep-days N] [--keep-months M] [--dry-run]',
    );
    return 2;
  }
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error('Dossier introuvable : ' + dir);
    return 2;
  }
  const names = fs.readdirSync(dir);
  const doomed = selectBackupsToDelete(names, { now: new Date(), keepDays, keepMonths });
  for (const name of doomed) {
    console.log((dryRun ? 'serait supprimee : ' : 'supprimee : ') + name);
    if (!dryRun) fs.unlinkSync(path.join(dir, name));
  }
  const total = names.filter((name) => parseBackupName(name) !== null).length;
  console.log(
    `rotation : ${total - doomed.length} sauvegarde(s) gardee(s), ${doomed.length} ${dryRun ? 'a supprimer' : 'supprimee(s)'}`,
  );
  return 0;
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
  process.exit(main(process.argv.slice(2)));
}

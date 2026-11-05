// Essai de la rotation des sauvegardes quotidiennes (backup-rotate.mjs), sans serveur ni base :
//   node deploy/hostinger/test-backup-rotate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBackupName, selectBackupsToDelete } from './backup-rotate.mjs';

const stamp = (date) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `gic-daily-${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}.sql.gz`;
};
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-05T12:00:00Z');
const at = (iso) => stamp(new Date(iso));

// -- noms ------------------------------------------------------------------------------------------------------------
assert.equal(parseBackupName('gic-daily-20261105-020003.sql.gz').month, '2026-11');
assert.equal(
  parseBackupName('gic-20261105-144338.sql.gz'),
  null,
  'une sauvegarde de livraison n est pas une quotidienne',
);
assert.equal(
  parseBackupName('gic-daily-20261105-020003.sql.gz.partial'),
  null,
  'un partiel en cours n est pas une sauvegarde',
);
assert.equal(parseBackupName('gic-daily-20260230-020003.sql.gz'), null, 'date impossible');
assert.equal(parseBackupName('notes.txt'), null);

// -- politique par defaut (14 jours, 6 mois) ------------------------------------------------------------------------
const names = [];
for (let d = 0; d < 200; d += 1)
  names.push(stamp(new Date(Date.UTC(2026, 10, 5, 2, 0, 0) - d * DAY)));
const doomed = new Set(selectBackupsToDelete(names, { now: NOW }));
const kept = names.filter((name) => !doomed.has(name));
const keptDays = kept.map((name) => parseBackupName(name).date.toISOString().slice(0, 10));

// Les 14 derniers jours (du 23/10 au 05/11, la sauvegarde du 22/10 a 02 h a plus de 14 jours a midi) sont gardes.
for (let d = 0; d < 14; d += 1) {
  const day = new Date(Date.UTC(2026, 10, 5) - d * DAY).toISOString().slice(0, 10);
  assert.ok(keptDays.includes(day), `${day} doit etre gardee (moins de 14 jours)`);
}
assert.ok(!keptDays.includes('2026-10-22'), 'plus de 14 jours : supprimee');
// La plus recente de chacun des six derniers mois (juin a novembre) est gardee, les autres du mois non.
for (const day of ['2026-10-31', '2026-09-30', '2026-08-31', '2026-07-31', '2026-06-30']) {
  assert.ok(keptDays.includes(day), `${day} : derniere sauvegarde de son mois, a garder`);
}
for (const day of ['2026-10-15', '2026-09-29', '2026-07-01', '2026-06-01']) {
  assert.ok(!keptDays.includes(day), `${day} : ni recente ni derniere de son mois`);
}
// Au-dela de six mois : plus rien (sauf la plus recente de tout, ici de novembre).
assert.ok(!keptDays.some((day) => day < '2026-06-01'), 'avant juin 2026 : tout est supprime');
// Le 31/10 est deja dans les 14 jours : restent quatre fins de mois (septembre, aout, juillet, juin) en plus.
assert.equal(kept.length, 14 + 4, '14 jours + 4 fins de mois');

// -- jamais la derniere sauvegarde ----------------------------------------------------------------------------------
const lonely = [at('2025-01-01T02:00:00Z')];
assert.deepEqual(
  selectBackupsToDelete(lonely, { now: NOW }),
  [],
  'la seule sauvegarde est gardee quel que soit son age',
);
const old = [at('2025-01-01T02:00:00Z'), at('2025-01-02T02:00:00Z'), at('2025-01-03T02:00:00Z')];
assert.deepEqual(
  selectBackupsToDelete(old, { now: NOW }).sort(),
  [at('2025-01-01T02:00:00Z'), at('2025-01-02T02:00:00Z')].sort(),
  'toutes anciennes : seule la plus recente est gardee',
);

// -- parametres, autres fichiers, dossier vide ------------------------------------------------------------------------
const mixed = [
  at('2026-11-05T02:00:00Z'),
  at('2026-11-04T02:00:00Z'),
  at('2026-11-03T02:00:00Z'),
  'gic-20260101-000000.sql.gz',
  'LISEZMOI.txt',
  'gic-daily-20260101-000000.sql.gz.partial',
];
assert.deepEqual(
  selectBackupsToDelete(mixed, { now: NOW, keepDays: 1, keepMonths: 1 }).sort(),
  [at('2026-11-04T02:00:00Z'), at('2026-11-03T02:00:00Z')].sort(),
);
assert.deepEqual(selectBackupsToDelete([], { now: NOW }), []);
assert.deepEqual(selectBackupsToDelete(['LISEZMOI.txt'], { now: NOW }), []);
// Deux sauvegardes le meme jour : la plus tardive est la derniere du mois.
const twice = [
  at('2026-10-31T02:00:00Z'),
  at('2026-10-31T23:00:00Z'),
  at('2026-10-30T02:00:00Z'),
  at('2026-11-05T02:00:00Z'),
];
const twiceDoomed = selectBackupsToDelete(twice, { now: NOW, keepDays: 3, keepMonths: 2 });
assert.deepEqual(
  twiceDoomed.sort(),
  [at('2026-10-30T02:00:00Z'), at('2026-10-31T02:00:00Z')].sort(),
);

// -- ligne de commande : suppression reelle dans un dossier temporaire, rien d'autre n'est touche -------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gic-rotate-'));
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const todayIso = (offsetDays) => new Date(Date.now() - offsetDays * DAY).toISOString();
  const recent = at(todayIso(1));
  const stale = at(todayIso(400));
  const newer = at(todayIso(300));
  for (const name of [recent, stale, newer, 'gic-20260101-000000.sql.gz', 'LISEZMOI.txt'])
    fs.writeFileSync(path.join(tmp, name), 'x');
  const dry = execFileSync(
    process.execPath,
    [path.join(here, 'backup-rotate.mjs'), tmp, '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.match(dry, /serait supprimee : /);
  assert.ok(fs.existsSync(path.join(tmp, stale)), 'avec --dry-run rien n est supprime');
  const real = execFileSync(
    process.execPath,
    [path.join(here, 'backup-rotate.mjs'), tmp, '--keep-days', '14', '--keep-months', '1'],
    { encoding: 'utf8' },
  );
  assert.match(real, /rotation : 1 sauvegarde\(s\) gardee\(s\), 2 supprimee\(s\)/);
  assert.deepEqual(
    fs.readdirSync(tmp).sort(),
    [recent, 'LISEZMOI.txt', 'gic-20260101-000000.sql.gz'].sort(),
  );
  let code = 0;
  try {
    execFileSync(
      process.execPath,
      [path.join(here, 'backup-rotate.mjs'), path.join(tmp, 'absent')],
      { stdio: 'pipe' },
    );
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 2, 'dossier introuvable : code 2');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  'OK : rotation des sauvegardes quotidiennes (nommage, 14 jours, fins de mois, derniere gardee, ligne de commande)',
);

/**
 * Essai de diag-logs.mjs (aucune base, aucun reseau) :
 *   node deploy/hostinger/test-diag-logs.mjs
 * Le diagnostic en ligne ne doit jamais laisser sortir un secret et ne doit lire que les deux journaux.
 * Fichier ASCII volontairement.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DIAG_LOGS_NO_RUN = '1';
const { groupErrors, isErrorLine, mask, signature, stampOf, tailLines } =
  await import('./diag-logs.mjs');

// Masquage : memes garanties que diag-sync.mjs et diag-jobs.mjs.
for (const [input, expected] of [
  ['mysql://gic_app:Sup3rSecret@127.0.0.1:3306/gic', 'mysql://[masque]'],
  ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer [masque]'],
  ['{"password":"hunter2","x":1}', '"password":[masque]'],
  ['valeur eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl fin', '[jeton]'],
  ['contact jean.dupont@example.com ok', '[courriel]'],
  ['appelez +237 677 12 34 56 ou 677123456', '[numero]'],
]) {
  const output = mask(input);
  assert.ok(output.includes(expected), 'attendu ' + expected + ' dans : ' + output);
}
for (const secret of ['Sup3rSecret', 'hunter2', 'c2lnbmF0dXJl', 'jean.dupont', '677123456']) {
  assert.ok(
    !mask(
      'mysql://u:Sup3rSecret@h/d {"password":"hunter2"} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl jean.dupont@example.com 677123456',
    ).includes(secret),
    'secret restant : ' + secret,
  );
}

// Lignes d'erreur : niveau d'un journal JSON, mots-cles d'un journal texte.
assert.equal(isErrorLine('{"level":"error","module":"sync","code":"X"}'), true);
assert.equal(isErrorLine('{"level":"warn","message":"error en apparence"}'), false);
assert.equal(isErrorLine('{"level":"info","message":"ok"}'), false);
assert.equal(
  isErrorLine(
    '[Nest] 12  - 11/08/2026, 1:34:49 PM   ERROR [JobWorker] You have an error in your SQL syntax',
  ),
  true,
);
assert.equal(
  isErrorLine('[Nest] 12  - 11/08/2026, 1:34:49 PM     LOG [DeviceSeqGapAlertJob] 3 appareil(s)'),
  false,
);

// Dates telles qu'ecrites.
assert.equal(stampOf('{"level":"error","ts":"2026-11-08T12:00:34.775Z"}'), '2026-11-08T12:00:34');
assert.equal(
  stampOf('[Nest] 12  - 11/08/2026, 1:34:49 PM   ERROR [X] boom'),
  '11/08/2026, 1:34:49 PM',
);
assert.equal(stampOf('sans date'), '');

// Signature : identifiants, dates et nombres retires, donc deux occurrences d'une meme erreur se regroupent.
const a =
  '[Nest] 12  - 11/08/2026, 1:34:49 PM   ERROR [JobWorker] job 0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee failed after 5 attempts at 2026-11-08T12:00:34.775Z';
const b =
  '[Nest] 14  - 11/08/2026, 2:00:35 PM   ERROR [JobWorker] job 0190ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee failed after 3 attempts at 2026-11-08T13:00:35.001Z';
assert.equal(signature(a), signature(b));
assert.ok(!/\d/.test(signature(a).replace('<n>', '')), 'chiffres restants : ' + signature(a));

// Regroupement : compte, premiere et derniere date, tri par frequence.
const lines = [
  a,
  b,
  '{"level":"error","ts":"2026-11-08T10:00:00.000Z","module":"sales","code":"BOOM","message":"timeout apres 30 s"}',
  '{"level":"info","ts":"2026-11-08T10:00:01.000Z","message":"ok"}',
  '{"level":"error","ts":"2026-11-08T11:00:00.000Z","module":"sales","code":"BOOM","message":"timeout apres 45 s"}',
];
const groups = groupErrors(lines);
assert.equal(groups.length, 2);
assert.equal(groups[0].count, 2);
assert.equal(groups[0].first, '11/08/2026, 1:34:49 PM');
assert.equal(groups[0].last, '11/08/2026, 2:00:35 PM');
assert.equal(groups[1].count, 2);
assert.equal(groups[1].first, '2026-11-08T10:00:00');
assert.equal(groups[1].last, '2026-11-08T11:00:00');

// Fin d'un fichier : les derniers octets seulement, la premiere ligne (coupee) est retiree.
const dir = mkdtempSync(path.join(tmpdir(), 'gic-diag-logs-'));
try {
  const file = path.join(dir, 'stderr.log');
  const body =
    Array.from({ length: 400 }, (_, i) => 'ligne numero ' + String(i).padStart(4, '0')).join('\n') +
    '\n';
  writeFileSync(file, body);
  const tail = tailLines(file, 300);
  assert.ok(tail.size > 300 && tail.lines.length < 20, 'fin du fichier seulement');
  assert.equal(tail.lines[tail.lines.length - 1], 'ligne numero 0399');
  assert.ok(!tail.lines[0].startsWith('igne'), 'la premiere ligne coupee est retiree');
  assert.equal(tailLines(path.join(dir, 'absent.log'), 300), null);

  // Les codes de couleur de Nest sont retires (sinon la date et le regroupement echouent).
  const colored = path.join(dir, 'colored.log');
  writeFileSync(
    colored,
    '\u001b[31m[Nest] 12  - \u001b[39m11/08/2026, 1:34:49 PM \u001b[31m ERROR\u001b[39m [JobRunner] boom 7\n',
  );
  const clean = tailLines(colored, 10_000).lines[0];
  assert.ok(!clean.includes('\u001b'), 'codes de couleur restants');
  assert.equal(stampOf(clean), '11/08/2026, 1:34:49 PM');

  // De bout en bout : le script lu en entier, dans un dossier qui ne contient que les deux journaux.
  writeFileSync(
    path.join(dir, 'stderr.log'),
    [a, b, '[Nest] 14  - 11/08/2026, 2:00:36 PM     LOG [X] ok'].join('\n') + '\n',
  );
  writeFileSync(
    path.join(dir, 'console.log'),
    [
      '{"level":"error","ts":"2026-11-08T10:00:00.000Z","module":"identity","code":"LOGIN","message":"mot de passe: hunter2 pour jean.dupont@example.com"}',
      '{"level":"warn","ts":"2026-11-08T10:00:01.000Z","message":"rien"}',
    ].join('\n') + '\n',
  );
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'diag-logs.mjs');
  const env = { ...process.env };
  delete env.DIAG_LOGS_NO_RUN;
  const output = execFileSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
  assert.ok(output.includes('== Journal stderr.log'), output);
  assert.ok(output.includes('== Journal console.log'), output);
  assert.ok(/\b2 \| 11\/08\/2026, 1:34:49 PM -> 11\/08\/2026, 2:00:35 PM \|/.test(output), output);
  assert.ok(output.includes('[courriel]') && output.includes('[masque]'), output);
  for (const secret of ['hunter2', 'jean.dupont']) {
    assert.ok(!output.includes(secret), 'secret dans la sortie : ' + secret);
  }
  // Sans journaux : message clair, code de sortie 0.
  const empty = mkdtempSync(path.join(tmpdir(), 'gic-diag-logs-empty-'));
  try {
    const none = execFileSync(process.execPath, [script], { cwd: empty, env, encoding: 'utf8' });
    assert.ok(none.includes('(fichier absent du dossier courant)'), none);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('diag-logs : tous les essais passent.');

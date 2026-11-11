/**
 * Essai du masquage de diag-jobs.mjs (aucune base, aucun reseau) :
 *   node deploy/hostinger/test-diag-jobs.mjs
 * Le diagnostic en ligne ne doit jamais laisser sortir un secret : ces cas en sont la garantie.
 * Fichier ASCII volontairement.
 */
import assert from 'node:assert/strict';

process.env.DIAG_JOBS_NO_RUN = '1';
const { mask } = await import('./diag-jobs.mjs');

const cases = [
  ['mysql://gic_app:Sup3rSecret@127.0.0.1:3306/gic', 'mysql://[masque]'],
  ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer [masque]'],
  ['{"password":"hunter2","x":1}', '"password":[masque]'],
  ['mot de passe: hunter2', 'mot de passe: [masque]'],
  ['valeur eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl fin', '[jeton]'],
  ['contact jean.dupont@example.com ok', '[courriel]'],
  ['appelez +237 677 12 34 56 ou 677123456', '[numero]'],
  ['joignable au +237677123456', '[numero]'],
  ['tel 6 77 12 34 56 ou 677.12.34.56 ou (+237) 699-12-34-56', '[numero]'],
];
for (const [input, expected] of cases) {
  const output = mask(input);
  assert.ok(output.includes(expected), 'attendu ' + expected + ' dans : ' + output);
}
// Aucun fragment d'un secret ne reste, y compris les groupes d'un numero ecrit avec des espaces.
const secrets = [
  'Sup3rSecret',
  'hunter2',
  'jean.dupont',
  '677123456',
  'c2lnbmF0dXJl',
  '677 12 34 56',
  '12 34 56',
  '677.12.34',
  '699-12',
  '+237677',
  '237677',
];
for (const secret of secrets) {
  for (const [input] of cases)
    assert.ok(!mask(input).includes(secret), 'secret restant : ' + secret + ' dans ' + mask(input));
}
assert.equal(mask('joignable au +237677123456'), 'joignable au [numero]');
assert.equal(mask('appelez +237 677 12 34 56 ou 677123456'), 'appelez [numero] ou [numero]');

// Les horodatages, identifiants et noms de tache ne sont pas pris pour des numeros de telephone.
const stamp =
  'derniere=2026-11-08 12:00:34.775000 | sync.devices.seq_gap_check | 01a1a5ab-8f68-7afb-8564-8c4b1f6b6ab0';
assert.equal(mask(stamp), stamp);

// Le message d'erreur d'une tache (erreur SQL) reste lisible : seul ce qui ressemble a un secret est masque.
const sqlError =
  "You have an error in your SQL syntax; check the manual near ' 0) OVER w + 1 AS from_seq' at line 3";
assert.equal(mask(sqlError), sqlError);

console.log('diag-jobs : tous les essais de masquage passent.');

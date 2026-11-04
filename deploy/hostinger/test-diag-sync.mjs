/**
 * Essai du masquage et du comptage de diag-sync.mjs (aucune base, aucun reseau) :
 *   node deploy/hostinger/test-diag-sync.mjs
 * Le diagnostic en ligne ne doit jamais laisser sortir un secret : ces cas en sont la garantie.
 * Fichier ASCII volontairement.
 */
import assert from 'node:assert/strict';

process.env.DIAG_SYNC_NO_RUN = '1';
const { mask, tallyStructured } = await import('./diag-sync.mjs');

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
// Aucun fragment d'un secret ne reste, y compris les groupes d'un numero ecrit avec des espaces (un numero ecrit a
// l'indicatif pres ne doit pas laisser ses derniers chiffres : l'ancien masque en laissait un).
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

// Les horodatages et identifiants ne sont pas pris pour des numeros de telephone.
const stamp = '2026-11-04T10:12:13.123Z id 01a1a5ab-8f68-7afb-8564-8c4b1f6b6ab0 seq 1730718000000';
assert.equal(mask(stamp), stamp);
const sqlStamp = 'cree le 2026-11-04 10:12:13 puis 2026-11-04 12:05:57 (26 11 2026)';
assert.equal(mask(sqlStamp), sqlStamp);

const lines = [
  '{"level":"warn","module":"identity","commandType":"identity.device.approve","code":"SERVER_BUSY"}',
  '{"level":"warn","module":"identity","commandType":"identity.device.approve","code":"SERVER_BUSY"}',
  '{"level":"info","module":"crm","commandType":"crm.visit.record","code":"APPLIED"}',
  'ligne non JSON',
  '{"casse',
];
const tally = tallyStructured(lines);
assert.equal(tally[0][1], 2);
assert.match(tally[0][0], /identity\.device\.approve \| SERVER_BUSY/);
assert.equal(tally.length, 2);

console.log('diag-sync : tous les essais de masquage et de comptage passent.');

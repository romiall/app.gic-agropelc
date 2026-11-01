/**
 * Essai local de reporting-import-mapping.mjs sur des donnees SYNTHETIQUES (aucune donnee de personne).
 * Usage, a la racine du depot :  node deploy/hostinger/test-reporting-import-mapping.mjs
 */
import assert from 'node:assert/strict';
import * as map from './reporting-import-mapping.mjs';

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log('  ok  ' + name);
};

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const e = (s) => s; // les accents des libelles du classeur sont ecrits en \u dans ce fichier ASCII

/** Ligne de la feuille Clients (23 colonnes). */
function client(n, o = {}) {
  const v = [
    n,
    `RESCOM-${String(n).padStart(3, '0')}`,
    o.name ?? `CLIENT TEST ${n}`,
    'Prospect',
    o.type ?? 'Restaurant',
    o.contact ?? 'Responssable',
    o.phone ?? `65500${String(n).padStart(4, '0')}`,
    '',
    o.quartier ?? 'Bonab\u00e9ri',
    o.repere ?? 'face station',
    '',
    '',
    o.source ?? 'Prospection terrain',
    o.step ?? 'Nouveau',
    o.created ?? '2026-10-12T00:00:00',
    o.product ?? 'Poulet de chair entier',
    o.potential ?? '10',
    o.unit ?? 'Pi\u00e8ce',
    o.payment ?? 'Orange Money',
    '',
    '',
    '',
    o.obs ?? 'Prospect',
  ];
  return { ligne: 5 + n, v };
}

/** Ligne de la feuille Visites_Contacts (22 colonnes). */
function contact(ref, customerN, o = {}) {
  const v = [
    ref,
    `RESCOM-V${String(ref).padStart(5, '0')}`,
    o.date ?? '2026-10-13T00:00:00',
    o.time ?? '10:15',
    o.type ?? 'Visite sur place',
    `Nom [${customerN}]`,
    o.objet ?? 'Pr\u00e9sentation produits et prix',
    o.result ?? '\u00c0 relancer',
    '',
    '',
    o.nextDate ?? '2026-10-20T00:00:00',
    o.nextText ?? 'Rappeler ',
    '',
    '',
    '',
    'RESCOM',
    customerN,
    `RESCOM|${customerN}`,
    `RESCOM-${String(customerN).padStart(3, '0')}`,
    '',
    '',
    '2026-S42',
  ];
  return { ligne: 5 + ref, v };
}

const journalRow = (day, ligne) => ({
  ligne,
  v: [
    `${day}T00:00:00`,
    'RESCOM',
    'Lundi',
    '2026-S42',
    '08:30',
    '17:30',
    'PK13',
    3000,
    9,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    '',
    '',
    '',
    '',
  ],
});

const source = {
  clients: [
    client(1, {
      created: '2026-09-07T00:00:00',
      obs: 'Repris de la fiche de septembre 2026 (semaine 2).',
      quartier: 'PK 12',
    }),
    client(2, {
      created: '2026-09-21T00:00:00',
      obs: 'Repris de la fiche de septembre 2026 (semaine 4).',
      quartier: 'PK12',
      type: 'Autre',
    }),
    client(3, {
      quartier: 'PK12',
      step: 'Contact\u00e9',
      type: 'Boutique / sup\u00e9rette / supermarch\u00e9',
    }),
    client(4, {
      quartier: 'Autre',
      step: 'Int\u00e9ress\u00e9',
      type: 'Particulier / m\u00e9nage',
    }),
    client(5, {
      phone: '6578909123',
      name: 'CLIENT TEST 1',
      type: 'Boulangerie / p\u00e2tisserie',
    }), // 10 chiffres ; meme nom que le 1
    client(6, { phone: '+237 655 00 06 06', created: '2026-10-14T00:00:00' }), // meme numero national que le 7
    client(7, {
      phone: '655000606',
      created: '2026-10-15T00:00:00',
      obs: 'x'.repeat(480) + ' fin',
    }),
  ],
  contacts: [
    contact(1, 3, { date: '2026-10-13T00:00:00', time: '09:00', result: 'Rendez-vous fix\u00e9' }),
    contact(2, 3, {
      date: '2026-10-14T00:00:00',
      time: '11:30',
      type: 'Appel t\u00e9l\u00e9phonique',
      result: 'Absent / ferm\u00e9',
    }),
    contact(3, 4, {
      date: '2026-10-16T00:00:00',
      time: '08:00',
      type: 'Appel t\u00e9l\u00e9phonique',
      nextText: 'Message Whatssap',
    }),
    contact(4, 1, { date: '2026-10-09T00:00:00', time: '16:00', result: 'Absent / ferm\u00e9' }),
  ],
  journal: [journalRow('2026-10-08', 6), journalRow('2026-10-09', 7)],
};
const plan = map.buildPlan(source);
const anomaly = (code) => plan.anomalies.filter((a) => a.code === code);

check('decomptes des feuilles et du plan', () => {
  assert.equal(plan.customers.length, 7);
  assert.equal(plan.visits.length, 2);
  assert.equal(plan.interactions.length, 2);
  assert.equal(plan.journal.length, 2);
  assert.equal(plan.stats.contacts, 4);
  assert.equal(plan.anomalies.filter((a) => a.severity === 'ERREUR').length, 0);
});

check('une zone par quartier sous la racine, orthographes fusionnees, Autre nomme', () => {
  const codes = plan.zones.map((z) => z.code);
  assert.deepEqual(codes, ['DOUALA', 'DOUALA-AUTRE-QUARTIER', 'DOUALA-BONABERI', 'DOUALA-PK12']);
  assert.equal(plan.zones[0].level, 'VILLE');
  assert.ok(plan.zones.slice(1).every((z) => z.level === 'QUARTIER' && z.parentCode === 'DOUALA'));
  const pk12 = plan.zones.find((z) => z.code === 'DOUALA-PK12');
  assert.equal(pk12.name, 'PK12'); // orthographe majoritaire (2 contre 1)
  assert.equal(pk12.count, 3);
  assert.equal(anomaly('QUARTIER_ORTHOGRAPHES').length, 1);
  assert.ok(plan.customers.every((c) => c.zoneCode !== null));
});

check("categories, type de compte et activite d'origine", () => {
  const by = (n) => plan.customers.find((c) => c.number === n);
  assert.equal(by(3).categoryCode, 'REVENDEUR');
  assert.equal(by(3).customerType, 'ENTREPRISE');
  assert.equal(by(4).categoryCode, 'PARTICULIER');
  assert.equal(by(4).customerType, 'PARTICULIER');
  assert.equal(by(2).categoryCode, null); // type Autre : categorie vide
  assert.equal(by(2).customerType, null);
  assert.equal(by(5).categoryCode, null); // boulangerie : aucune categorie ne convient
  assert.equal(by(1).categoryCode, 'RESTAURATION_HOTELLERIE');
  assert.equal(by(1).businessActivity, 'Restaurant');
  assert.equal(anomaly('CATEGORIE_VIDE').length, 2);
});

check('telephones : 9 chiffres valides, 10 chiffres signale mais importe tel que saisi', () => {
  assert.equal(map.phoneInfo('655 12 34 56').national, '655123456');
  assert.equal(map.phoneInfo('+237 655 12 34 56').valid, true);
  assert.equal(map.phoneInfo('+237 655 12 34 56').national, '655123456');
  assert.equal(map.phoneInfo('6578909123').valid, false);
  assert.equal(map.phoneInfo('').empty, true);
  const ten = plan.customers.find((c) => c.number === 5);
  assert.equal(ten.phonePrimary, '6578909123');
  assert.equal(anomaly('TELEPHONE_NON_CAMEROUNAIS').length, 1);
  assert.ok(ten.reason.includes('tel. a 10 chiffres'));
});

check('doublons signales, jamais fusionnes', () => {
  assert.deepEqual(plan.duplicates.phones, [[6, 7]]); // +237 655 00 06 06 et 655000606 : meme numero national
  assert.deepEqual(plan.duplicates.names, [[1, 5]]);
  assert.equal(plan.customers.length, 7);
});

check(
  "prospects repris de septembre : acquis au debut d'usage, date d'origine dans le motif",
  () => {
    const sept = plan.customers.find((c) => c.number === 1);
    assert.equal(sept.septembre, true);
    assert.equal(sept.occurredAt, '2026-10-08T00:00:00+01:00');
    assert.ok(
      sept.reason.includes(
        'fiche de septembre (cr\u00e9\u00e9 le 07/09/2026), reprise le 08/10/2026',
      ),
    );
    const recent = plan.customers.find((c) => c.number === 6);
    assert.equal(recent.occurredAt, '2026-10-14T00:00:00+01:00');
  },
);

check(
  'contacts : visite, appel, resultat sans motif dedie, prochaine action, heure locale +01:00',
  () => {
    const rdv = plan.visits.find((v) => v.ref === 'RESCOM-V00001');
    assert.equal(rdv.outcomeCode, 'A_RELANCER');
    assert.ok(rdv.text.includes('R\u00e9sultat saisi : Rendez-vous fix\u00e9'));
    assert.equal(rdv.occurredAt, '2026-10-13T09:00:00+01:00');
    assert.equal(rdv.nextActionAt, '2026-10-20');
    assert.equal(rdv.nextActionNote, 'Rappeler');
    assert.equal(anomaly('RDV_VERS_A_RELANCER').length, 1);
    const absent = plan.visits.find((v) => v.ref === 'RESCOM-V00004');
    assert.equal(absent.outcomeCode, 'ABSENT');
    const call = plan.interactions.find((i) => i.ref === 'RESCOM-V00002');
    assert.equal(call.channel, 'APPEL');
    assert.equal(call.direction, 'SORTANT');
    assert.ok(call.reason.includes('heure saisie 11:30 (approximative)'));
    assert.equal(
      plan.interactions.find((i) => i.ref === 'RESCOM-V00003').nextActionNote,
      'Message Whatssap',
    );
  },
);

check('etapes : date du premier contact, sinon jour de creation + 1 minute', () => {
  const contacted = plan.stepChanges.find((s) => s.customerNumber === 3);
  assert.equal(contacted.stepCode, 'CONTACTE');
  assert.equal(contacted.occurredAt, new Date('2026-10-13T09:00:00+01:00').toISOString());
  const interested = plan.stepChanges.find((s) => s.customerNumber === 4);
  assert.equal(interested.stepCode, 'INTERESSE');
  assert.equal(interested.occurredAt, new Date('2026-10-16T08:00:00+01:00').toISOString()); // premier contact du 4
  assert.equal(plan.stepChanges.length, 2);
  assert.equal(anomaly('ETAPE_SANS_CONTACT').length, 0);
});

check('motif de reprise plafonne a 500 caracteres, ligne source complete conservee', () => {
  const long = plan.customers.find((c) => c.number === 7);
  assert.ok(long.reason.length <= map.MAX_REASON);
  assert.ok(anomaly('MOTIF_ABREGE').length >= 1);
  assert.equal(long.legacy.valeurs.Observations.length, 484);
  assert.equal(long.legacy.feuille, 'Clients');
  assert.equal(long.legacy.ligne, long.ligne);
});

check('identifiants deterministes, UUIDv7, independants des options', () => {
  const ids = [...plan.customers, ...plan.visits, ...plan.interactions].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => UUIDV7.test(id)));
  const again = map.buildPlan(source, { managerStart: '2026-10-09' });
  assert.deepEqual(again.customers.map((c) => c.id).sort(), plan.customers.map((c) => c.id).sort());
  assert.equal(map.entityId('zone', 'DOUALA', 0), map.entityId('zone', 'DOUALA', 0));
  assert.notEqual(
    map.commandIdOf('r1', 'crm.customer.create', 'RESCOM|1', 1),
    map.commandIdOf('r2', 'crm.customer.create', 'RESCOM|1', 1),
  );
  assert.ok(UUIDV7.test(map.commandIdOf('r1', 'crm.visit.record', 'RESCOM-V00001', 1760000000000)));
});

check(
  'erreurs bloquantes : contact avant la creation, client introuvable, numero en double',
  () => {
    const bad = map.buildPlan({
      clients: [client(1, { created: '2026-10-20T00:00:00' }), client(1)],
      contacts: [contact(1, 1, { date: '2026-10-13T00:00:00' }), contact(2, 99)],
      journal: [],
    });
    const codes = bad.anomalies.filter((a) => a.severity === 'ERREUR').map((a) => a.code);
    assert.ok(codes.includes('CLIENT_NUMERO_EN_DOUBLE'));
    assert.ok(codes.includes('CONTACT_AVANT_CREATION'));
    assert.ok(codes.includes('CONTACT_CLIENT_INTROUVABLE'));
  },
);

check('charges des commandes : champs vides omis, ligne source jointe', () => {
  const refs = {
    zoneIds: new Map(plan.zones.map((z) => [z.code, `zone-${z.code}`])),
    categoryIds: new Map([
      ['REVENDEUR', 'cat-r'],
      ['PARTICULIER', 'cat-p'],
      ['RESTAURATION_HOTELLERIE', 'cat-h'],
    ]),
    outcomeIds: new Map([
      ['A_RELANCER', 'out-r'],
      ['ABSENT', 'out-a'],
    ]),
  };
  const c = plan.customers.find((x) => x.number === 2);
  const p = map.customerPayload(c, refs);
  assert.equal(p.zoneId, 'zone-DOUALA-PK12');
  assert.ok(
    !('categoryId' in p) && !('customerType' in p) && !('contactName' in p) && !('position' in p),
  );
  assert.equal(p.legacy.feuille, 'Clients');
  assert.equal(p.addressText, 'Quartier : PK12 - Rep\u00e8re : face station');
  const v = map.visitPayload(plan.visits[0], 'cust-id', refs);
  assert.equal(v.customerId, 'cust-id');
  assert.equal(v.position, null);
  assert.ok(typeof v.outcomeReasonCodeId === 'string');
  const i = map.interactionPayload(plan.interactions[0], 'cust-id');
  assert.equal(i.channel, 'APPEL');
  assert.ok(i.legacy.valeurs['R\u00e9f. de la ligne']);
});

check('journal : archive complet, aucune commande', () => {
  assert.equal(plan.journal[0].day, '2026-10-08');
  assert.equal(plan.journal[0].valeurs['Zone / quartier du jour'], 'PK13');
  assert.equal(plan.journal[0].valeurs['Frais engag\u00e9s (XAF)'], 3000);
  assert.equal(plan.journal[0].feuille, 'Journal');
});

console.log(`\n${checks} controles passes.`);

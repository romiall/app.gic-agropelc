/**
 * Reprise du classeur de reporting du responsable commercial (GIC_Reporting_Commercial_v2.0, 08 au 31/10/2026) :
 * correspondance feuilles Excel -> commandes de l'application. Logique PURE (aucune entree-sortie, aucune base) :
 * essayee sans serveur par test-reporting-import-mapping.mjs, reutilisee par import-reporting-commercial.mjs.
 * Fichier en ASCII, comme les autres scripts du kit : les accents des textes ecrits en base sont des sequences \u.
 *
 * Decisions du porteur (01/11/2026) : aucun changement de schema ; une zone par quartier sous une racine VILLE ;
 * ecriture par les vraies commandes (faits accomplis dates d'octobre, motif de retrodatation) avec le responsable
 * pour auteur ; doublons : tout importer, rien fusionner ; informations sans champ : resume dans le motif de reprise
 * et ligne source complete jointe a la charge de la commande (conservee par le journal d'audit) ; journal de 14
 * jours : archive dans le rapport, pas de session de travail (ni GPS, ni derogation approuvee).
 *
 * Forme des donnees d'entree (donnees_extraites.json) : { clients, contacts, journal }, chaque ligne
 * { ligne: numero de ligne Excel, v: [valeurs des colonnes dans l'ordre du classeur] }.
 */
import { createHash } from 'node:crypto';

export const TZ_OFFSET = '+01:00'; // Africa/Douala, sans heure d'ete
export const DEFAULT_CLASSEUR = 'GIC_Reporting_Commercial_v2.0_DEMARRAGE_Sept2026-2.xlsx';
export const DEFAULT_CLASSEUR_DATE = '2026-10-31';
export const DEFAULT_MANAGER_START = '2026-10-08';
export const DEFAULT_COMMERCIAL_CODE = 'RESCOM';
export const ROOT_ZONE = { code: 'DOUALA', name: 'Douala', level: 'VILLE' };
export const MAX_REASON = 500; // envelope.backdated_reason
export const ID_NAMESPACE = 'rescom-import';

/** Intitules exacts des colonnes du classeur (ligne 5 de chaque feuille). */
export const HEADERS = {
  clients: [
    'N\u00b0',
    'Code client',
    'Enseigne / nom du client',
    'Statut (automatique)',
    'Type de client',
    'Interlocuteur (personne \u00e0 contacter)',
    'T\u00e9l\u00e9phone principal',
    'T\u00e9l\u00e9phone 2 / WhatsApp',
    'Quartier / zone',
    'Localisation pr\u00e9cise / point de rep\u00e8re',
    'Latitude',
    'Longitude',
    'Source du prospect',
    '\u00c9tape du pipeline',
    'Date de cr\u00e9ation',
    "Produit principal d'int\u00e9r\u00eat",
    'Potentiel estim\u00e9 par jour (quantit\u00e9)',
    'Unit\u00e9',
    'Mode de paiement habituel',
    'Paiement diff\u00e9r\u00e9 demand\u00e9 ?',
    'Compte perdu ?',
    'Motif de perte',
    'Observations',
  ],
  contacts: [
    'N\u00b0',
    'R\u00e9f. de la ligne',
    'Date',
    'Heure',
    'Type de contact',
    'Client / prospect',
    'Objet du contact',
    'R\u00e9sultat',
    'Fournisseur actuel / concurrent',
    'Prix concurrent constat\u00e9 (XAF)',
    'Prochaine action : date',
    'Prochaine action : \u00e0 faire',
    'Latitude',
    'Longitude',
    'Notes',
    'Commercial',
    'N\u00b0 client',
    'Cl\u00e9 client',
    'Code client',
    'Nom du client',
    'Quartier',
    'Semaine',
  ],
  journal: [
    'Date',
    'Commercial',
    'Jour',
    'Semaine',
    'Prise de service (heure)',
    'Fin de service (heure)',
    'Zone / quartier du jour',
    'Frais engag\u00e9s (XAF)',
    'Dur\u00e9e (h)',
    'Visites sur place',
    'Contacts \u00e0 distance',
    'Nouveaux prospects',
    'Nouveaux clients',
    'Commandes prises (nb)',
    'Commandes prises (XAF)',
    'CA r\u00e9alis\u00e9 (XAF)',
    'Encaiss\u00e9 (XAF)',
    'Casses et pertes (XAF)',
    'R\u00e9ussites du jour',
    'Difficult\u00e9s rencontr\u00e9es',
    'Besoin de soutien (direction)',
    'Plan du lendemain',
  ],
};
const SHEET_NAMES = { clients: 'Clients', contacts: 'Visites_Contacts', journal: 'Journal' };

// --- Outils de texte ----------------------------------------------------------------------------------------

const str = (value) => (value === null || value === undefined ? '' : String(value));

/** Texte nettoye (espaces repliees, bords retires) ; `null` s'il est vide. */
export function clean(value) {
  const text = str(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Cle de comparaison : sans accents, sans casse, espaces repliees. */
export function fold(value) {
  return str(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function dayOf(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(value));
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? null : day;
}

function timeOf(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(str(value));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

export const localIso = (day, hhmm) => `${day}T${hhmm}:00${TZ_OFFSET}`;
export const dmy = (day) => day.split('-').reverse().join('/');
const addMinutes = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();

// --- Identifiants deterministes (UUIDv7, ADR-002) --------------------------------------------------------------

/**
 * UUIDv7 reproductible : 48 bits de temps (ms) + version 7 + variante, le reste derive d'un SHA-256 de la cle. Une
 * meme cle redonne le meme identifiant (reprise sans doublon) ; la valeur passe `isUuidv7` du domaine.
 */
export function deterministicUuidV7(key, timestampMs) {
  const hash = createHash('sha256').update(key).digest();
  const bytes = Buffer.alloc(16);
  const ms = Math.max(0, Math.floor(timestampMs));
  bytes.writeUInt32BE(Math.floor(ms / 65536), 0);
  bytes.writeUInt16BE(ms % 65536, 4);
  bytes[6] = 0x70 | (hash[0] & 0x0f);
  bytes[7] = hash[1];
  bytes[8] = 0x80 | (hash[2] & 0x3f);
  for (let i = 9; i < 16; i += 1) bytes[i] = hash[i - 6];
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Identifiant d'une entite (client, visite, interaction, zone, compte, appareil) : stable, sans sel. */
export const entityId = (kind, key, atMs) =>
  deterministicUuidV7(`${ID_NAMESPACE}|${kind}|${key}`, atMs);
/** Identifiant d'une commande : le sel permet de rejouer apres un rejet (un rejet est definitif dans l'inbox). */
export const commandIdOf = (salt, type, key, atMs) =>
  deterministicUuidV7(`${ID_NAMESPACE}|cmd|${salt}|${type}|${key}`, atMs);

// --- Telephone -------------------------------------------------------------------------------------------------

/** Numero camerounais : 9 chiffres commencant par 6 (mobile) ou 2 (fixe), avec ou sans l'indicatif 237. */
export function phoneInfo(raw) {
  const typed = clean(raw);
  if (typed === null) return { empty: true, typed: null, digits: '', national: '', valid: false };
  const digits = typed.replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('237') ? digits.slice(3) : digits;
  return { empty: false, typed, digits, national, valid: /^[62][0-9]{8}$/.test(national) };
}

// --- Correspondances de listes -----------------------------------------------------------------------------------

const CLIENT_TYPES = new Map([
  ['revendeur / detaillant de marche', { category: 'REVENDEUR', customerType: 'ENTREPRISE' }],
  ['boutique / superette / supermarche', { category: 'REVENDEUR', customerType: 'ENTREPRISE' }],
  ['restaurant', { category: 'RESTAURATION_HOTELLERIE', customerType: 'ENTREPRISE' }],
  ['hotel', { category: 'RESTAURATION_HOTELLERIE', customerType: 'ENTREPRISE' }],
  ['traiteur / evenementiel', { category: 'RESTAURATION_HOTELLERIE', customerType: 'ENTREPRISE' }],
  ['particulier / menage', { category: 'PARTICULIER', customerType: 'PARTICULIER' }],
  ['boulangerie / patisserie', { category: null, customerType: 'ENTREPRISE' }],
  ['autre', { category: null, customerType: null }],
]);

const LEAD_SOURCES = new Map([
  ['prospection terrain', 'PROSPECTION_TERRAIN'],
  ['recommandation', 'RECOMMANDATION'],
  ['reseau social / whatsapp', 'RESEAU_SOCIAL'],
  ['reseau social', 'RESEAU_SOCIAL'],
  ['visite spontanee', 'VISITE_SPONTANEE'],
  ['autre', 'AUTRE'],
]);

const STEPS = new Map([
  ['nouveau', 'NOUVEAU'],
  ['contacte', 'CONTACTE'],
  ['interesse', 'INTERESSE'],
  ['negociation', 'NEGOCIATION'],
]);
export const FIRST_STEP = 'NOUVEAU';

const OUTCOMES = new Map([
  ['a relancer', 'A_RELANCER'],
  ['rendez-vous fixe', 'A_RELANCER'], // aucun motif dedie : la mention reste dans les notes
  ['absent / ferme', 'ABSENT'],
  ['commande prise', 'COMMANDE_PRISE'],
  ['pas interesse', 'PAS_INTERESSE'],
  ['vente realisee', 'VENTE_REALISEE'],
]);

const CHANNELS = new Map([
  ['appel telephonique', 'APPEL'],
  ['whatsapp / message', 'SMS'],
]);

const SEPTEMBER_MARK = 'repris de la fiche de septembre';
const DEFAULT_CONTACT_PLACEHOLDERS = new Set(['responssable', 'responsable']);
const TRUE_VALUES = new Set(['oui', 'o', 'x', 'vrai', 'true', '1']);

// --- Zones ----------------------------------------------------------------------------------------------------------

export const zoneKey = (raw) => fold(raw).replace(/[^a-z0-9]/g, '');
const zoneSlug = (name) =>
  fold(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
export const zoneCodeOf = (name, root = ROOT_ZONE) => `${root.code}-${zoneSlug(name)}`.slice(0, 40);

// --- Copie source ------------------------------------------------------------------------------------------------------

/** Ligne source complete (cellules non vides, avec leurs intitules), jointe a la charge de la commande. */
export function legacyOf(sheet, ligne, values, classeur) {
  const valeurs = {};
  HEADERS[sheet].forEach((header, index) => {
    const value = values[index];
    if (value !== null && value !== undefined && value !== '') valeurs[header] = value;
  });
  return { classeur, feuille: SHEET_NAMES[sheet], ligne, valeurs };
}

// --- Plan -----------------------------------------------------------------------------------------------------------------

/**
 * Construit le plan de reprise a partir des trois feuilles. Les anomalies `ERREUR` interdisent l'ecriture ;
 * `AVERTISSEMENT` et `INFO` sont reportes au rapport. Rien n'est ecarte en silence : une ligne qui ne peut pas
 * etre reprise est une ERREUR.
 */
export function buildPlan(source, options = {}) {
  const opt = {
    classeur: DEFAULT_CLASSEUR,
    classeurDate: DEFAULT_CLASSEUR_DATE,
    managerStart: DEFAULT_MANAGER_START,
    commercialCode: DEFAULT_COMMERCIAL_CODE,
    rootZone: ROOT_ZONE,
    ...options,
  };
  const anomalies = [];
  const note = (severity, code, sheet, ligne, message) =>
    anomalies.push({ severity, code, sheet, ligne, message });
  const classeurDmy = dmy(opt.classeurDate);
  const startAt = Date.parse(localIso(opt.managerStart, '00:00'));

  // 1. Clients -> comptes prospects ----------------------------------------------------------------------------------
  const customers = [];
  const byNumber = new Map();
  for (const row of source.clients ?? []) {
    const v = row.v;
    const ligne = row.ligne;
    const number = Number.parseInt(str(v[0]), 10);
    if (!Number.isInteger(number) || number <= 0) {
      note(
        'ERREUR',
        'CLIENT_NUMERO_INVALIDE',
        'Clients',
        ligne,
        'Numero (N\u00b0) absent ou invalide.',
      );
      continue;
    }
    if (byNumber.has(number)) {
      note(
        'ERREUR',
        'CLIENT_NUMERO_EN_DOUBLE',
        'Clients',
        ligne,
        `N\u00b0 ${number} deja pris par la ligne ${byNumber.get(number).ligne}.`,
      );
      continue;
    }
    const displayName = clean(v[2]);
    const createdDay = dayOf(v[14]);
    if (displayName === null)
      note('ERREUR', 'CLIENT_NOM_ABSENT', 'Clients', ligne, 'Nom du client absent.');
    if (createdDay === null)
      note(
        'ERREUR',
        'CLIENT_DATE_INVALIDE',
        'Clients',
        ligne,
        'Date de creation absente ou invalide.',
      );

    const septembre = fold(v[22]).startsWith(SEPTEMBER_MARK);
    let occurredDay = septembre ? opt.managerStart : createdDay;
    if (createdDay !== null && !septembre && createdDay < opt.managerStart) {
      note(
        'AVERTISSEMENT',
        'CREATION_AVANT_DEBUT',
        'Clients',
        ligne,
        `Cree le ${dmy(createdDay)}, avant le debut d'usage (${dmy(opt.managerStart)}) : date ramenee au debut d'usage.`,
      );
      occurredDay = opt.managerStart;
    }
    const occurredAt = occurredDay === null ? null : localIso(occurredDay, '00:00');

    const typeLabel = clean(v[4]);
    const typeInfo = CLIENT_TYPES.get(fold(typeLabel));
    if (typeLabel !== null && typeInfo === undefined) {
      note(
        'AVERTISSEMENT',
        'TYPE_CLIENT_INCONNU',
        'Clients',
        ligne,
        `Type de client inconnu : categorie et type de compte laisses vides.`,
      );
    }
    if (typeInfo !== undefined && typeInfo.category === null) {
      note(
        'INFO',
        'CATEGORIE_VIDE',
        'Clients',
        ligne,
        "Aucune categorie de client ne correspond a ce type : categorie vide, libelle d'origine garde dans l'activite.",
      );
    }

    const sourceLabel = clean(v[12]);
    let sourceCode = LEAD_SOURCES.get(fold(sourceLabel));
    if (sourceCode === undefined) {
      sourceCode = 'AUTRE';
      note(
        'AVERTISSEMENT',
        'SOURCE_INCONNUE',
        'Clients',
        ligne,
        'Source du prospect inconnue ou vide : source AUTRE.',
      );
    }

    const stepLabel = clean(v[13]);
    let stepCode = STEPS.get(fold(stepLabel));
    if (stepCode === undefined) {
      stepCode = FIRST_STEP;
      note(
        'AVERTISSEMENT',
        'ETAPE_INCONNUE',
        'Clients',
        ligne,
        'Etape du pipeline inconnue ou vide : etape Nouveau.',
      );
    }
    if (fold(v[3]) !== 'prospect' && clean(v[3]) !== null) {
      note(
        'ERREUR',
        'STATUT_NON_PROSPECT',
        'Clients',
        ligne,
        'Statut autre que Prospect : une conversion exige une vente, non reprise ici.',
      );
    }
    if (TRUE_VALUES.has(fold(v[20]))) {
      note(
        'ERREUR',
        'COMPTE_PERDU_NON_GERE',
        'Clients',
        ligne,
        'Compte marque perdu : motif a rapprocher a la main (non present dans cette reprise).',
      );
    }

    const phone = phoneInfo(v[6]);
    if (phone.empty) {
      note(
        'ERREUR',
        'TELEPHONE_ABSENT',
        'Clients',
        ligne,
        'Telephone principal absent (BR-CRM-002 : telephone ou GPS requis).',
      );
    } else if (!phone.valid) {
      note(
        'AVERTISSEMENT',
        'TELEPHONE_NON_CAMEROUNAIS',
        'Clients',
        ligne,
        `Numero de ${phone.digits.length} chiffres (9 attendus) : importe tel que saisi, a corriger par le responsable.`,
      );
    }
    const phone2 = phoneInfo(v[7]);
    if (!phone2.empty && !phone2.valid) {
      note(
        'AVERTISSEMENT',
        'TELEPHONE2_NON_CAMEROUNAIS',
        'Clients',
        ligne,
        'Telephone 2 invalide : non importe (garde dans la ligne source).',
      );
    }

    const interlocutor = clean(v[5]);
    const realContact =
      interlocutor !== null && !DEFAULT_CONTACT_PLACEHOLDERS.has(fold(interlocutor));
    const lat = Number(str(v[10]).replace(',', '.'));
    const lng = Number(str(v[11]).replace(',', '.'));
    const hasPosition =
      clean(v[10]) !== null &&
      clean(v[11]) !== null &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180;
    if ((clean(v[10]) === null) !== (clean(v[11]) === null)) {
      note(
        'AVERTISSEMENT',
        'GPS_INCOMPLET',
        'Clients',
        ligne,
        'Latitude ou longitude seule : position non importee.',
      );
    }

    const quartier = clean(v[8]);
    const repere = clean(v[9]);
    const addressParts = [];
    if (quartier !== null) addressParts.push(`Quartier : ${quartier}`);
    if (repere !== null) addressParts.push(`Rep\u00e8re : ${repere}`);

    const product = clean(v[15]);
    const potential = clean(v[16]);
    const unit = clean(v[17]);
    const payment = clean(v[18]);
    const deferred = clean(v[19]);
    const observations = clean(v[22]);
    const reasonParts = [
      `Reprise Excel ${classeurDmy} L${ligne} N${number} ${clean(v[1]) ?? ''}`.trim(),
      createdDay === null
        ? null
        : septembre
          ? `fiche de septembre (cr\u00e9\u00e9 le ${dmy(createdDay)}), reprise le ${dmy(opt.managerStart)}`
          : `cr\u00e9\u00e9 le ${dmy(createdDay)}`,
      product === null
        ? null
        : `produit ${product}${potential === null ? '' : ` ${potential}${unit === null ? '' : ` ${unit}`}/j`}`,
      payment === null ? null : `paiement ${payment}`,
      deferred !== null && TRUE_VALUES.has(fold(deferred))
        ? 'paiement diff\u00e9r\u00e9 demand\u00e9'
        : null,
      observations !== null && !septembre ? `obs. ${observations}` : null,
      !phone.empty && !phone.valid ? `tel. a ${phone.digits.length} chiffres` : null,
      realContact ? `interlocuteur ${interlocutor}` : null,
    ].filter((part) => part !== null);
    // Plafond du motif (500) : les parties facultatives tombent en premier ; la ligne source complete reste jointe.
    let reason = reasonParts.join(' | ');
    while (reason.length > MAX_REASON && reasonParts.length > 2) {
      reasonParts.pop();
      reason = reasonParts.join(' | ');
      note(
        'INFO',
        'MOTIF_ABREGE',
        'Clients',
        ligne,
        'Motif de reprise abrege (500 car.) ; ligne source complete dans la charge de la commande.',
      );
    }
    reason = reason.slice(0, MAX_REASON);

    const customer = {
      number,
      ligne,
      code: clean(v[1]),
      key: `${opt.commercialCode}|${number}`,
      displayName,
      createdDay,
      septembre,
      occurredDay,
      occurredAt,
      zoneKey: zoneKey(quartier),
      quartier,
      categoryCode: typeInfo === undefined ? null : typeInfo.category,
      customerType: typeInfo === undefined ? null : typeInfo.customerType,
      businessActivity: typeLabel,
      phonePrimary: phone.empty ? null : phone.valid ? phone.national : phone.digits,
      phoneSecondary: !phone2.empty && phone2.valid ? phone2.national : null,
      contactName: realContact ? interlocutor : null,
      addressText: addressParts.length === 0 ? null : addressParts.join(' - '),
      position: hasPosition ? { lat, lng } : null,
      sourceCode,
      stepCode,
      stepLabel,
      reason,
      legacy: legacyOf('clients', ligne, v, opt.classeur),
      phoneNational: phone.national,
      nameFold: fold(displayName),
      // L'identifiant ne depend que des donnees sources (jamais d'une option) : un rejeu retrouve le meme compte.
      id:
        createdDay === null
          ? null
          : entityId(
              'customer',
              `${opt.commercialCode}|${number}`,
              Date.parse(localIso(createdDay, '00:00')),
            ),
      firstContactAt: null,
      contactCount: 0,
    };
    customers.push(customer);
    byNumber.set(number, customer);
  }
  const byKey = new Map(customers.map((c) => [c.key, c]));

  // 2. Contacts -> visites (sur place) et interactions (a distance) -------------------------------------------------
  const visits = [];
  const interactions = [];
  const refs = new Set();
  for (const row of source.contacts ?? []) {
    const v = row.v;
    const ligne = row.ligne;
    const ref = clean(v[1]);
    if (ref === null) {
      note(
        'ERREUR',
        'CONTACT_REF_ABSENTE',
        'Visites_Contacts',
        ligne,
        'Reference de ligne absente.',
      );
      continue;
    }
    if (refs.has(ref)) {
      note(
        'ERREUR',
        'CONTACT_REF_EN_DOUBLE',
        'Visites_Contacts',
        ligne,
        `Reference ${ref} en double.`,
      );
      continue;
    }
    refs.add(ref);
    const customer = byKey.get(clean(v[17]) ?? '') ?? byNumber.get(Number.parseInt(str(v[16]), 10));
    if (customer === undefined) {
      note(
        'ERREUR',
        'CONTACT_CLIENT_INTROUVABLE',
        'Visites_Contacts',
        ligne,
        `Client du contact ${ref} introuvable (cle ${str(v[17])}).`,
      );
      continue;
    }
    const day = dayOf(v[2]);
    let time = timeOf(v[3]);
    if (day === null) {
      note(
        'ERREUR',
        'CONTACT_DATE_INVALIDE',
        'Visites_Contacts',
        ligne,
        'Date du contact absente ou invalide.',
      );
      continue;
    }
    if (time === null) {
      note(
        'AVERTISSEMENT',
        'CONTACT_HEURE_ABSENTE',
        'Visites_Contacts',
        ligne,
        'Heure absente ou invalide : 00:00 retenu.',
      );
      time = '00:00';
    }
    const occurredAt = localIso(day, time);
    if (day < opt.managerStart) {
      note(
        'ERREUR',
        'CONTACT_AVANT_DEBUT',
        'Visites_Contacts',
        ligne,
        `Contact du ${dmy(day)}, avant le debut d'usage (${dmy(opt.managerStart)}).`,
      );
      continue;
    }
    if (customer.occurredAt !== null && Date.parse(occurredAt) < Date.parse(customer.occurredAt)) {
      note(
        'ERREUR',
        'CONTACT_AVANT_CREATION',
        'Visites_Contacts',
        ligne,
        `Contact anterieur a la creation du client N${customer.number}.`,
      );
      continue;
    }
    customer.contactCount += 1;
    if (
      customer.firstContactAt === null ||
      Date.parse(occurredAt) < Date.parse(customer.firstContactAt)
    ) {
      customer.firstContactAt = occurredAt;
    }

    const typeLabel = clean(v[4]);
    const isVisit = fold(typeLabel).startsWith('visite');
    const objet = clean(v[6]);
    const resultLabel = clean(v[7]);
    const competitor = clean(v[8]);
    const competitorPrice = clean(v[9]);
    const textParts = [
      objet === null ? null : `Objet : ${objet}`,
      resultLabel === null ? null : `R\u00e9sultat saisi : ${resultLabel}`,
      competitor === null ? null : `Fournisseur ou concurrent actuel : ${competitor}`,
      competitorPrice === null ? null : `Prix concurrent constat\u00e9 : ${competitorPrice} XAF`,
      clean(v[14]) === null ? null : `Notes : ${clean(v[14])}`,
    ].filter((part) => part !== null);
    const text = textParts.length === 0 ? null : textParts.join(' | ');
    const nextActionAt = dayOf(v[10]);
    if (clean(v[10]) !== null && nextActionAt === null) {
      note(
        'AVERTISSEMENT',
        'PROCHAINE_ACTION_DATE_INVALIDE',
        'Visites_Contacts',
        ligne,
        'Date de prochaine action invalide : ignoree (gardee dans la ligne source).',
      );
    }
    const reason =
      `Reprise Excel ${classeurDmy} ${ref} L${ligne} | heure saisie ${time} (approximative)`.slice(
        0,
        MAX_REASON,
      );
    const common = {
      ref,
      ligne,
      customerKey: customer.key,
      customerNumber: customer.number,
      occurredAt,
      text,
      nextActionAt,
      nextActionNote: clean(v[11]),
      reason,
      legacy: legacyOf('contacts', ligne, v, opt.classeur),
    };
    if (isVisit) {
      const outcomeCode = OUTCOMES.get(fold(resultLabel));
      if (outcomeCode === undefined) {
        note(
          'AVERTISSEMENT',
          'RESULTAT_INCONNU',
          'Visites_Contacts',
          ligne,
          'Resultat de visite inconnu : motif Autre (mention dans les notes).',
        );
      }
      if (fold(resultLabel) === 'rendez-vous fixe') {
        note(
          'INFO',
          'RDV_VERS_A_RELANCER',
          'Visites_Contacts',
          ligne,
          'Rendez-vous fixe : aucun motif dedie, motif A relancer avec la mention dans les notes.',
        );
      }
      const latV = Number(str(v[12]).replace(',', '.'));
      const lngV = Number(str(v[13]).replace(',', '.'));
      const visitPosition =
        clean(v[12]) !== null &&
        clean(v[13]) !== null &&
        Number.isFinite(latV) &&
        Number.isFinite(lngV) &&
        Math.abs(latV) <= 90 &&
        Math.abs(lngV) <= 180;
      visits.push({
        ...common,
        id: entityId('visit', ref, Date.parse(occurredAt)),
        outcomeCode: outcomeCode ?? 'AUTRE',
        position: visitPosition ? { lat: latV, lng: lngV } : null,
        text: text ?? 'Reprise du classeur : aucune note saisie.',
      });
    } else {
      let channel = CHANNELS.get(fold(typeLabel));
      if (channel === undefined) {
        channel = 'AUTRE';
        note(
          'AVERTISSEMENT',
          'CANAL_INCONNU',
          'Visites_Contacts',
          ligne,
          'Type de contact inconnu : canal AUTRE.',
        );
      }
      interactions.push({
        ...common,
        id: entityId('interaction', ref, Date.parse(occurredAt)),
        channel,
        direction: 'SORTANT',
      });
    }
  }

  // 3. Etapes du pipeline (deduites) --------------------------------------------------------------------------------
  const stepChanges = [];
  for (const customer of customers) {
    if (customer.stepCode === FIRST_STEP || customer.occurredAt === null) continue;
    const occurredAt = customer.firstContactAt ?? addMinutes(customer.occurredAt, 1);
    if (customer.firstContactAt === null) {
      note(
        'INFO',
        'ETAPE_SANS_CONTACT',
        'Clients',
        customer.ligne,
        `Etape ${customer.stepLabel} sans aucun contact saisi : date du passage = jour de creation + 1 minute.`,
      );
    }
    stepChanges.push({
      customerKey: customer.key,
      customerNumber: customer.number,
      ligne: customer.ligne,
      stepCode: customer.stepCode,
      occurredAt: new Date(Date.parse(occurredAt)).toISOString(),
      reason:
        `Reprise Excel ${classeurDmy} L${customer.ligne} N${customer.number} | \u00e9tape saisie : ${customer.stepLabel} (date du passage non saisie : premier contact, sinon jour de cr\u00e9ation)`.slice(
          0,
          MAX_REASON,
        ),
    });
  }

  // 4. Journal : archive, aucune commande ----------------------------------------------------------------------------
  const journal = [];
  for (const row of source.journal ?? []) {
    const day = dayOf(row.v[0]);
    if (day === null) {
      note(
        'ERREUR',
        'JOURNAL_DATE_INVALIDE',
        'Journal',
        row.ligne,
        'Date du journal absente ou invalide.',
      );
      continue;
    }
    journal.push({ day, ...legacyOf('journal', row.ligne, row.v, opt.classeur) });
  }

  // 5. Zones : une par quartier, sous la racine ---------------------------------------------------------------------
  const zoneVariants = new Map();
  for (const customer of customers) {
    if (customer.quartier === null) {
      note(
        'ERREUR',
        'QUARTIER_ABSENT',
        'Clients',
        customer.ligne,
        'Quartier absent : zone obligatoire pour un client.',
      );
      continue;
    }
    const entry = zoneVariants.get(customer.zoneKey) ?? new Map();
    entry.set(customer.quartier, (entry.get(customer.quartier) ?? 0) + 1);
    zoneVariants.set(customer.zoneKey, entry);
  }
  const zones = [
    {
      key: '__racine__',
      code: opt.rootZone.code,
      name: opt.rootZone.name,
      level: opt.rootZone.level,
      parentCode: null,
      count: 0,
      variants: [],
    },
  ];
  for (const [key, variants] of [...zoneVariants.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const ordered = [...variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const isOther = key === 'autre';
    const name = isOther ? 'Autre quartier' : ordered[0][0];
    zones.push({
      key,
      code: zoneCodeOf(name, opt.rootZone),
      name,
      level: 'QUARTIER',
      parentCode: opt.rootZone.code,
      count: ordered.reduce((sum, [, n]) => sum + n, 0),
      variants: ordered.map(([variant, n]) => ({ variant, count: n })),
    });
    if (ordered.length > 1) {
      note(
        'INFO',
        'QUARTIER_ORTHOGRAPHES',
        'Clients',
        null,
        `Quartier "${name}" saisi de plusieurs facons (${ordered.map(([variant, n]) => `${variant} x${n}`).join(', ')}) : une seule zone.`,
      );
    }
  }
  const zoneCodes = new Set();
  for (const zone of zones) {
    if (zoneCodes.has(zone.code))
      note(
        'ERREUR',
        'ZONE_CODE_EN_DOUBLE',
        'Clients',
        null,
        `Deux quartiers donnent le meme code de zone ${zone.code}.`,
      );
    zoneCodes.add(zone.code);
  }
  const zoneByKey = new Map(zones.map((zone) => [zone.key, zone]));
  for (const customer of customers)
    customer.zoneCode = zoneByKey.get(customer.zoneKey)?.code ?? null;

  // 6. Doublons : signales, jamais fusionnes ------------------------------------------------------------------------
  const byPhone = new Map();
  const byName = new Map();
  const byCode = new Map();
  for (const customer of customers) {
    if (customer.phoneNational !== '')
      byPhone.set(customer.phoneNational, [
        ...(byPhone.get(customer.phoneNational) ?? []),
        customer,
      ]);
    byName.set(customer.nameFold, [...(byName.get(customer.nameFold) ?? []), customer]);
    if (customer.code !== null)
      byCode.set(customer.code, [...(byCode.get(customer.code) ?? []), customer]);
  }
  const duplicates = { phones: [], names: [], codes: [] };
  const lines = (group) => group.map((c) => `N${c.number} (L${c.ligne})`).join(', ');
  for (const group of byPhone.values()) {
    if (group.length < 2) continue;
    duplicates.phones.push(group.map((c) => c.number));
    note(
      'AVERTISSEMENT',
      'TELEPHONE_PARTAGE',
      'Clients',
      group[1].ligne,
      `Meme telephone pour ${lines(group)} : le serveur rattache le plus recent au premier (conflit DUPLICATE_CUSTOMER, a fusionner par le responsable).`,
    );
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    duplicates.names.push(group.map((c) => c.number));
    note(
      'AVERTISSEMENT',
      'NOM_EN_DOUBLE',
      'Clients',
      group[1].ligne,
      `Meme nom pour ${lines(group)} : importes tels quels (telephones differents).`,
    );
  }
  for (const group of byCode.values()) {
    if (group.length < 2) continue;
    duplicates.codes.push(group.map((c) => c.number));
    note(
      'AVERTISSEMENT',
      'CODE_EN_DOUBLE',
      'Clients',
      group[1].ligne,
      `Meme code client pour ${lines(group)} : le N\u00b0 (cle RESCOM|N) fait foi.`,
    );
  }
  const defaultContact = customers.filter((c) => c.contactName === null).length;
  if (defaultContact > 0) {
    note(
      'INFO',
      'INTERLOCUTEUR_PAR_DEFAUT',
      'Clients',
      null,
      `${defaultContact} fiches avec l'interlocuteur par defaut (non importe comme nom de contact ; garde dans la ligne source).`,
    );
  }

  const atMs = (iso) => (iso === null ? 0 : Date.parse(iso));
  customers.sort((a, b) => atMs(a.occurredAt) - atMs(b.occurredAt) || a.number - b.number);
  visits.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.ref.localeCompare(b.ref),
  );
  interactions.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.ref.localeCompare(b.ref),
  );

  const count = (list, pick) =>
    list.reduce(
      (acc, item) => ({
        ...acc,
        [pick(item) ?? '(aucun)']: (acc[pick(item) ?? '(aucun)'] ?? 0) + 1,
      }),
      {},
    );
  const stats = {
    sources: {
      clients: (source.clients ?? []).length,
      contacts: (source.contacts ?? []).length,
      journal: (source.journal ?? []).length,
    },
    zones: zones.length,
    customers: customers.length,
    customersParCategorie: count(customers, (c) => c.categoryCode),
    customersParEtape: count(customers, (c) => c.stepCode),
    customersParSource: count(customers, (c) => c.sourceCode),
    customersSeptembre: customers.filter((c) => c.septembre).length,
    stepChanges: stepChanges.length,
    visits: visits.length,
    interactions: interactions.length,
    contacts: visits.length + interactions.length,
    journalArchive: journal.length,
    doublons: {
      telephones: duplicates.phones.length,
      noms: duplicates.names.length,
      codes: duplicates.codes.length,
    },
    anomalies: count(anomalies, (a) => a.severity),
  };
  return {
    options: opt,
    zones,
    customers,
    stepChanges,
    visits,
    interactions,
    journal,
    anomalies,
    duplicates,
    stats,
    startAt,
  };
}

// --- Charges utiles (identifiants de reference resolus a l'execution) -------------------------------------------------

/** Charge de `crm.customer.create` ; `refs` : { zoneIds: Map(code -> id), categoryIds: Map(code -> id) }. */
export function customerPayload(customer, refs) {
  const payload = {
    displayName: customer.displayName,
    sourceCode: customer.sourceCode,
    zoneId: refs.zoneIds.get(customer.zoneCode),
    legacy: customer.legacy,
  };
  if (customer.customerType !== null) payload.customerType = customer.customerType;
  if (customer.businessActivity !== null) payload.businessActivity = customer.businessActivity;
  if (customer.categoryCode !== null)
    payload.categoryId = refs.categoryIds.get(customer.categoryCode);
  if (customer.contactName !== null) payload.contactName = customer.contactName;
  if (customer.phonePrimary !== null) payload.phonePrimary = customer.phonePrimary;
  if (customer.phoneSecondary !== null) payload.phoneSecondary = customer.phoneSecondary;
  if (customer.addressText !== null) payload.addressText = customer.addressText;
  if (customer.position !== null) payload.position = customer.position;
  return payload;
}

/** Charge de `crm.visit.record` ; `refs.outcomeIds` : Map(code -> id) ; `customerId` : identifiant du compte. */
export function visitPayload(visit, customerId, refs) {
  const payload = {
    customerId,
    position: visit.position,
    outcomeReasonCodeId: refs.outcomeIds.get(visit.outcomeCode),
    notes: visit.text,
    legacy: visit.legacy,
  };
  if (visit.nextActionAt !== null) payload.nextActionAt = visit.nextActionAt;
  if (visit.nextActionNote !== null) payload.nextActionNote = visit.nextActionNote;
  return payload;
}

/** Charge de `crm.interaction.record`. */
export function interactionPayload(interaction, customerId) {
  const payload = {
    customerId,
    channel: interaction.channel,
    direction: interaction.direction,
    legacy: interaction.legacy,
  };
  if (interaction.text !== null) payload.summary = interaction.text;
  if (interaction.nextActionAt !== null) payload.nextActionAt = interaction.nextActionAt;
  if (interaction.nextActionNote !== null) payload.nextActionNote = interaction.nextActionNote;
  return payload;
}

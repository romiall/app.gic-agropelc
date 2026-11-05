/**
 * Chargement de la présence du personnel par fichier (PP-E ; REQ-306, AV-313, AV-317, AV-508) : la fiche papier PT, une
 * ligne par personne avec ses jours en colonnes (arrivée et départ du lundi au dimanche ; le code d'absence s'écrit dans la
 * case « arrivée », comme sur le papier). Les lignes d'une même feuille (même site, même semaine, même numéro de feuille)
 * forment une feuille : une commande `fieldwork.presence.record`, avec les contrôles de l'écran « Présence du personnel »
 * (règles de `@gic/domain`, que le serveur rejoue).
 *
 * L'identifiant de la feuille dérive de son auteur, de son site, de sa semaine, de son numéro **et de son contenu** : recharger
 * le même fichier ne reporte rien deux fois, et deux feuilles de même numéro mais de contenu différent ne s'écrasent pas.
 */
import {
  PRESENCE_MAX_LINES,
  isBusinessDay,
  isPresenceAbsenceCode,
  mondayOf,
  personNameKey,
  presenceLineIssue,
  presenceWeekIssue,
  weekDaysOf,
  type PresenceDay,
} from '@gic/domain';
import { ROLE_SETS } from '../../app/screens.js';
import { normalizeHeaderName } from './csv.js';
import { authorImportId } from './ids.js';
import type { ColumnDef, FileRecord, ImportEntity, RowOutcome } from './model.js';
import type { ImportRefs, ImportSite } from './refs.js';

/** Jours de la semaine, dans l'ordre de la fiche (le dimanche est admis). */
const DAYS = [
  { key: 'lun', label: 'Lun' },
  { key: 'mar', label: 'Mar' },
  { key: 'mer', label: 'Mer' },
  { key: 'jeu', label: 'Jeu' },
  { key: 'ven', label: 'Ven' },
  { key: 'sam', label: 'Sam' },
  { key: 'dim', label: 'Dim' },
] as const;

export const PRESENCE_LIMITS = {
  feuille: 30,
  responsable: 120,
  nom: 120,
  fonction: 80,
  mission: 80,
} as const;

const DAY_COLUMNS: readonly ColumnDef[] = DAYS.flatMap((day, index) => [
  {
    key: `${day.key}_arrivee`,
    label: `${day.label} arrivée`,
    required: false,
    example: index === 0 ? '07:45' : '',
    hint: 'Heure d’arrivée (07:45 ou 07 h 45) ; pour une absence, le code A, M, C, R ou MI.',
  },
  {
    key: `${day.key}_depart`,
    label: `${day.label} départ`,
    required: false,
    example: index === 0 ? '16:30' : '',
    hint: 'Heure de départ (16:30 ou 16 h 30) ; vide en cas d’absence.',
  },
]);

export const PRESENCE_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'site',
    label: 'Site',
    required: true,
    example: 'Ferme de Bonabéri',
    hint: 'Code ou nom d’un site actif de l’application.',
  },
  {
    key: 'semaine',
    label: 'Semaine du',
    required: true,
    example: '02/11/2026',
    hint: 'Lundi de la semaine (jj/mm/aaaa ou aaaa-mm-jj) ; une autre date de la semaine est ramenée au lundi.',
  },
  {
    key: 'feuille',
    label: 'Feuille N°',
    required: false,
    example: '000042',
    hint: 'Numéro de la feuille papier. Les lignes d’une même feuille portent le même site, la même semaine et le même numéro.',
    aliases: ['numero'],
  },
  {
    key: 'responsable',
    label: 'Responsable',
    required: false,
    example: 'Joseph Ngo Bayiha',
    hint: 'Responsable du site qui a vérifié la semaine.',
  },
  {
    key: 'nom',
    label: 'Nom et prénom',
    required: true,
    example: 'Paul Essomba',
    hint: 'Une ligne par personne.',
  },
  { key: 'fonction', label: 'Fonction', required: false, example: 'Ouvrier', hint: 'Facultatif.' },
  {
    key: 'mission',
    label: 'Zone / mission',
    required: false,
    example: 'Poulailler B2',
    hint: 'Facultatif.',
  },
  ...DAY_COLUMNS,
];

const value = (record: Readonly<Record<string, string>>, key: string): string | undefined => {
  const text = record[key]?.trim();
  return text ? text : undefined;
};

/** Site actif nommé par son code ou son nom (accents et casse ignorés). */
function siteOf(sites: readonly ImportSite[], text: string): ImportSite | undefined {
  const wanted = normalizeHeaderName(text);
  return sites.find(
    (site) =>
      normalizeHeaderName(site.code) === wanted || normalizeHeaderName(site.name) === wanted,
  );
}

/** Jour métier `AAAA-MM-JJ` lu d'une cellule `jj/mm/aaaa`, `j/m/aa` ou `aaaa-mm-jj` ; `null` si invalide. */
export function parseDay(text: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);
  let year: string;
  let month: string;
  let day: string;
  if (iso) {
    [, year, month, day] = iso as unknown as [string, string, string, string];
  } else if (fr) {
    [, day, month, year] = fr as unknown as [string, string, string, string];
    if (year.length === 2) year = `20${year}`;
  } else {
    return null;
  }
  // Une année à quatre chiffres hors d'un siècle plausible (« 0002 » tapé en tête de saisie) est une erreur de saisie.
  if (Number(year) < 2000 || Number(year) > 2100) return null;
  const result = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isBusinessDay(result) ? result : null;
}

/**
 * Heure `HH:MM` lue de `7:45`, `07:45`, `07:45:00` (format « Heure » d'Excel), `07h45` ou `07 h 45` ; `null` si invalide.
 * Les secondes éventuelles sont ignorées, comme `clockMinutes` du domaine.
 */
export function parseClock(text: string): string | null {
  const match = /^(\d{1,2})\s*(?::|h|H)\s*(\d{2})?(?::([0-5]\d))?$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Clé de la feuille d'une ligne : site (identifiant du site nommé par son code ou son nom, sinon le texte normalisé),
 * lundi de la semaine (n'importe quelle date de la semaine) et numéro de feuille. Deux lignes qui désignent le même site
 * et la même semaine autrement (code ou nom, `02/11/2026` ou `4/11/26`) restent une seule feuille.
 */
const keyOf = (record: Readonly<Record<string, string>>, refs?: ImportRefs): string | undefined => {
  const siteText = value(record, 'site');
  const weekText = value(record, 'semaine');
  if (siteText === undefined || weekText === undefined) return undefined;
  const site = refs === undefined ? undefined : siteOf(refs.sites, siteText);
  const day = parseDay(weekText);
  const sheet = value(record, 'feuille') ?? '';
  return [
    site ? site.id : normalizeHeaderName(siteText),
    day === null ? weekText : mondayOf(day),
    normalizeHeaderName(sheet),
  ].join('|');
};

/** Colonnes qui disent quelque chose d'une personne : une ligne qui n'en renseigne aucune est ignorée (comme à l'écran). */
const PERSON_KEYS: readonly string[] = [
  'nom',
  'fonction',
  'mission',
  ...DAYS.flatMap((day) => [`${day.key}_arrivee`, `${day.key}_depart`]),
];
const hasPersonContent = (record: Readonly<Record<string, string>>): boolean =>
  PERSON_KEYS.some((column) => value(record, column) !== undefined);

async function planPresence(group: readonly FileRecord[], refs: ImportRefs): Promise<RowOutcome> {
  const issues: string[] = [];
  const first = group[0]!.record;
  const siteText = value(first, 'site');
  const weekText = value(first, 'semaine');
  const paperRef = value(first, 'feuille') ?? null;
  const key = keyOf(first, refs) ?? `${siteText ?? ''}|${weekText ?? ''}`;
  // Les lignes recopiées de la feuille (site, semaine, numéro) mais sans personne ni jour sont ignorées.
  const people = group.filter(({ record }) => hasPersonContent(record));

  const site = siteText === undefined ? undefined : siteOf(refs.sites, siteText);
  if (siteText === undefined) issues.push('Site manquant.');
  else if (!site) issues.push(`Site inconnu ou inactif : « ${siteText} ».`);

  const day = weekText === undefined ? null : parseDay(weekText);
  if (weekText === undefined) issues.push('Semaine manquante.');
  else if (day === null) issues.push(`Semaine invalide : « ${weekText} » (jj/mm/aaaa attendu).`);
  const weekStart = day === null ? null : mondayOf(day);
  const now = refs.slipContext?.now;
  if (weekStart !== null && now !== undefined) {
    const weekIssue = presenceWeekIssue(weekStart, now);
    if (weekIssue) issues.push(weekIssue);
  }

  if (paperRef !== null && paperRef.length > PRESENCE_LIMITS.feuille) {
    issues.push(`Numéro de feuille trop long (${PRESENCE_LIMITS.feuille} caractères au plus).`);
  }
  const responsible =
    group.map(({ record }) => value(record, 'responsable')).find((text) => text !== undefined) ??
    null;
  if (responsible !== null && responsible.length > PRESENCE_LIMITS.responsable) {
    issues.push(
      `Nom du responsable trop long (${PRESENCE_LIMITS.responsable} caractères au plus).`,
    );
  }
  if (people.length > PRESENCE_MAX_LINES) {
    issues.push(`Plus de ${PRESENCE_MAX_LINES} personnes sur la feuille : la scinder en deux.`);
  }
  if (people.length === 0) issues.push('Aucune personne sur la feuille.');

  const dates = weekStart === null ? [] : weekDaysOf(weekStart);
  const names = new Set<string>();
  const lines = [] as {
    personName: string;
    personRole: string | null;
    missionLabel: string | null;
    days: {
      date: string;
      arrival: string | null;
      departure: string | null;
      absenceCode: string | null;
    }[];
  }[];
  for (const { line, record } of people) {
    const at = `ligne ${line}`;
    const name = value(record, 'nom');
    if (name === undefined) {
      issues.push(`${at} : nom manquant.`);
      continue;
    }
    if (name.length > PRESENCE_LIMITS.nom) issues.push(`${at} : nom trop long.`);
    const nameKey = personNameKey(name);
    if (names.has(nameKey)) issues.push(`${at} : « ${name} » figure déjà sur la feuille.`);
    names.add(nameKey);
    const role = value(record, 'fonction') ?? null;
    const mission = value(record, 'mission') ?? null;
    if (role !== null && role.length > PRESENCE_LIMITS.fonction)
      issues.push(`${at} : fonction trop longue.`);
    if (mission !== null && mission.length > PRESENCE_LIMITS.mission)
      issues.push(`${at} : mission trop longue.`);
    // Semaine invalide (déjà signalée) : les jours n'ont pas de date à laquelle se rapporter, on ne les juge pas.
    if (weekStart === null) continue;

    const days: PresenceDay[] = [];
    DAYS.forEach((weekday, index) => {
      const date = dates[index];
      const arrivalText = value(record, `${weekday.key}_arrivee`);
      const departureText = value(record, `${weekday.key}_depart`);
      if (arrivalText === undefined && departureText === undefined) return;
      if (date === undefined) return;
      const code = arrivalText?.toUpperCase();
      if (code !== undefined && isPresenceAbsenceCode(code)) {
        if (departureText !== undefined) {
          issues.push(
            `${at} : ${weekday.label}, un code d’absence ne s’écrit pas avec une heure de départ.`,
          );
          return;
        }
        days.push({ date, absenceCode: code });
        return;
      }
      const arrival = arrivalText === undefined ? null : parseClock(arrivalText);
      const departure = departureText === undefined ? null : parseClock(departureText);
      if (arrivalText !== undefined && arrival === null) {
        issues.push(
          `${at} : ${weekday.label}, arrivée « ${arrivalText} » invalide (07:45 ou code A, M, C, R, MI).`,
        );
        return;
      }
      if (departureText !== undefined && departure === null) {
        issues.push(`${at} : ${weekday.label}, départ « ${departureText} » invalide (16:30).`);
        return;
      }
      days.push({ date, arrival, departure });
    });
    if (days.length === 0) {
      issues.push(`${at} : aucun jour renseigné pour ${name}.`);
      continue;
    }
    const problem = presenceLineIssue(weekStart, days);
    if (problem) issues.push(`${at} : ${problem.messageFr}`);
    lines.push({
      personName: name,
      personRole: role,
      missionLabel: mission,
      days: days.map((entry) => ({
        date: entry.date,
        arrival: entry.arrival ?? null,
        departure: entry.departure ?? null,
        absenceCode: entry.absenceCode ?? null,
      })),
    });
  }

  if (issues.length > 0 || !site || weekStart === null) {
    return { key, issues, commands: [] };
  }
  const payload = {
    siteId: site.id,
    weekStart,
    paperRef,
    responsibleName: responsible,
    lines,
  };
  // Toute la charge entre dans l'identifiant, responsable compris : une feuille chargée avec un mauvais responsable, puis
  // annulée et rechargée corrigée, a un autre identifiant (sinon le serveur la prendrait pour la feuille annulée).
  const aggregateId = await authorImportId(
    refs.authorUserId,
    'presence-sheet',
    JSON.stringify([site.id, weekStart, paperRef, responsible, lines]),
  );
  return {
    key,
    issues,
    exists: refs.pendingPresenceSheets.has(aggregateId),
    commands: [
      {
        commandType: 'fieldwork.presence.record',
        aggregateType: 'PRESENCE_SHEET',
        aggregateId,
        payload,
      },
    ],
  };
}

export const PRESENCE_ENTITY: ImportEntity = {
  id: 'presence',
  label: 'Présence du personnel (fiche PT)',
  description:
    'Une ligne par personne et par semaine, ses jours en colonnes (arrivée et départ, ou code d’absence dans la case arrivée) : les lignes d’une même feuille (site, semaine, numéro) forment une feuille de présence. Mêmes contrôles que l’écran « Présence du personnel ».',
  columns: PRESENCE_COLUMNS,
  order: 60,
  limits: PRESENCE_LIMITS,
  roles: ROLE_SETS.presence,
  planRow: (record, refs) => planPresence([{ line: 0, record }], refs),
  groupKey: keyOf,
  planGroup: (group, refs) => planPresence(group, refs),
};

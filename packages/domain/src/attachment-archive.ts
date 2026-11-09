/**
 * Archive des photos jointes (AV-539, ADR-070) : règles pures, sans entrée-sortie, partagées par le serveur (qui
 * prépare, fabrique et vide l'archive) et l'écran (qui n'en affiche que les libellés).
 *
 * - périodes : un mois ou un trimestre du calendrier, en jours locaux `Africa/Douala` ;
 * - seuil d'ancienneté : **plancher de 30 jours** que le réglage ne peut qu'augmenter (les images de moins de
 *   30 jours restent toujours sur le serveur) ;
 * - noms : dossier par catégorie d'opération, fichier nommé d'après la référence de l'opération et la date et
 *   l'heure de sa soumission, réduits à des caractères sûrs (aucune traversée de chemin, aucun caractère interdit
 *   de Windows, aucun premier caractère de formule de tableur) ;
 * - découpage en volumes bornés (un mois, une catégorie, une taille et un nombre de photos maximaux) ;
 * - manifeste CSV et texte d'accompagnement du volume.
 */
import { businessDayOf, businessDayStartUtc, isBusinessDay } from './business-day.js';
import { DomainError } from './errors.js';

/** Catégories d'opération = dossiers de l'archive (ADR-070 §2). Ordre = ordre des volumes d'un mois. */
export const ARCHIVE_CATEGORIES = [
  'RECEPTION',
  'MORTALITE',
  'PERTE',
  'DEPENSE',
  'FACTURE_FOURNISSEUR',
] as const;
export type ArchiveCategory = (typeof ARCHIVE_CATEGORIES)[number];

export const ARCHIVE_GRANULARITIES = ['MONTH', 'QUARTER'] as const;
export type ArchiveGranularity = (typeof ARCHIVE_GRANULARITIES)[number];

/** Les images de moins de 30 jours restent toujours sur le serveur : plancher que le réglage ne peut qu'augmenter. */
export const ARCHIVE_MIN_AGE_FLOOR_DAYS = 30;
export const ARCHIVE_DEFAULT_MIN_AGE_DAYS = 30;
/** Plafond d'un réglage d'ancienneté (dix ans). */
export const ARCHIVE_MAX_MIN_AGE_DAYS = 3650;
export const ARCHIVE_DEFAULT_VOLUME_MAX_MB = 512;
export const ARCHIVE_VOLUME_MB_MIN = 16;
export const ARCHIVE_VOLUME_MB_MAX = 2048;
export const ARCHIVE_DEFAULT_GRANULARITY: ArchiveGranularity = 'QUARTER';
export const ARCHIVE_DEFAULT_RETENTION_YEARS = 5;
/** Photos au plus par volume : le ZIP classique (sans ZIP64) tient 65 535 entrées. */
export const ARCHIVE_MAX_FILES_PER_VOLUME = 10_000;
/** Photos au plus par plan (borne de mémoire de la préparation) ; un reste se prépare en second plan. */
export const ARCHIVE_MAX_FILES_PER_PLAN = 50_000;

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

export function isArchiveGranularity(value: unknown): value is ArchiveGranularity {
  return typeof value === 'string' && (ARCHIVE_GRANULARITIES as readonly string[]).includes(value);
}

export function isArchiveCategory(value: unknown): value is ArchiveCategory {
  return typeof value === 'string' && (ARCHIVE_CATEGORIES as readonly string[]).includes(value);
}

/** Ancienneté minimale en jours : le réglage, jamais en dessous du plancher de 30 jours. */
export function effectiveMinAgeDays(configured: unknown): number {
  const value =
    typeof configured === 'number' && Number.isFinite(configured)
      ? Math.floor(configured)
      : ARCHIVE_DEFAULT_MIN_AGE_DAYS;
  return Math.min(ARCHIVE_MAX_MIN_AGE_DAYS, Math.max(ARCHIVE_MIN_AGE_FLOOR_DAYS, value));
}

/** Instant avant lequel une pièce reçue est archivable (strictement : moins de N jours reste sur le serveur). */
export function archiveCutoff(now: Date, minAgeDays: number): Date {
  return new Date(now.getTime() - minAgeDays * DAY_MS);
}

/** Taille maximale en octets des photos d'un volume (`attachments.archive.volume_max_mb`, bornée). */
export function effectiveVolumeMaxBytes(configuredMb: unknown): number {
  const value =
    typeof configuredMb === 'number' && Number.isFinite(configuredMb)
      ? Math.floor(configuredMb)
      : ARCHIVE_DEFAULT_VOLUME_MAX_MB;
  return Math.min(ARCHIVE_VOLUME_MB_MAX, Math.max(ARCHIVE_VOLUME_MB_MIN, value)) * MB;
}

/** Période proposée à l'écran. */
export function effectiveGranularity(configured: unknown): ArchiveGranularity {
  return isArchiveGranularity(configured) ? configured : ARCHIVE_DEFAULT_GRANULARITY;
}

export function effectiveRetentionYears(configured: unknown): number {
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured >= 1
    ? Math.min(configured, 30)
    : ARCHIVE_DEFAULT_RETENTION_YEARS;
}

// -------------------------------------------------------------------------------------------------------------
// Périodes
// -------------------------------------------------------------------------------------------------------------

export interface ArchivePeriod {
  readonly granularity: ArchiveGranularity;
  /** Premier jour local (`AAAA-MM-JJ`), inclus. */
  readonly start: string;
  /** Premier jour local suivant (`AAAA-MM-JJ`), exclu. */
  readonly end: string;
  /** Libellé stable : `AAAA-MM` (mois) ou `AAAA-T1` à `AAAA-T4` (trimestre). */
  readonly label: string;
  /** Mois (`AAAA-MM`) couverts. */
  readonly months: readonly string[];
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function monthKey(year: number, month: number): string {
  return `${year}-${pad(month)}`;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function buildPeriod(
  granularity: ArchiveGranularity,
  year: number,
  firstMonth: number,
): ArchivePeriod {
  const length = granularity === 'MONTH' ? 1 : 3;
  const months: string[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const { year: y, month: m } = addMonths(year, firstMonth, offset);
    months.push(monthKey(y, m));
  }
  const next = addMonths(year, firstMonth, length);
  return {
    granularity,
    start: `${monthKey(year, firstMonth)}-01`,
    end: `${monthKey(next.year, next.month)}-01`,
    label:
      granularity === 'MONTH'
        ? monthKey(year, firstMonth)
        : `${year}-T${Math.floor((firstMonth - 1) / 3) + 1}`,
    months,
  };
}

/** Période (mois ou trimestre du calendrier) qui contient un jour local `AAAA-MM-JJ`. */
export function archivePeriodOf(granularity: ArchiveGranularity, day: string): ArchivePeriod {
  if (!isBusinessDay(day)) {
    throw new DomainError(`Jour invalide (attendu AAAA-MM-JJ) : ${day}`, 'ARCHIVE_PERIOD_INVALID');
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return buildPeriod(
    granularity,
    year,
    granularity === 'MONTH' ? month : Math.floor((month - 1) / 3) * 3 + 1,
  );
}

/** Période désignée par son premier jour (mois : le 1er ; trimestre : le 1er janvier, avril, juillet ou octobre). */
export function archivePeriodFromStart(
  granularity: ArchiveGranularity,
  start: string,
): ArchivePeriod {
  const period = archivePeriodOf(granularity, start);
  if (period.start !== start) {
    throw new DomainError(
      granularity === 'MONTH'
        ? `Début de mois attendu (le 1er) : ${start}`
        : `Début de trimestre attendu (1er janvier, avril, juillet ou octobre) : ${start}`,
      'ARCHIVE_PERIOD_INVALID',
    );
  }
  return period;
}

/** Instants UTC `[startUtc, endUtc[` d'une période (minuit de Douala). */
export function archivePeriodWindow(period: Pick<ArchivePeriod, 'start' | 'end'>): {
  readonly startUtc: Date;
  readonly endUtc: Date;
} {
  return { startUtc: businessDayStartUtc(period.start), endUtc: businessDayStartUtc(period.end) };
}

/** Mois local (`AAAA-MM`) d'un instant. */
export function archiveMonthOf(instant: Date): string {
  return businessDayOf(instant).slice(0, 7);
}

/** Premier jour (`AAAA-MM-01`) d'un mois `AAAA-MM`. */
export function archiveMonthStart(month: string): string {
  return `${month}-01`;
}

/** Périodes (triées, sans doublon) qui couvrent des mois `AAAA-MM`. */
export function archivePeriodsOfMonths(
  granularity: ArchiveGranularity,
  months: Iterable<string>,
): ArchivePeriod[] {
  const byStart = new Map<string, ArchivePeriod>();
  for (const month of months) {
    const period = archivePeriodOf(granularity, archiveMonthStart(month));
    byStart.set(period.start, period);
  }
  return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start));
}

// -------------------------------------------------------------------------------------------------------------
// Noms
// -------------------------------------------------------------------------------------------------------------

/** Dernier jour de conservation de l'archive : `années` après le jour local donné. */
export function archiveRetentionUntil(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y + years, m - 1, d));
  // 29 février + N ans sur une année non bissextile : on garde le mois (1er mars évité).
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
}

/**
 * Élément d'un nom de fichier : lettres, chiffres, point, tiret et tiret bas seulement. Accents retirés, tout autre
 * caractère devient `-`, les suites sont fusionnées (jamais `..`), début et fin nettoyés (jamais de point ni de tiret
 * en tête : ni fichier caché, ni formule de tableur), au plus `maxLength` caractères. Vide si rien ne reste.
 */
export function sanitizeFileToken(raw: string | null | undefined, maxLength = 40): string {
  if (raw === null || raw === undefined) return '';
  const folded = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
  let token = folded
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/_{2,}/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  if (token.length > maxLength) {
    token = token.slice(0, maxLength).replace(/[-_.]+$/g, '');
  }
  return token;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function archiveExtensionOf(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? 'bin';
}

/** Date et heure locales (Douala) d'un instant : `AAAAMMJJ-HHMMSS`. */
export function archiveFileTimestamp(instant: Date): string {
  const local = new Date(instant.getTime() + 3_600_000);
  return (
    `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}` +
    `-${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`
  );
}

/** Date et heure locales (Douala) lisibles : `AAAA-MM-JJ HH:MM:SS`. */
export function archiveDisplayTimestamp(instant: Date): string {
  const local = new Date(instant.getTime() + 3_600_000);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  );
}

/** Les huit derniers caractères hexadécimaux d'un identifiant (la partie aléatoire d'un UUID version 7). */
export function archiveShortId(attachmentId: string): string {
  return attachmentId.replace(/-/g, '').toLowerCase().slice(-8);
}

/** Ce qu'un module propriétaire dit d'un document pour l'archive de ses pièces (ADR-070 §2). */
export interface ArchiveOwnerFacts {
  /** Numéro du document dans le système (`doc_number`). */
  readonly reference: string;
  /** Pièce papier, bon de livraison ou numéro de facture du fournisseur, tels que saisis. */
  readonly secondaryReferences: readonly (string | null | undefined)[];
  readonly category: ArchiveCategory;
  /** Vrai si l'opération est terminée : seule une pièce d'une opération fermée peut quitter le serveur. */
  readonly closed: boolean;
}

export interface ArchiveEntryInput {
  readonly category: ArchiveCategory;
  /** Numéro du document dans le système. */
  readonly reference: string;
  /** Pièce papier, bon de livraison ou numéro de facture du fournisseur. */
  readonly secondaryReferences: readonly (string | null | undefined)[];
  /** Soumission : réception de la pièce par le serveur. */
  readonly submittedAt: Date;
  readonly attachmentId: string;
  readonly mimeType: string;
}

export const ARCHIVE_FALLBACK_REFERENCE = 'SANS-REF';
/** Références secondaires au plus dans un nom de fichier. */
export const ARCHIVE_MAX_SECONDARY_REFERENCES = 2;

/**
 * Références réduites d'un document : le numéro (`SANS-REF` s'il ne reste rien) et au plus deux références
 * secondaires, sans doublon (à la casse près) ni répétition du numéro.
 */
export function archiveReferenceTokens(
  reference: string,
  secondaryReferences: readonly (string | null | undefined)[],
): { readonly reference: string; readonly secondary: readonly string[] } {
  const primary = sanitizeFileToken(reference) || ARCHIVE_FALLBACK_REFERENCE;
  const seen = new Set([primary.toLowerCase()]);
  const secondary: string[] = [];
  for (const raw of secondaryReferences) {
    const token = sanitizeFileToken(raw);
    if (token === '' || seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    secondary.push(token);
    if (secondary.length === ARCHIVE_MAX_SECONDARY_REFERENCES) break;
  }
  return { reference: primary, secondary };
}

/**
 * Chemin d'une photo dans l'archive : `CATÉGORIE/AAAA-MM/NUMÉRO[_RÉFÉRENCE…]_AAAAMMJJ-HHMMSS_ID8.ext`.
 * Construit par le serveur à partir de champs réduits : jamais de séparateur, de `..` ni de caractère interdit.
 */
export function archiveEntryPath(input: ArchiveEntryInput): string {
  const tokens = archiveReferenceTokens(input.reference, input.secondaryReferences);
  const base = [
    tokens.reference,
    ...tokens.secondary,
    archiveFileTimestamp(input.submittedAt),
    archiveShortId(input.attachmentId),
  ].join('_');
  return `${input.category}/${archiveMonthOf(input.submittedAt)}/${base}.${archiveExtensionOf(input.mimeType)}`;
}

/**
 * Rend les chemins distincts, y compris pour un système de fichiers qui ignore la casse (Windows) : un doublon
 * reçoit `-2`, `-3`… avant l'extension. L'ordre d'entrée décide qui garde le nom d'origine.
 */
export function uniqueEntryPaths(paths: readonly string[]): string[] {
  const taken = new Set<string>();
  return paths.map((path) => {
    let candidate = path;
    if (taken.has(candidate.toLowerCase())) {
      const dot = path.lastIndexOf('.');
      const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
      const extension = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
      let counter = 2;
      do {
        candidate = `${stem}-${counter}${extension}`;
        counter += 1;
      } while (taken.has(candidate.toLowerCase()));
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Un chemin d'entrée ZIP sûr : relatif, `/` seulement, sans `..`, sans caractère de contrôle ni interdit de Windows. */
export function isSafeArchivePath(path: string): boolean {
  if (path.length === 0 || path.length > 300) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes(':')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>"|?*]/.test(path)) return false;
  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}

export interface ArchiveVolumeNameInput {
  /** Mois `AAAA-MM`. */
  readonly month: string;
  readonly category: ArchiveCategory;
  /** Jour local du plan, `AAAA-MM-JJ`. */
  readonly planDay: string;
  readonly part: number;
  readonly parts: number;
}

/** `GIC-photos_AAAA-MM_CATÉGORIE_AAAAMMJJ[_pNN].zip` : la date du plan évite d'écraser le volume d'un autre plan. */
export function archiveVolumeFileName(input: ArchiveVolumeNameInput): string {
  const stamp = input.planDay.replace(/-/g, '');
  const part = input.parts > 1 ? `_p${pad(input.part)}` : '';
  return `GIC-photos_${input.month}_${input.category}_${stamp}${part}.zip`;
}

// -------------------------------------------------------------------------------------------------------------
// Découpage en volumes
// -------------------------------------------------------------------------------------------------------------

export interface ArchiveVolumeCandidate {
  readonly attachmentId: string;
  readonly category: ArchiveCategory;
  /** Mois local de la soumission, `AAAA-MM`. */
  readonly month: string;
  readonly submittedAt: Date;
  readonly sizeBytes: number;
}

export interface PlannedArchiveVolume<T extends ArchiveVolumeCandidate> {
  readonly month: string;
  readonly category: ArchiveCategory;
  readonly part: number;
  readonly parts: number;
  readonly items: readonly T[];
  readonly filesBytes: number;
}

function compareCandidates(a: ArchiveVolumeCandidate, b: ArchiveVolumeCandidate): number {
  return (
    a.submittedAt.getTime() - b.submittedAt.getTime() ||
    (a.attachmentId < b.attachmentId ? -1 : a.attachmentId > b.attachmentId ? 1 : 0)
  );
}

/**
 * Répartit les photos en volumes : un volume ne porte que les photos d'un mois et d'une catégorie, au plus
 * `maxBytes` d'octets de photos et `maxFiles` photos (une photo plus grosse que la borne forme seule son volume).
 * Ordre : mois, catégorie (celui de `ARCHIVE_CATEGORIES`), puis parties ; dans un volume, soumission puis identifiant.
 * Déterministe : les mêmes photos donnent les mêmes volumes.
 */
export function planArchiveVolumes<T extends ArchiveVolumeCandidate>(
  items: readonly T[],
  limits: { readonly maxBytes: number; readonly maxFiles: number },
): PlannedArchiveVolume<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.month}|${ARCHIVE_CATEGORIES.indexOf(item.category)}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [monthA, categoryA] = a.split('|') as [string, string];
    const [monthB, categoryB] = b.split('|') as [string, string];
    return monthA.localeCompare(monthB) || Number(categoryA) - Number(categoryB);
  });
  const volumes: PlannedArchiveVolume<T>[] = [];
  for (const key of keys) {
    const group = groups.get(key)!.slice().sort(compareCandidates);
    const chunks: T[][] = [];
    let current: T[] = [];
    let currentBytes = 0;
    for (const item of group) {
      if (
        current.length > 0 &&
        (current.length >= limits.maxFiles || currentBytes + item.sizeBytes > limits.maxBytes)
      ) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += item.sizeBytes;
    }
    if (current.length > 0) chunks.push(current);
    chunks.forEach((chunk, index) => {
      const first = chunk[0]!;
      volumes.push({
        month: first.month,
        category: first.category,
        part: index + 1,
        parts: chunks.length,
        items: chunk,
        filesBytes: chunk.reduce((sum, item) => sum + item.sizeBytes, 0),
      });
    });
  }
  return volumes;
}

// -------------------------------------------------------------------------------------------------------------
// Manifeste et texte d'accompagnement
// -------------------------------------------------------------------------------------------------------------

export interface ArchiveManifestRow {
  readonly path: string;
  readonly category: ArchiveCategory;
  readonly reference: string;
  readonly secondaryReference: string | null;
  readonly submittedAt: Date;
  readonly capturedAt: Date;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly attachmentId: string;
  readonly ownerId: string;
}

export const ARCHIVE_MANIFEST_COLUMNS = [
  'chemin',
  'categorie',
  'reference',
  'reference_secondaire',
  'date_soumission',
  'date_prise_de_vue',
  'nature',
  'type',
  'taille_octets',
  'sha256',
  'id_piece',
  'id_document',
] as const;

/** Cellule CSV : guillemets si elle contient `;`, `"` ou un saut de ligne ; jamais une formule de tableur. */
export function csvCell(value: string): string {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Marque d'ordre des octets UTF-8 : Excel (français) lit alors le manifeste en UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Manifeste d'un volume : `;` comme séparateur, saut de ligne Windows, BOM UTF-8 (Excel français). */
export function buildArchiveManifest(rows: readonly ArchiveManifestRow[]): string {
  const lines = [ARCHIVE_MANIFEST_COLUMNS.join(';')];
  for (const row of rows) {
    lines.push(
      [
        row.path,
        row.category,
        row.reference,
        row.secondaryReference ?? '',
        archiveDisplayTimestamp(row.submittedAt),
        archiveDisplayTimestamp(row.capturedAt),
        row.kind,
        row.mimeType,
        String(row.sizeBytes),
        row.sha256,
        row.attachmentId,
        row.ownerId,
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

export interface ArchiveReadmeInput {
  readonly archiveId: string;
  readonly volumeFileName: string;
  readonly volumeRank: number;
  readonly volumeCount: number;
  readonly periodLabel: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly cutoffAt: Date;
  readonly generatedDay: string;
  readonly retentionYears: number;
}

/** `LISEZMOI.txt` du volume : structure, nom des fichiers, conservation, vérification de l'empreinte. */
export function buildArchiveReadme(input: ArchiveReadmeInput): string {
  const until = archiveRetentionUntil(input.generatedDay, input.retentionYears);
  return [
    'GIC AGROPELC - Archive des photos jointes',
    '',
    `Plan : ${input.archiveId}`,
    `Volume ${input.volumeRank} sur ${input.volumeCount} : ${input.volumeFileName}`,
    `Periode : ${input.periodLabel} (du ${input.periodStart} au ${input.periodEnd} exclu, heure de Douala)`,
    `Photos recues avant le ${archiveDisplayTimestamp(input.cutoffAt)} (heure de Douala).`,
    `Fabriquee le ${input.generatedDay}.`,
    '',
    'Contenu',
    "  Un dossier par type d'operation : RECEPTION, MORTALITE, PERTE, DEPENSE, FACTURE_FOURNISSEUR,",
    '  puis un sous-dossier par mois (AAAA-MM).',
    "  Nom d'un fichier : NUMERO[_REFERENCE]_AAAAMMJJ-HHMMSS_IDENTIFIANT.extension",
    '    NUMERO          numero du document dans GIC AGROPELC (reception, perte, depense, facture)',
    '    REFERENCE       piece papier, bon de livraison ou numero de facture du fournisseur',
    '    AAAAMMJJ-HHMMSS date et heure de soumission (reception par le serveur), heure de Douala',
    "    IDENTIFIANT     8 derniers caracteres de l'identifiant de la piece",
    '  MANIFESTE.csv liste chaque photo (chemin, references, dates, taille, empreinte SHA-256).',
    "  Pour retrouver toutes les images d'une reference, cherchez cette reference dans le nom des fichiers.",
    '',
    'Conservation',
    `  Ces photos ne sont plus (ou ne seront plus) sur le serveur apres le vidage : cette archive en est la copie.`,
    `  A conserver ${input.retentionYears} ans, jusqu'au ${until} au moins, en deux exemplaires sur le stockage de l'entreprise.`,
    '',
    'Verification',
    `  Sous Windows (PowerShell) : Get-FileHash .\\${input.volumeFileName} -Algorithm SHA256`,
    "  L'empreinte du fichier est affichee dans l'application : Parametres > Archive des photos.",
    '',
  ].join('\r\n');
}

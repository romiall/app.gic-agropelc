/**
 * Écriture d'un ZIP « stocké » (méthode 0, sans compression) en flux, sans dépendance (ADR-070 §4).
 *
 * Pourquoi à la main : l'archive des photos jointes se fabrique à la demande, par volumes bornés, sur un hébergement
 * mutualisé ; des JPEG déjà recodés ne se compressent pas, et le format stocké tient en quelques structures fixes.
 *
 * - **Descripteurs de données** (bit 3) : le CRC-32 de chaque entrée est calculé pendant qu'on la lit et écrit
 *   après ses octets ; rien n'est lu deux fois, rien n'est gardé en mémoire (un morceau à la fois).
 * - **Longueur exacte d'avance** ({@link storedZipLength}) : les tailles des entrées sont connues (base de données,
 *   vérifiées par l'appelant) ; l'en-tête `Content-Length` est donc exact, et un téléchargement tronqué est reconnu
 *   par le navigateur. Une entrée qui ne rend pas exactement sa taille fait échouer le flux
 *   ({@link ZipEntrySizeError}) : jamais un ZIP muet sur une photo manquante.
 * - Noms en UTF-8 (bit 11). Pas de ZIP64 : au plus 65 535 entrées et 4 Gio, vérifiés au départ ; le découpage en
 *   volumes (`planArchiveVolumes`) reste très en deçà.
 * - Date de chaque entrée en heure de Douala (UTC+1) : le format DOS n'a pas de fuseau.
 */
import { crc32Update } from './crc32.js';

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/** Version 2.0 (descripteurs de données, noms UTF-8) ; l'hôte « MS-DOS » (octet haut à 0). */
const VERSION = 20;
/** Bit 3 : CRC et tailles dans le descripteur qui suit les octets ; bit 11 : noms en UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const LOCAL_HEADER_BYTES = 30;
const DESCRIPTOR_BYTES = 16;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;

export const ZIP_MAX_ENTRIES = 0xffff;
export const ZIP_MAX_BYTES = 0xffffffff;

export class ZipEntrySizeError extends Error {
  constructor(
    readonly path: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(`Entrée ${path} : ${received} octet(s) lus pour ${expected} annoncé(s).`);
  }
}

export class ZipLimitError extends Error {}

export interface ZipEntry {
  /** Chemin dans l'archive : UTF-8, séparateur `/`, déjà contrôlé par l'appelant. */
  readonly path: string;
  /** Nombre exact d'octets de l'entrée. */
  readonly size: number;
  /** Date de modification (instant UTC). */
  readonly modifiedAt: Date;
  /** Octets de l'entrée, dans l'ordre ; exactement `size` octets au total. */
  readonly read: () => AsyncIterable<Uint8Array>;
}

/** Entrée dont le contenu est déjà en mémoire (manifeste, texte d'accompagnement). */
export function memoryEntry(path: string, content: Uint8Array, modifiedAt: Date): ZipEntry {
  return {
    path,
    size: content.length,
    modifiedAt,
    read: async function* () {
      yield content;
    },
  };
}

/** Longueur exacte du ZIP que {@link writeStoredZip} écrira pour ces entrées. */
export function storedZipLength(
  entries: readonly { readonly path: string; readonly size: number }[],
  comment = '',
): number {
  let total = END_BYTES + Buffer.byteLength(comment, 'utf8');
  for (const entry of entries) {
    const name = Buffer.byteLength(entry.path, 'utf8');
    total +=
      LOCAL_HEADER_BYTES + name + entry.size + DESCRIPTOR_BYTES + CENTRAL_HEADER_BYTES + name;
  }
  return total;
}

/** Heure et date au format MS-DOS, en heure de Douala ; bornées à 1980-01-01 et 2107-12-31. */
export function dosDateTime(instant: Date): { readonly time: number; readonly date: number } {
  const local = new Date(instant.getTime() + 3_600_000);
  const year = local.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (local.getUTCHours() << 11) | (local.getUTCMinutes() << 5) | (local.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((local.getUTCMonth() + 1) << 5) | local.getUTCDate(),
  };
}

interface CentralRecord {
  readonly name: Buffer;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
}

function assertWithinLimits(
  entries: readonly { readonly path: string; readonly size: number }[],
  comment: string,
): void {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipLimitError(`Trop d'entrées pour un ZIP sans ZIP64 : ${entries.length}.`);
  }
  if (storedZipLength(entries, comment) > ZIP_MAX_BYTES) {
    throw new ZipLimitError('Archive de plus de 4 Gio : ZIP64 non pris en charge.');
  }
}

/**
 * Écrit le ZIP par morceaux : en-tête local, octets, descripteur de données de chaque entrée, puis le répertoire
 * central et la fin d'archive. `comment` (optionnel) est le commentaire de l'archive.
 */
export async function* writeStoredZip(
  entries: readonly ZipEntry[],
  options: { readonly comment?: string } = {},
): AsyncGenerator<Buffer> {
  const comment = options.comment ?? '';
  assertWithinLimits(entries, comment);

  const records: CentralRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const { time, date } = dosDateTime(entry.modifiedAt);

    const header = Buffer.alloc(LOCAL_HEADER_BYTES + name.length);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(0, 8); // méthode 0 : stocké
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // CRC-32 et tailles à zéro : ils suivent les octets (bit 3).
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    name.copy(header, LOCAL_HEADER_BYTES);
    yield header;

    let crc = 0;
    let written = 0;
    for await (const chunk of entry.read()) {
      written += chunk.length;
      if (written > entry.size) throw new ZipEntrySizeError(entry.path, entry.size, written);
      crc = crc32Update(crc, chunk);
      yield Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (written !== entry.size) throw new ZipEntrySizeError(entry.path, entry.size, written);

    const descriptor = Buffer.alloc(DESCRIPTOR_BYTES);
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(entry.size, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    yield descriptor;

    records.push({ name, time, date, crc, size: entry.size, offset });
    offset += LOCAL_HEADER_BYTES + name.length + entry.size + DESCRIPTOR_BYTES;
  }

  const centralStart = offset;
  let centralBytes = 0;
  for (const record of records) {
    const central = Buffer.alloc(CENTRAL_HEADER_BYTES + record.name.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4); // version de l'outil
    central.writeUInt16LE(VERSION, 6); // version nécessaire
    central.writeUInt16LE(FLAGS, 8);
    central.writeUInt16LE(0, 10); // stocké
    central.writeUInt16LE(record.time, 12);
    central.writeUInt16LE(record.date, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.size, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(record.name.length, 28);
    // extra (30), commentaire (32), disque (34), attributs internes (36) et externes (38) : zéro.
    central.writeUInt32LE(record.offset, 42);
    record.name.copy(central, CENTRAL_HEADER_BYTES);
    centralBytes += central.length;
    yield central;
  }

  const commentBytes = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(END_BYTES + commentBytes.length);
  end.writeUInt32LE(SIG_END, 0);
  // numéros de disque (4, 6) : zéro
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  commentBytes.copy(end, END_BYTES);
  yield end;
}

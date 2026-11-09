/**
 * Lecteur de ZIP « stocké » strict, pour les essais seulement : relit ce que {@link writeStoredZip} a écrit comme le
 * ferait un décompresseur (fin d'archive, répertoire central, en-tête local, descripteur de données, CRC-32) et
 * refuse la moindre incohérence — un trou entre les structures, une taille ou un CRC qui diffère, un nom qui change.
 */
import { crc32Of } from '../src/platform/zip/crc32.js';

export interface ReadZipEntry {
  readonly path: string;
  readonly data: Buffer;
  readonly crc: number;
  readonly flags: number;
  readonly method: number;
  readonly time: number;
  readonly date: number;
}

export interface ReadZip {
  readonly entries: readonly ReadZipEntry[];
  readonly comment: string;
}

export function readStoredZip(zip: Buffer): ReadZip {
  // Fin d'archive : à 22 octets de la fin, ou plus tôt si un commentaire la suit.
  let endAt = -1;
  for (let at = zip.length - 22; at >= 0 && at >= zip.length - 22 - 0xffff; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) {
      endAt = at;
      break;
    }
  }
  if (endAt < 0) throw new Error('fin d’archive introuvable');
  const count = zip.readUInt16LE(endAt + 10);
  if (zip.readUInt16LE(endAt + 8) !== count) throw new Error('nombre d’entrées incohérent');
  const centralSize = zip.readUInt32LE(endAt + 12);
  const centralStart = zip.readUInt32LE(endAt + 16);
  if (centralStart + centralSize !== endAt) throw new Error('répertoire central mal placé');
  const comment = zip.subarray(endAt + 22).toString('utf8');

  const entries: ReadZipEntry[] = [];
  let cursor = centralStart;
  let expectedLocal = 0;
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error(`entrée centrale ${index} illisible`);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const time = zip.readUInt16LE(cursor + 12);
    const date = zip.readUInt16LE(cursor + 14);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const path = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (compressed !== size)
      throw new Error(`${path} : tailles différentes pour un fichier stocké`);
    if (localOffset !== expectedLocal) throw new Error(`${path} : trou avant l’en-tête local`);
    if (zip.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error(`${path} : en-tête local illisible`);
    if (zip.readUInt16LE(localOffset + 6) !== flags)
      throw new Error(`${path} : drapeaux différents`);
    if (zip.readUInt16LE(localOffset + 8) !== method)
      throw new Error(`${path} : méthode différente`);
    const localName = zip.readUInt16LE(localOffset + 26);
    const localExtra = zip.readUInt16LE(localOffset + 28);
    if (zip.subarray(localOffset + 30, localOffset + 30 + localName).toString('utf8') !== path) {
      throw new Error(`${path} : nom local différent`);
    }
    const dataStart = localOffset + 30 + localName + localExtra;
    const data = zip.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new Error(`${path} : octets manquants`);
    if (flags & 0x0008) {
      const descriptor = dataStart + size;
      if (zip.readUInt32LE(descriptor) !== 0x08074b50)
        throw new Error(`${path} : descripteur absent`);
      if (zip.readUInt32LE(descriptor + 4) !== crc)
        throw new Error(`${path} : CRC du descripteur différent`);
      if (zip.readUInt32LE(descriptor + 8) !== size || zip.readUInt32LE(descriptor + 12) !== size) {
        throw new Error(`${path} : tailles du descripteur différentes`);
      }
      expectedLocal = descriptor + 16;
    } else {
      expectedLocal = dataStart + size;
    }
    if (crc32Of(data) !== crc) throw new Error(`${path} : CRC-32 faux`);
    entries.push({ path, data: Buffer.from(data), crc, flags, method, time, date });
  }
  if (expectedLocal !== centralStart) throw new Error('trou avant le répertoire central');
  if (cursor !== endAt) throw new Error('octets inattendus dans le répertoire central');
  return { entries, comment };
}

/** Rassemble un flux d'octets en un seul tampon (essais). */
export async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

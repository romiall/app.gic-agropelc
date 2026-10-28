/**
 * Archive ZIP minimale (P9-20 ; ADR-067 §4) : un XLSX est une archive d'entrées XML. Écrite avec `node:zlib`
 * (compression `deflate` brute) et un CRC-32 de table, sans dépendance. Format ZIP « classique » (pas de ZIP64) :
 * au plus 65 535 entrées et 4 Gio, très au-delà d'un classeur d'export (100 000 lignes).
 */
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const deflateRawAsync = promisify(deflateRaw);

/** Rend la main à la boucle d'événements : le worker la partage avec la voie courte des alertes (P9-25, EX-4). */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

const CRC_INITIAL = 0xffffffff;

/** Poursuit un CRC-32 sur un tampon (l'état n'est pas encore complémenté). */
function crc32Update(state: number, data: Buffer): number {
  let crc = state;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return crc;
}

/** CRC-32 (IEEE 802.3) d'un tampon. */
export function crc32(data: Buffer): number {
  return (crc32Update(CRC_INITIAL, data) ^ 0xffffffff) >>> 0;
}

/** Tranche de calcul du CRC entre deux retours à la boucle d'événements. */
const CRC_SLICE_BYTES = 1 << 20;

/** Le même CRC-32, par tranches d'un Mio : un classeur de 100 000 lignes ne gèle pas la boucle (EX-4). */
export async function crc32Async(data: Buffer): Promise<number> {
  let state = CRC_INITIAL;
  for (let start = 0; start < data.length; start += CRC_SLICE_BYTES) {
    state = crc32Update(state, data.subarray(start, start + CRC_SLICE_BYTES));
    await yieldToEventLoop();
  }
  return (state ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00:00 : date fixe, l'archive est reproductible. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

const DEFLATE = 8;
const STORED = 0;
const UTF8_FLAG = 0x0800;

/**
 * L'archive des entrées. Asynchrone (EX-4) : la compression passe par le pool de fils de `zlib` et le CRC-32 par
 * tranches, de sorte que la boucle d'événements du worker n'est jamais tenue plus de quelques millisecondes.
 */
export async function zipArchive(entries: readonly ZipEntry[]): Promise<Buffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = await deflateRawAsync(entry.data);
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const method = useDeflate ? DEFLATE : STORED;
    const crc = await crc32Async(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

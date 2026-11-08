/**
 * CRC-32 (IEEE 802.3, polynôme réfléchi 0xEDB88320) des entrées d'un ZIP. `zlib.crc32` (Node 20.15 et 22.2 ou plus)
 * quand il existe, sinon une table de 256 entrées : le résultat est le même, le serveur n'impose pas une version
 * de Node plus récente que celle de l'hébergement (`engines` : 20.11 à 22.x).
 */
import * as zlib from 'node:zlib';

const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number })
  .crc32;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 de la suite des morceaux déjà vus (`crc`, 0 au départ) prolongée de `chunk`. */
export function crc32Table(crc: number, chunk: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    c = TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export const hasNativeCrc32 = typeof nativeCrc32 === 'function';

export function crc32Update(crc: number, chunk: Uint8Array): number {
  return nativeCrc32 ? nativeCrc32(chunk, crc) >>> 0 : crc32Table(crc, chunk);
}

export function crc32Of(data: Uint8Array): number {
  return crc32Update(0, data);
}

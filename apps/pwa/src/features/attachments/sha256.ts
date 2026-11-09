/**
 * SHA-256 incrémental, sans dépendance (AV-539, ADR-070 §7) : l'écran des paramètres calcule l'empreinte d'un fichier
 * d'archive de plusieurs centaines de Mo, rangé par l'Admin, par morceaux. `crypto.subtle.digest` ne sait hacher qu'un
 * tampon entier (le fichier tiendrait en mémoire) : cette version relit le fichier tranche par tranche. Rien n'est
 * envoyé au serveur hormis l'empreinte.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK = 64;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly pending = new Uint8Array(BLOCK);
  private pendingLength = 0;
  private bytes = 0;
  private readonly words = new Uint32Array(64);
  private done = false;

  update(data: Uint8Array): this {
    if (this.done) throw new Error('Empreinte déjà calculée.');
    this.feed(data);
    return this;
  }

  private feed(data: Uint8Array): void {
    this.bytes += data.length;
    let at = 0;
    if (this.pendingLength > 0) {
      const take = Math.min(BLOCK - this.pendingLength, data.length);
      this.pending.set(data.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      at = take;
      if (this.pendingLength === BLOCK) {
        this.compress(this.pending, 0);
        this.pendingLength = 0;
      }
    }
    for (; at + BLOCK <= data.length; at += BLOCK) this.compress(data, at);
    if (at < data.length) {
      this.pending.set(data.subarray(at), 0);
      this.pendingLength = data.length - at;
    }
  }

  /** Empreinte en hexadécimal minuscule ; l'instance ne sert plus ensuite. */
  digestHex(): string {
    if (this.done) throw new Error('Empreinte déjà calculée.');
    const bitsHigh = Math.floor(this.bytes / 0x20000000);
    const bitsLow = (this.bytes % 0x20000000) * 8;
    const padding = new Uint8Array(
      this.pendingLength < 56 ? 64 - this.pendingLength : 128 - this.pendingLength,
    );
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, bitsHigh >>> 0);
    view.setUint32(padding.length - 4, bitsLow >>> 0);
    this.feed(padding);
    this.done = true;
    return Array.from(this.state, (word) => word.toString(16).padStart(8, '0')).join('');
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (block[at]! << 24) | (block[at + 1]! << 16) | (block[at + 2]! << 8) | block[at + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    this.state[0] = (this.state[0]! + a) | 0;
    this.state[1] = (this.state[1]! + b) | 0;
    this.state[2] = (this.state[2]! + c) | 0;
    this.state[3] = (this.state[3]! + d) | 0;
    this.state[4] = (this.state[4]! + e) | 0;
    this.state[5] = (this.state[5]! + f) | 0;
    this.state[6] = (this.state[6]! + g) | 0;
    this.state[7] = (this.state[7]! + h) | 0;
  }
}

/** Tranche lue à la fois d'un fichier (mémoire de l'onglet : quelques Mo, jamais le fichier entier). */
export const HASH_SLICE_BYTES = 4 * 1024 * 1024;

/**
 * Empreinte SHA-256 d'un fichier du poste, lue par tranches ; `onProgress` reçoit la part lue (0 à 1) après chaque
 * tranche. Les tranches se relisent avec `Blob.slice().arrayBuffer()`, disponible partout où l'on choisit un fichier.
 */
export async function sha256OfFile(
  file: Blob,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const hash = new Sha256();
  for (let at = 0; at < file.size; at += HASH_SLICE_BYTES) {
    const slice = new Uint8Array(await file.slice(at, at + HASH_SLICE_BYTES).arrayBuffer());
    hash.update(slice);
    onProgress?.(Math.min(1, (at + slice.length) / file.size));
  }
  onProgress?.(1);
  return hash.digestHex();
}

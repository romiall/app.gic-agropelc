import { createHash, randomBytes, randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HASH_SLICE_BYTES, Sha256, sha256OfFile } from './sha256.js';

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ascii = (text: string) => new TextEncoder().encode(text);

describe('SHA-256 incrémental', () => {
  it('vecteurs officiels (FIPS 180-4)', () => {
    expect(new Sha256().digestHex()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(new Sha256().update(ascii('abc')).digestHex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      new Sha256()
        .update(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
        .digestHex(),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('un million de « a », en morceaux de tailles quelconques', () => {
    const hash = new Sha256();
    const block = new Uint8Array(1000).fill(0x61);
    for (let i = 0; i < 1000; i += 1) hash.update(block);
    expect(hash.digestHex()).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('chaque longueur autour des frontières de bloc (55, 56, 63, 64, 65, 119, 120, 128)', () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000]) {
      const data = randomBytes(length);
      expect(new Sha256().update(data).digestHex(), `${length} octets`).toBe(hex(data));
    }
  });

  it('même résultat quelle que soit la découpe en morceaux (tirages au hasard)', () => {
    for (let run = 0; run < 200; run += 1) {
      const bytes = randomBytes(randomInt(0, 700));
      const hash = new Sha256();
      let at = 0;
      for (let cuts = randomInt(0, 12); cuts > 0; cuts -= 1) {
        const cut = randomInt(1, 200);
        hash.update(bytes.subarray(at, at + cut));
        at += cut;
      }
      hash.update(bytes.subarray(at));
      expect(hash.digestHex()).toBe(hex(bytes));
    }
  });

  it('refuse de servir deux fois', () => {
    const hash = new Sha256().update(ascii('a'));
    hash.digestHex();
    expect(() => hash.digestHex()).toThrow();
    expect(() => hash.update(ascii('b'))).toThrow();
  });
});

describe('sha256OfFile', () => {
  it('lit le fichier par tranches et rend la même empreinte, avec la progression', async () => {
    const bytes = randomBytes(HASH_SLICE_BYTES * 2 + 12_345);
    const progress: number[] = [];
    const digest = await sha256OfFile(new Blob([bytes]), (fraction) => progress.push(fraction));
    expect(digest).toBe(hex(bytes));
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(
      true,
    );
  });

  it('un fichier vide', async () => {
    expect(await sha256OfFile(new Blob([]))).toBe(hex(new Uint8Array()));
  });
});

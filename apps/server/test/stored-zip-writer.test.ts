/**
 * Écriture du ZIP « stocké » en flux (ADR-070 §4) : structure relue par un lecteur strict, longueur annoncée exacte,
 * UTF-8, entrées vides ou en plusieurs morceaux, refus d'une entrée qui ne rend pas sa taille, bornes sans ZIP64,
 * CRC-32 (table et natif identiques).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { crc32Of, crc32Table, hasNativeCrc32 } from '../src/platform/zip/crc32.js';
import {
  ZIP_MAX_ENTRIES,
  ZipEntrySizeError,
  ZipLimitError,
  dosDateTime,
  memoryEntry,
  storedZipLength,
  writeStoredZip,
  type ZipEntry,
} from '../src/platform/zip/stored-zip-writer.js';
import { collect, readStoredZip } from './zip-reader.js';

const WHEN = new Date('2026-11-08T14:30:10Z');

function chunked(path: string, parts: readonly Buffer[]): ZipEntry {
  return {
    path,
    size: parts.reduce((sum, part) => sum + part.length, 0),
    modifiedAt: WHEN,
    read: async function* () {
      for (const part of parts) yield part;
    },
  };
}

describe('CRC-32', () => {
  it('vecteur connu et calcul incrémental', () => {
    const data = Buffer.from('123456789');
    expect(crc32Of(data)).toBe(0xcbf43926);
    expect(crc32Table(0, data)).toBe(0xcbf43926);
    expect(crc32Table(crc32Table(0, data.subarray(0, 4)), data.subarray(4))).toBe(0xcbf43926);
    expect(crc32Of(Buffer.alloc(0))).toBe(0);
  });

  it('la table et la fonction native donnent le même résultat', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const buffer = Buffer.from(bytes);
        expect(crc32Table(0, buffer)).toBe(crc32Of(buffer));
        if (hasNativeCrc32) {
          const half = Math.floor(buffer.length / 2);
          expect(crc32Table(crc32Table(0, buffer.subarray(0, half)), buffer.subarray(half))).toBe(
            crc32Of(buffer),
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('date MS-DOS en heure de Douala', () => {
  it('convertit l’instant UTC en heure locale (UTC+1), secondes par deux', () => {
    const { time, date } = dosDateTime(new Date('2026-11-08T14:30:11Z'));
    expect(time >> 11).toBe(15);
    expect((time >> 5) & 63).toBe(30);
    expect((time & 31) * 2).toBe(10);
    expect(date >> 9).toBe(2026 - 1980);
    expect((date >> 5) & 15).toBe(11);
    expect(date & 31).toBe(8);
  });

  it('borne les dates hors de 1980 à 2107', () => {
    expect(dosDateTime(new Date('1970-01-01T00:00:00Z'))).toEqual({ time: 0, date: 33 });
    expect(dosDateTime(new Date('2200-01-01T00:00:00Z')).date >> 9).toBe(127);
  });
});

describe('writeStoredZip', () => {
  it('une archive vide ne contient que la fin d’archive', async () => {
    const zip = await collect(writeStoredZip([]));
    expect(zip.length).toBe(22);
    expect(zip.length).toBe(storedZipLength([]));
    expect(readStoredZip(zip).entries).toHaveLength(0);
  });

  it('relue par un lecteur strict : chemins, octets, CRC, UTF-8, commentaire', async () => {
    const photo = randomBytes(300_000);
    const entries: ZipEntry[] = [
      memoryEntry('LISEZMOI.txt', Buffer.from('Bonjour — été\r\n', 'utf8'), WHEN),
      memoryEntry('MANIFESTE.csv', Buffer.from('﻿a;b\r\n', 'utf8'), WHEN),
      chunked('RECEPTION/2026-10/RC-1_20261015-101530_0000a1b2.jpg', [
        photo.subarray(0, 65_536),
        photo.subarray(65_536, 200_000),
        photo.subarray(200_000),
      ]),
      chunked('MORTALITE/2026-10/vide.bin', []),
      chunked('DEPENSE/2026-10/reçu-été.pdf', [Buffer.from('%PDF-1.4')]),
    ];
    const comment = 'GIC AGROPELC - plan 0192f7a0 - volume 1/3';
    const zip = await collect(writeStoredZip(entries, { comment }));

    expect(zip.length).toBe(storedZipLength(entries, comment));
    const read = readStoredZip(zip);
    expect(read.comment).toBe(comment);
    expect(read.entries.map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path));
    expect(read.entries[2]!.data.equals(photo)).toBe(true);
    expect(read.entries[0]!.data.toString('utf8')).toBe('Bonjour — été\r\n');
    expect(read.entries[3]!.data).toHaveLength(0);
    expect(read.entries[4]!.data.toString('latin1')).toBe('%PDF-1.4');
    for (const entry of read.entries) {
      expect(entry.flags).toBe(0x0808);
      expect(entry.method).toBe(0);
    }
    expect(createHash('sha256').update(read.entries[2]!.data).digest('hex')).toBe(
      createHash('sha256').update(photo).digest('hex'),
    );
  });

  it('la longueur annoncée est exacte pour toute composition (propriété)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.stringMatching(/^[A-Za-z0-9é_-]{1,20}$/),
            body: fc.uint8Array({ maxLength: 700 }),
            split: fc.integer({ min: 1, max: 300 }),
          }),
          { maxLength: 12 },
        ),
        fc.string({ maxLength: 40 }),
        async (rows, comment) => {
          const entries = rows.map((row, index) => {
            const body = Buffer.from(row.body);
            const parts: Buffer[] = [];
            for (let at = 0; at < body.length; at += row.split)
              parts.push(body.subarray(at, at + row.split));
            return chunked(`D/${index}-${row.name}.jpg`, parts);
          });
          const zip = await collect(writeStoredZip(entries, { comment }));
          expect(zip.length).toBe(storedZipLength(entries, comment));
          const read = readStoredZip(zip);
          expect(read.entries).toHaveLength(entries.length);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('refuse une entrée qui rend moins ou plus d’octets que sa taille annoncée', async () => {
    const short: ZipEntry = { ...chunked('a.jpg', [Buffer.from('abc')]), size: 5 };
    const long: ZipEntry = { ...chunked('b.jpg', [Buffer.from('abcdef')]), size: 5 };
    await expect(collect(writeStoredZip([short]))).rejects.toBeInstanceOf(ZipEntrySizeError);
    await expect(collect(writeStoredZip([long]))).rejects.toMatchObject({
      path: 'b.jpg',
      expected: 5,
      received: 6,
    });
  });

  it('une lecture qui échoue interrompt le flux : jamais une archive silencieusement incomplète', async () => {
    const failing: ZipEntry = {
      path: 'c.jpg',
      size: 10,
      modifiedAt: WHEN,
      read: async function* () {
        yield Buffer.from('12345');
        throw new Error('photo corrompue');
      },
    };
    const chunks: Buffer[] = [];
    await expect(
      (async () => {
        for await (const chunk of writeStoredZip([failing])) chunks.push(chunk);
      })(),
    ).rejects.toThrow('photo corrompue');
    // Ni répertoire central ni fin d'archive n'ont été écrits.
    const written = Buffer.concat(chunks);
    expect(written.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
  });

  it('refuse plus de 65 535 entrées ou plus de 4 Gio (pas de ZIP64)', async () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({
      path: `f${i}`,
      size: 0,
      modifiedAt: WHEN,
      read: async function* () {},
    }));
    await expect(collect(writeStoredZip(many))).rejects.toBeInstanceOf(ZipLimitError);
    const huge: ZipEntry = {
      path: 'h.bin',
      size: 0xffff_ffff,
      modifiedAt: WHEN,
      read: async function* () {},
    };
    await expect(collect(writeStoredZip([huge]))).rejects.toBeInstanceOf(ZipLimitError);
  });
});

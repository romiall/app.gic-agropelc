import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  binToUuid,
  buildUuidv7,
  checkClientProvidedUuidv7,
  extractUuidv7Timestamp,
  isUuidv7,
  uuidToBin,
} from './uuid.js';

function randomBytes(seed: number): Uint8Array {
  // Générateur déterministe (xorshift) pour des tests reproductibles : pas de dépendance
  // à crypto dans les tests de propriété portant sur buildUuidv7 seul.
  const bytes = new Uint8Array(10);
  let x = seed || 1;
  for (let i = 0; i < 10; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

describe('buildUuidv7', () => {
  it('produit un identifiant au format UUIDv7 (version 7, variante RFC 4122)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Date.now() + 10_000_000 }),
        fc.integer({ min: 0 }),
        (ts, seed) => {
          const id = buildUuidv7(ts, randomBytes(seed));
          expect(isUuidv7(id)).toBe(true);
        },
      ),
    );
  });

  it("conserve l'horodatage embarqué (roundtrip, à la milliseconde)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffffffff }),
        fc.integer({ min: 0 }),
        (ts, seed) => {
          const id = buildUuidv7(ts, randomBytes(seed));
          expect(extractUuidv7Timestamp(id)?.getTime()).toBe(ts);
        },
      ),
    );
  });

  it('trie temporellement : un horodatage plus grand donne un UUID lexicographiquement plus grand', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffffffff - 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0 }),
        (ts, deltaMs, seed) => {
          const earlier = buildUuidv7(ts, randomBytes(seed));
          const later = buildUuidv7(ts + deltaMs, randomBytes(seed));
          expect(earlier < later).toBe(true);
        },
      ),
    );
  });

  it('refuse un tableau de moins ou plus de 10 octets aléatoires', () => {
    expect(() => buildUuidv7(Date.now(), new Uint8Array(9))).toThrow();
    expect(() => buildUuidv7(Date.now(), new Uint8Array(11))).toThrow();
  });

  it('refuse un horodatage hors des 48 bits non signés', () => {
    expect(() => buildUuidv7(-1, randomBytes(1))).toThrow();
    expect(() => buildUuidv7(0x1000000000000, randomBytes(1))).toThrow();
  });
});

describe('isUuidv7', () => {
  it('rejette un UUIDv4', () => {
    expect(isUuidv7('a1b2c3d4-e5f6-4789-8abc-1234567890ab')).toBe(false);
  });

  it("rejette une chaîne qui n'est pas un UUID", () => {
    expect(isUuidv7('pas-un-uuid')).toBe(false);
  });
});

describe('extractUuidv7Timestamp', () => {
  it("renvoie null pour une chaîne qui n'est pas un UUIDv7", () => {
    expect(extractUuidv7Timestamp('pas-un-uuid')).toBeNull();
    expect(extractUuidv7Timestamp('a1b2c3d4-e5f6-4789-8abc-1234567890ab')).toBeNull();
  });
});

describe('checkClientProvidedUuidv7 (03-data/01-identifiants-et-conventions.md §1.3)', () => {
  it('accepte un identifiant au format valide, horodaté dans le passé récent', () => {
    const receivedAt = new Date('2026-09-24T12:00:00.000Z');
    const id = buildUuidv7(receivedAt.getTime() - 60_000, randomBytes(1));
    expect(checkClientProvidedUuidv7(id, receivedAt)).toEqual({ ok: true });
  });

  it('rejette un format invalide (INVALID_FORMAT)', () => {
    const result = checkClientProvidedUuidv7('pas-un-uuid', new Date());
    expect(result).toEqual({ ok: false, reason: 'INVALID_FORMAT' });
  });

  it('rejette un horodatage embarqué à plus de 24 h dans le futur (identifiant forgé)', () => {
    const receivedAt = new Date('2026-09-24T12:00:00.000Z');
    const forged = buildUuidv7(receivedAt.getTime() + 25 * 60 * 60 * 1000, randomBytes(1));
    expect(checkClientProvidedUuidv7(forged, receivedAt)).toEqual({
      ok: false,
      reason: 'TIMESTAMP_TOO_FAR_IN_FUTURE',
    });
  });

  it('accepte un horodatage à exactement 24 h dans le futur (borne incluse)', () => {
    const receivedAt = new Date('2026-09-24T12:00:00.000Z');
    const id = buildUuidv7(receivedAt.getTime() + 24 * 60 * 60 * 1000, randomBytes(1));
    expect(checkClientProvidedUuidv7(id, receivedAt).ok).toBe(true);
  });
});

describe('uuidToBin / binToUuid (05-stack.md §2.4, colonnes BINARY(16))', () => {
  it('aller-retour : binToUuid(uuidToBin(u)) === u (minuscules), pour tout UUIDv7', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffffffff }),
        fc.integer({ min: 0 }),
        (ts, seed) => {
          const id = buildUuidv7(ts, randomBytes(seed));
          expect(binToUuid(uuidToBin(id))).toBe(id);
        },
      ),
    );
  });

  it('produit 16 octets, conformes à un exemple connu', () => {
    const bytes = uuidToBin('0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11');
    expect(bytes).toHaveLength(16);
    expect(binToUuid(bytes)).toBe('0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11');
  });

  it('normalise la casse en minuscules', () => {
    const bytes = uuidToBin('0192F6C4-7C1A-7CC2-9B1E-4B2F0C8E5A11');
    expect(binToUuid(bytes)).toBe('0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11');
  });

  it('rejette un format invalide', () => {
    expect(() => uuidToBin('pas-un-uuid')).toThrow();
  });

  it("rejette une longueur d'octets différente de 16", () => {
    expect(() => binToUuid(new Uint8Array(15))).toThrow();
    expect(() => binToUuid(new Uint8Array(17))).toThrow();
  });
});

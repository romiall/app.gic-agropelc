/**
 * Identifiants des scripts d'amorçage (ADR-002) : tout `id` est un UUIDv7. Le serveur refuse un
 * jeton dont `sub`, `device_id` ou `session_id` n'est pas un UUIDv7 (`MALFORMED_CLAIMS`) : un
 * compte local créé avec des octets aléatoires bruts ne pouvait pas appeler l'API.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newUuidv7Bytes, uuidText } from '../seeds/uuidv7.js';

// Même expression que `packages/domain/src/uuid.ts` (`isUuidv7`).
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('newUuidv7Bytes', () => {
  it('produit 16 octets, version 7, variante RFC 4122', () => {
    for (let i = 0; i < 500; i++) {
      const bytes = newUuidv7Bytes();
      expect(bytes).toHaveLength(16);
      expect(uuidText(bytes)).toMatch(UUIDV7_RE);
    }
  });

  it('porte l’horodatage fourni sur 48 bits, poids fort en tête', () => {
    const at = Date.UTC(2026, 9, 8, 12, 30, 0);
    const bytes = newUuidv7Bytes(at);
    expect(bytes.readUIntBE(0, 6)).toBe(at);
    expect(uuidText(bytes).replace(/-/g, '').slice(0, 12)).toBe(at.toString(16).padStart(12, '0'));
  });

  it('deux identifiants du même instant diffèrent (aléa), et le tri suit le temps', () => {
    const at = Date.UTC(2026, 9, 8);
    expect(uuidText(newUuidv7Bytes(at))).not.toBe(uuidText(newUuidv7Bytes(at)));
    const earlier = uuidText(newUuidv7Bytes(at));
    const later = uuidText(newUuidv7Bytes(at + 1));
    expect(earlier < later).toBe(true);
  });

  it('refuse un horodatage hors plage', () => {
    expect(() => newUuidv7Bytes(-1)).toThrow();
    expect(() => newUuidv7Bytes(0x1000000000000)).toThrow();
    expect(() => newUuidv7Bytes(1.5)).toThrow();
  });
});

describe('scripts d’amorçage', () => {
  it.each(['run.ts', 'create-local-admin.ts'])(
    '%s ne tire plus d’identifiant de Math.random()',
    (file) => {
      const source = readFileSync(new URL(`../seeds/${file}`, import.meta.url), 'utf8');
      expect(source).not.toContain('Math.random');
      expect(source).toContain("from './uuidv7.js'");
    },
  );
});

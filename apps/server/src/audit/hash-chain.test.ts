import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  computeAuditRowHash,
  GENESIS_PREV_HASH,
  sha256Hex,
  type AuditCanonFields,
} from './hash-chain.js';

function fields(overrides: Partial<AuditCanonFields> = {}): AuditCanonFields {
  return {
    seq: 1,
    id: '0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11',
    occurred_at: '2026-09-24T10:00:00.000Z',
    recorded_at: '2026-09-24T10:00:01.000Z',
    actor_user_id: '0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a12',
    actor_roles: ['ADMIN'],
    device_id: null,
    action: 'test.action.record',
    entity_type: 'TEST',
    entity_id: null,
    before: null,
    after: { a: 1 },
    reason: null,
    result: 'SUCCESS',
    command_id: null,
    ...overrides,
  };
}

describe('canonicalJsonStringify (07-security-rbac/03-audit.md §5)', () => {
  it('trie les clés à chaque niveau, sans espace', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('conserve l’ordre des tableaux', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('produit la même chaîne quel que soit l’ordre de construction de l’objet source', () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });
});

describe('sha256Hex', () => {
  it('produit 64 caractères hexadécimaux', () => {
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empreinte connue de la chaîne vide (vecteur de test SHA-256 standard)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('computeAuditRowHash (chaînage §5)', () => {
  it('la première entrée utilise 64 zéros comme prev_hash', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
    expect(GENESIS_PREV_HASH).toHaveLength(64);
  });

  it('row_hash dépend de prev_hash : deux chaînages différents pour un prev_hash différent', () => {
    const f = fields();
    const r1 = computeAuditRowHash(GENESIS_PREV_HASH, f);
    const r2 = computeAuditRowHash(sha256Hex('autre-chaine'), f);
    expect(r1.rowHash).not.toBe(r2.rowHash);
  });

  it('row_hash est déterministe pour des champs identiques', () => {
    const f = fields();
    const r1 = computeAuditRowHash(GENESIS_PREV_HASH, f);
    const r2 = computeAuditRowHash(GENESIS_PREV_HASH, f);
    expect(r1.rowHash).toBe(r2.rowHash);
  });

  it('before_hash/after_hash/reason_hash sont calculés séparément (pseudonymisation, §7)', () => {
    const f = fields({ before: { secret: 'x' }, after: { secret: 'y' }, reason: 'motif' });
    const result = computeAuditRowHash(GENESIS_PREV_HASH, f);
    expect(result.beforeHash).toBe(sha256Hex(canonicalJsonStringify({ secret: 'x' })));
    expect(result.afterHash).toBe(sha256Hex(canonicalJsonStringify({ secret: 'y' })));
    expect(result.reasonHash).toBe(sha256Hex('motif'));
  });

  it('reason absent (null) hache la chaîne vide, avant/après absents hachent `null`', () => {
    const f = fields({ before: undefined, after: undefined, reason: null });
    const result = computeAuditRowHash(GENESIS_PREV_HASH, f);
    expect(result.beforeHash).toBe(sha256Hex('null'));
    expect(result.afterHash).toBe(sha256Hex('null'));
    expect(result.reasonHash).toBe(sha256Hex(''));
  });

  it('toute variation d’un champ canonique change row_hash (chaîne falsifiable détectable)', () => {
    const base = computeAuditRowHash(GENESIS_PREV_HASH, fields());
    const changedAction = computeAuditRowHash(
      GENESIS_PREV_HASH,
      fields({ action: 'autre.action' }),
    );
    const changedResult = computeAuditRowHash(GENESIS_PREV_HASH, fields({ result: 'DENIED' }));
    const changedSeq = computeAuditRowHash(GENESIS_PREV_HASH, fields({ seq: 2 }));
    expect(changedAction.rowHash).not.toBe(base.rowHash);
    expect(changedResult.rowHash).not.toBe(base.rowHash);
    expect(changedSeq.rowHash).not.toBe(base.rowHash);
  });
});

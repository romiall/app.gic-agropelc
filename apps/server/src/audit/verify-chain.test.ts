/**
 * `audit_audit_log` interdit tout UPDATE, même pour un rôle admin (déclencheur, INV-AUD-01) :
 * une vraie base ne permet donc pas de fabriquer une rupture pour la tester. `verifyChain`
 * étant une fonction pure, on la teste ici directement contre des lignes construites à la
 * main (chaînées comme record-audit.ts le ferait), puis délibérément corrompues.
 */
import { describe, expect, it } from 'vitest';
import { computeAuditRowHash, GENESIS_PREV_HASH, type AuditCanonFields } from './hash-chain.js';
import { verifyChain, type VerifiableAuditRow } from './verify-chain.js';

function buildChain(count: number): VerifiableAuditRow[] {
  const rows: VerifiableAuditRow[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 1; i <= count; i++) {
    const fields: AuditCanonFields = {
      seq: i,
      id: `id-${i}`,
      occurred_at: '2026-09-24T10:00:00.000Z',
      recorded_at: '2026-09-24T10:00:01.000Z',
      actor_user_id: 'actor-1',
      actor_roles: ['ADMIN'],
      device_id: null,
      action: `test.action.${i}`,
      entity_type: 'TEST',
      entity_id: null,
      before: null,
      after: { n: i },
      reason: null,
      result: 'SUCCESS',
      command_id: null,
    };
    const { rowHash } = computeAuditRowHash(prevHash, fields);
    rows.push({ ...fields, prevHash, rowHash });
    prevHash = rowHash;
  }
  return rows;
}

describe('verifyChain (INV-AUD-01, 07-security-rbac/03-audit.md §5)', () => {
  it('une chaîne valide, construite comme record-audit.ts le ferait, vérifie ok', () => {
    const rows = buildChain(5);
    expect(verifyChain(rows, GENESIS_PREV_HASH)).toEqual({
      checked: 5,
      ok: true,
      brokenAtSeq: null,
      reason: null,
    });
  });

  it('plage vide : ok, rien à vérifier', () => {
    expect(verifyChain([], GENESIS_PREV_HASH)).toEqual({
      checked: 0,
      ok: true,
      brokenAtSeq: null,
      reason: null,
    });
  });

  it('row_hash falsifié (contenu modifié après coup, sans recalcul) → HASH_MISMATCH', () => {
    const rows = buildChain(3);
    const tampered = [...rows];
    tampered[1] = { ...tampered[1], after: { n: 999 } };
    expect(verifyChain(tampered, GENESIS_PREV_HASH)).toEqual({
      checked: 2,
      ok: false,
      brokenAtSeq: 2,
      reason: 'HASH_MISMATCH',
    });
  });

  it("prev_hash d'une ligne ne correspond plus au row_hash de la précédente → LINKAGE_MISMATCH", () => {
    const rows = buildChain(3);
    const tampered = [...rows];
    tampered[2] = { ...tampered[2], prevHash: 'x'.repeat(64) };
    expect(verifyChain(tampered, GENESIS_PREV_HASH)).toEqual({
      checked: 3,
      ok: false,
      brokenAtSeq: 3,
      reason: 'LINKAGE_MISMATCH',
    });
  });

  it('une ligne manquante au milieu (trou) rompt le chaînage', () => {
    const rows = buildChain(3);
    const withGap = [rows[0]!, rows[2]!];
    const result = verifyChain(withGap, GENESIS_PREV_HASH);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('LINKAGE_MISMATCH');
    expect(result.brokenAtSeq).toBe(3);
  });

  it("la vérification d'une sous-plage utilise le prev_hash réel de ce qui précède, pas la genèse", () => {
    const rows = buildChain(3);
    const subRange = rows.slice(1);
    expect(verifyChain(subRange, rows[0]!.rowHash).ok).toBe(true);
    expect(verifyChain(subRange, GENESIS_PREV_HASH).ok).toBe(false);
  });
});

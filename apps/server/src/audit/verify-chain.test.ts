/**
 * `audit_audit_log` interdit tout UPDATE, même pour un rôle admin (déclencheur, INV-AUD-01) :
 * une vraie base ne permet donc pas de fabriquer une rupture pour la tester. `verifyChain`
 * étant une fonction pure, on la teste ici directement contre des lignes construites à la
 * main (chaînées comme record-audit.ts le ferait), puis délibérément corrompues.
 */
import { describe, expect, it } from 'vitest';
import { computeAuditRowHash, GENESIS_PREV_HASH, type AuditCanonFields } from './hash-chain.js';
import {
  VERIFY_CHAIN_PAGE_SIZE,
  verifyChain,
  verifyChainPages,
  type VerifiableAuditRow,
} from './verify-chain.js';

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

describe('verifyChainPages — lecture de la plage page après page (P9-10)', () => {
  /** Lecteur sur une liste en mémoire ; compte ses lectures. */
  function reader(rows: readonly VerifiableAuditRow[]) {
    const reads: { afterSeq: number; limit: number }[] = [];
    const readPage = async (afterSeq: number, limit: number) => {
      reads.push({ afterSeq, limit });
      return rows.filter((row) => row.seq > afterSeq).slice(0, limit);
    };
    return { readPage, reads };
  }
  const genesis = async () => GENESIS_PREV_HASH;

  it('une chaîne valide à cheval sur plusieurs pages vérifie ok, lignes cumulées', async () => {
    const rows = buildChain(7);
    const { readPage, reads } = reader(rows);
    const result = await verifyChainPages(
      readPage,
      { afterSeq: 0, toSeq: 7 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result).toEqual({ checked: 7, ok: true, brokenAtSeq: null, reason: null });
    // Pages 1-3, 4-6 puis 7 (page incomplète : fin de la plage).
    expect(reads).toEqual([
      { afterSeq: 0, limit: 3 },
      { afterSeq: 3, limit: 3 },
      { afterSeq: 6, limit: 3 },
    ]);
  });

  it('une rupture de chaînage sur la première ligne d’une page est détectée (empreinte de la page précédente)', async () => {
    const rows = buildChain(7);
    const tampered = rows.map((row) =>
      row.seq === 4 ? { ...row, prevHash: 'x'.repeat(64) } : row,
    );
    const result = await verifyChainPages(
      reader(tampered).readPage,
      { afterSeq: 0, toSeq: 7 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result).toEqual({ checked: 4, ok: false, brokenAtSeq: 4, reason: 'LINKAGE_MISMATCH' });
  });

  it('une empreinte falsifiée dans la dernière page est détectée, lignes cumulées jusqu’à la rupture', async () => {
    const rows = buildChain(7);
    const tampered = rows.map((row) => (row.seq === 7 ? { ...row, after: { n: 999 } } : row));
    const result = await verifyChainPages(
      reader(tampered).readPage,
      { afterSeq: 0, toSeq: 7 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result).toEqual({ checked: 7, ok: false, brokenAtSeq: 7, reason: 'HASH_MISMATCH' });
  });

  it('la lecture s’arrête à la première rupture : les pages suivantes ne sont pas lues', async () => {
    const rows = buildChain(9);
    const tampered = rows.map((row) => (row.seq === 2 ? { ...row, after: { n: 999 } } : row));
    const { readPage, reads } = reader(tampered);
    const result = await verifyChainPages(
      readPage,
      { afterSeq: 0, toSeq: 9 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result.brokenAtSeq).toBe(2);
    expect(reads).toHaveLength(1);
  });

  it('une sous-plage s’appuie sur l’empreinte réelle de ce qui précède, lue une seule fois', async () => {
    const rows = buildChain(7);
    let lookups = 0;
    const result = await verifyChainPages(
      reader(rows).readPage,
      { afterSeq: 2, toSeq: 7 },
      {
        pageSize: 2,
        expectedFirstPrevHash: async () => {
          lookups += 1;
          return rows[1]!.rowHash;
        },
      },
    );
    expect(result).toEqual({ checked: 5, ok: true, brokenAtSeq: null, reason: null });
    expect(lookups).toBe(1);
    const wrong = await verifyChainPages(
      reader(rows).readPage,
      { afterSeq: 2, toSeq: 7 },
      { pageSize: 2, expectedFirstPrevHash: genesis },
    );
    expect(wrong).toEqual({ checked: 1, ok: false, brokenAtSeq: 3, reason: 'LINKAGE_MISMATCH' });
  });

  it('la borne haute de la plage est respectée, même si le lecteur rend davantage', async () => {
    const rows = buildChain(7);
    const result = await verifyChainPages(
      reader(rows).readPage,
      { afterSeq: 0, toSeq: 5 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result).toEqual({ checked: 5, ok: true, brokenAtSeq: null, reason: null });
    // Une falsification au-delà de la borne n'est pas vue.
    const beyond = rows.map((row) => (row.seq === 6 ? { ...row, after: { n: 999 } } : row));
    expect(
      (
        await verifyChainPages(
          reader(beyond).readPage,
          { afterSeq: 0, toSeq: 5 },
          { pageSize: 3, expectedFirstPrevHash: genesis },
        )
      ).ok,
    ).toBe(true);
  });

  it('plage vide : ok, aucune empreinte précédente demandée', async () => {
    let lookups = 0;
    const result = await verifyChainPages(
      reader([]).readPage,
      { afterSeq: 4, toSeq: 9 },
      {
        pageSize: 3,
        expectedFirstPrevHash: async () => {
          lookups += 1;
          return GENESIS_PREV_HASH;
        },
      },
    );
    expect(result).toEqual({ checked: 0, ok: true, brokenAtSeq: null, reason: null });
    expect(lookups).toBe(0);
    // Plage inversée (début au-delà de la fin) : rien à lire.
    const inverted = reader(buildChain(3));
    expect(
      await verifyChainPages(
        inverted.readPage,
        { afterSeq: 5, toSeq: 4 },
        { expectedFirstPrevHash: genesis },
      ),
    ).toMatchObject({ checked: 0, ok: true });
    expect(inverted.reads).toEqual([]);
  });

  it('un nombre de lignes multiple de la page ne boucle pas : une dernière lecture vide termine', async () => {
    const rows = buildChain(6);
    const { readPage, reads } = reader(rows);
    const result = await verifyChainPages(
      readPage,
      { afterSeq: 0, toSeq: 100 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result).toEqual({ checked: 6, ok: true, brokenAtSeq: null, reason: null });
    expect(reads).toHaveLength(3);
  });

  it('sans taille de page, la page par défaut est celle du module (2 000 lignes)', async () => {
    const { readPage, reads } = reader(buildChain(3));
    await verifyChainPages(readPage, { afterSeq: 0, toSeq: 3 }, { expectedFirstPrevHash: genesis });
    expect(reads[0]!.limit).toBe(VERIFY_CHAIN_PAGE_SIZE);
    expect(VERIFY_CHAIN_PAGE_SIZE).toBe(2_000);
  });

  it('une page incomplète termine la lecture sans nouvelle requête, même loin de la borne haute', async () => {
    const { readPage, reads } = reader(buildChain(7));
    const result = await verifyChainPages(
      readPage,
      { afterSeq: 0, toSeq: 100 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result.checked).toBe(7);
    // Pages 1-3, 4-6, puis 7 seul : la page incomplète est la dernière.
    expect(reads).toHaveLength(3);
  });

  it('une dernière page pleine qui atteint la borne haute termine la lecture sans requête vide', async () => {
    const { readPage, reads } = reader(buildChain(6));
    const result = await verifyChainPages(
      readPage,
      { afterSeq: 0, toSeq: 6 },
      { pageSize: 3, expectedFirstPrevHash: genesis },
    );
    expect(result.checked).toBe(6);
    expect(reads).toHaveLength(2);
  });

  it('la taille de page est assainie (entier au moins égal à 1)', async () => {
    const rows = buildChain(3);
    for (const [given, expected] of [
      [0, 1],
      [-4, 1],
      [2.9, 2],
    ] as const) {
      const { readPage, reads } = reader(rows);
      const result = await verifyChainPages(
        readPage,
        { afterSeq: 0, toSeq: 3 },
        { pageSize: given, expectedFirstPrevHash: genesis },
      );
      expect(result.ok).toBe(true);
      expect(reads[0]!.limit).toBe(expected);
    }
  });
});

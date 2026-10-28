import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSFER_UNMATCHED_HOURS,
  blindReceiptMatch,
  blindReceiptMatchModeOrDefault,
  chooseBlindReceiptForDispatch,
  chooseDispatchForBlindReceipt,
  allocateReceivedToLines,
  isUnmatchedOverdue,
  isValidBlindReceiptMatchMode,
  isValidUnmatchedHours,
  planTransferReceipt,
  unmatchedHoursOrDefault,
  type MatchCandidate,
} from './stock-transfers.js';

const P1 = 'p1';
const P2 = 'p2';
const q = (productId: string, quantityMilli: number) => ({ productId, quantityMilli });
const at = (iso: string) => new Date(iso);

describe('délai de rapprochement (BR-STK-024, AV-181)', () => {
  it('paramètre valide retenu, sinon repli de 48 h', () => {
    expect(unmatchedHoursOrDefault(24)).toBe(24);
    expect(unmatchedHoursOrDefault(0.5)).toBe(0.5);
    for (const invalid of [undefined, null, 0, -3, Number.NaN, Infinity, '48', true]) {
      expect(unmatchedHoursOrDefault(invalid)).toBe(DEFAULT_TRANSFER_UNMATCHED_HOURS);
    }
  });

  it('échu à la borne exacte, pas une milliseconde avant ; heures paramétrées', () => {
    const occurred = at('2026-10-01T08:00:00.000Z');
    expect(isUnmatchedOverdue(occurred, at('2026-10-03T08:00:00.000Z'), 48)).toBe(true);
    expect(isUnmatchedOverdue(occurred, at('2026-10-03T07:59:59.999Z'), 48)).toBe(false);
    expect(isUnmatchedOverdue(occurred, at('2026-10-02T08:00:00.000Z'), 24)).toBe(true);
    // Valeur invalide : 48 h.
    expect(isUnmatchedOverdue(occurred, at('2026-10-02T08:00:00.000Z'), 0)).toBe(false);
  });
});

describe('règle d’éligibilité (AV-177)', () => {
  it('mode : SUBSET par défaut, EXACT reconnu, autre valeur → défaut', () => {
    expect(blindReceiptMatchModeOrDefault('EXACT')).toBe('EXACT');
    expect(blindReceiptMatchModeOrDefault('SUBSET')).toBe('SUBSET');
    expect(blindReceiptMatchModeOrDefault(undefined)).toBe('SUBSET');
    expect(blindReceiptMatchModeOrDefault('exact')).toBe('SUBSET');
  });

  it('EXACT, PARTIAL (sous-ensemble ou moins), OVER, non éligible', () => {
    expect(blindReceiptMatch([q(P1, 58_000)], [q(P1, 58_000)])).toBe('EXACT');
    expect(blindReceiptMatch([q(P1, 57_000)], [q(P1, 58_000)])).toBe('PARTIAL');
    expect(blindReceiptMatch([q(P1, 58_000)], [q(P1, 58_000), q(P2, 1_000)])).toBe('PARTIAL');
    expect(blindReceiptMatch([q(P1, 58_001)], [q(P1, 58_000)])).toBe('OVER');
    expect(blindReceiptMatch([q(P1, 59_000)], [q(P1, 58_000), q(P2, 1_000)])).toBe('OVER');
    // Produit reçu qui n'a pas été expédié.
    expect(blindReceiptMatch([q(P2, 1_000)], [q(P1, 58_000)])).toBeNull();
  });

  it('lignes d’un même produit cumulées, lignes nulles ignorées', () => {
    expect(blindReceiptMatch([q(P1, 30_000), q(P1, 28_000)], [q(P1, 58_000)])).toBe('EXACT');
    expect(blindReceiptMatch([q(P1, 58_000)], [q(P1, 58_000), q(P2, 0)])).toBe('EXACT');
  });

  it('réception ou expédition vide : jamais éligible (lecture périmée ≠ perte totale)', () => {
    expect(blindReceiptMatch([], [q(P1, 58_000)])).toBeNull();
    expect(blindReceiptMatch([q(P1, 58_000)], [])).toBeNull();
    expect(blindReceiptMatch([q(P1, 58_000)], [q(P1, 0)])).toBeNull();
  });

  it('mode EXACT : seule l’identité rapproche', () => {
    expect(blindReceiptMatch([q(P1, 58_000)], [q(P1, 58_000)], 'EXACT')).toBe('EXACT');
    expect(blindReceiptMatch([q(P1, 57_000)], [q(P1, 58_000)], 'EXACT')).toBeNull();
    expect(blindReceiptMatch([q(P1, 59_000)], [q(P1, 58_000)], 'EXACT')).toBeNull();
  });

  it('quantité invalide refusée', () => {
    expect(() => blindReceiptMatch([q(P1, -1)], [q(P1, 1)])).toThrow(/millièmes/);
    expect(() => blindReceiptMatch([q(P1, 1.5)], [q(P1, 1)])).toThrow(/millièmes/);
  });
});

describe('choix du document à rapprocher (AV-177)', () => {
  const candidate = (id: string, iso: string, lines: MatchCandidate['lines']): MatchCandidate => ({
    id,
    at: at(iso),
    lines,
  });

  it('l’exacte la plus ancienne l’emporte sur une partielle plus ancienne', () => {
    const dispatches = [
      candidate('a', '2026-10-01T08:00:00Z', [q(P1, 60_000)]),
      candidate('b', '2026-10-02T08:00:00Z', [q(P1, 58_000)]),
      candidate('c', '2026-10-03T08:00:00Z', [q(P1, 58_000)]),
    ];
    expect(chooseDispatchForBlindReceipt([q(P1, 58_000)], dispatches)).toEqual({
      id: 'b',
      kind: 'EXACT',
    });
  });

  it('sans exacte : la partielle la plus ancienne, puis l’excédent ; aucun éligible → null', () => {
    const dispatches = [
      candidate('x', '2026-10-01T08:00:00Z', [q(P1, 10_000)]),
      candidate('y', '2026-10-03T08:00:00Z', [q(P1, 70_000)]),
      candidate('z', '2026-10-02T08:00:00Z', [q(P1, 60_000)]),
    ];
    expect(chooseDispatchForBlindReceipt([q(P1, 58_000)], dispatches)).toEqual({
      id: 'z',
      kind: 'PARTIAL',
    });
    expect(chooseDispatchForBlindReceipt([q(P1, 80_000)], dispatches)).toEqual({
      id: 'x',
      kind: 'OVER',
    });
    expect(chooseDispatchForBlindReceipt([q(P2, 1_000)], dispatches)).toBeNull();
    expect(chooseDispatchForBlindReceipt([q(P1, 58_000)], [])).toBeNull();
    expect(chooseDispatchForBlindReceipt([q(P1, 58_000)], dispatches, 'EXACT')).toBeNull();
  });

  it('à date égale, l’identifiant départage (ordre stable)', () => {
    const dispatches = [
      candidate('m2', '2026-10-01T08:00:00Z', [q(P1, 58_000)]),
      candidate('m1', '2026-10-01T08:00:00Z', [q(P1, 58_000)]),
    ];
    expect(chooseDispatchForBlindReceipt([q(P1, 58_000)], dispatches)?.id).toBe('m1');
  });

  it('symétrique : réception exacte la plus ancienne, sinon partielle la plus ancienne', () => {
    const receipts = [
      candidate('r1', '2026-10-01T08:00:00Z', [q(P1, 50_000)]),
      candidate('r2', '2026-10-02T08:00:00Z', [q(P1, 58_000)]),
      candidate('r3', '2026-10-03T08:00:00Z', [q(P2, 1_000)]),
    ];
    expect(chooseBlindReceiptForDispatch([q(P1, 58_000)], receipts)).toEqual({
      id: 'r2',
      kind: 'EXACT',
    });
    expect(chooseBlindReceiptForDispatch([q(P1, 60_000)], receipts)).toEqual({
      id: 'r1',
      kind: 'PARTIAL',
    });
    expect(chooseBlindReceiptForDispatch([q(P1, 60_000)], receipts, 'EXACT')).toBeNull();
  });
});

describe('répartition d’une réception sur les mouvements d’expédition (AV-179)', () => {
  it('lot et valeur du mouvement, reçu puis écart, prorata exact', () => {
    const planned = planTransferReceipt(
      [{ moveId: 'm1', lotId: 'L1', quantityMilli: 58_000, valueXaf: 29_000 }],
      [{ lineId: 'l1', dispatchedMilli: 58_000, receivedMilli: 57_000, lotId: 'L1' }],
    );
    expect(planned).toEqual([
      {
        lineId: 'l1',
        kind: 'RECEIPT',
        lotId: 'L1',
        quantityMilli: 57_000,
        valueXaf: 28_500,
        moveId: 'm1',
      },
      {
        lineId: 'l1',
        kind: 'DISCREPANCY',
        lotId: 'L1',
        quantityMilli: 1_000,
        valueXaf: 500,
        moveId: 'm1',
      },
    ]);
  });

  it('expédition multi-lots : un mouvement par lot, le transit s’annule par lot et en valeur', () => {
    const planned = planTransferReceipt(
      [
        { moveId: 'm1', lotId: 'L1', quantityMilli: 40_000, valueXaf: 20_001 },
        { moveId: 'm2', lotId: 'L2', quantityMilli: 18_000, valueXaf: 9_000 },
      ],
      [{ lineId: 'l1', dispatchedMilli: 58_000, receivedMilli: 50_000, lotId: 'L1' }],
    );
    expect(planned.map((m) => [m.kind, m.lotId, m.quantityMilli])).toEqual([
      ['RECEIPT', 'L1', 40_000],
      ['RECEIPT', 'L2', 10_000],
      ['DISCREPANCY', 'L2', 8_000],
    ]);
    const byLot = (lot: string) =>
      planned.filter((m) => m.lotId === lot).reduce((sum, m) => sum + m.valueXaf!, 0);
    expect(byLot('L1')).toBe(20_001);
    expect(byLot('L2')).toBe(9_000);
  });

  it('parts d’un quota et du stock commun d’un même lot fusionnées, valeurs additionnées', () => {
    const planned = planTransferReceipt(
      [
        { moveId: 'q', lotId: null, quantityMilli: 5_000, valueXaf: 2_500 },
        { moveId: 'c', lotId: null, quantityMilli: 5_000, valueXaf: 2_501 },
      ],
      [{ lineId: 'l1', dispatchedMilli: 10_000, receivedMilli: 10_000, lotId: null }],
    );
    expect(planned).toEqual([
      {
        lineId: 'l1',
        kind: 'RECEIPT',
        lotId: null,
        quantityMilli: 10_000,
        valueXaf: 5_001,
        moveId: 'q',
      },
    ]);
  });

  it('plusieurs lignes du même produit se partagent les mouvements dans l’ordre', () => {
    const planned = planTransferReceipt(
      [{ moveId: 'm1', lotId: 'L1', quantityMilli: 10_000, valueXaf: 1_000 }],
      [
        { lineId: 'a', dispatchedMilli: 4_000, receivedMilli: 4_000, lotId: 'L1' },
        { lineId: 'b', dispatchedMilli: 6_000, receivedMilli: 0, lotId: 'L1' },
      ],
    );
    expect(planned).toEqual([
      {
        lineId: 'a',
        kind: 'RECEIPT',
        lotId: 'L1',
        quantityMilli: 4_000,
        valueXaf: 400,
        moveId: 'm1',
      },
      {
        lineId: 'b',
        kind: 'DISCREPANCY',
        lotId: 'L1',
        quantityMilli: 6_000,
        valueXaf: 600,
        moveId: 'm1',
      },
    ]);
  });

  it('excédent au-delà de l’expédié : sans valeur imposée, lot du dernier mouvement', () => {
    const planned = planTransferReceipt(
      [{ moveId: 'm1', lotId: 'L1', quantityMilli: 58_000, valueXaf: 5_800 }],
      [{ lineId: 'l1', dispatchedMilli: 58_000, receivedMilli: 59_000, lotId: null }],
    );
    expect(planned).toEqual([
      {
        lineId: 'l1',
        kind: 'RECEIPT',
        lotId: 'L1',
        quantityMilli: 58_000,
        valueXaf: 5_800,
        moveId: 'm1',
      },
      {
        lineId: 'l1',
        kind: 'EXCESS',
        lotId: 'L1',
        quantityMilli: 1_000,
        valueXaf: null,
        moveId: null,
      },
    ]);
    // Ligne sans expédié du tout : tout est excédent, lot de la ligne.
    expect(
      planTransferReceipt(
        [],
        [{ lineId: 'l2', dispatchedMilli: 0, receivedMilli: 2_000, lotId: 'LX' }],
      ),
    ).toEqual([
      {
        lineId: 'l2',
        kind: 'EXCESS',
        lotId: 'LX',
        quantityMilli: 2_000,
        valueXaf: null,
        moveId: null,
      },
    ]);
  });

  it('expédié sans mouvement en face (incohérence) : lot de la ligne, valeur laissée au registre', () => {
    const planned = planTransferReceipt(
      [{ moveId: 'm1', lotId: 'L1', quantityMilli: 3_000, valueXaf: 300 }],
      [{ lineId: 'l1', dispatchedMilli: 5_000, receivedMilli: 4_000, lotId: 'L0' }],
    );
    expect(planned).toEqual([
      {
        lineId: 'l1',
        kind: 'RECEIPT',
        lotId: 'L1',
        quantityMilli: 3_000,
        valueXaf: 300,
        moveId: 'm1',
      },
      {
        lineId: 'l1',
        kind: 'RECEIPT',
        lotId: 'L0',
        quantityMilli: 1_000,
        valueXaf: null,
        moveId: null,
      },
      {
        lineId: 'l1',
        kind: 'DISCREPANCY',
        lotId: 'L0',
        quantityMilli: 1_000,
        valueXaf: null,
        moveId: null,
      },
    ]);
  });

  it('valeur d’expédition négative (anomalie) : non répartie ; mouvement vide ignoré', () => {
    const planned = planTransferReceipt(
      [
        { moveId: 'z', lotId: null, quantityMilli: 0, valueXaf: 0 },
        { moveId: 'n', lotId: null, quantityMilli: 2_000, valueXaf: -10 },
      ],
      [{ lineId: 'l1', dispatchedMilli: 2_000, receivedMilli: 2_000, lotId: null }],
    );
    expect(planned).toEqual([
      {
        lineId: 'l1',
        kind: 'RECEIPT',
        lotId: null,
        quantityMilli: 2_000,
        valueXaf: null,
        moveId: 'n',
      },
    ]);
  });

  it('quantités invalides refusées', () => {
    expect(() =>
      planTransferReceipt([{ moveId: 'm', lotId: null, quantityMilli: -1, valueXaf: 0 }], []),
    ).toThrow(/millièmes/);
    expect(() =>
      planTransferReceipt(
        [],
        [{ lineId: 'l', dispatchedMilli: 1, receivedMilli: -1, lotId: null }],
      ),
    ).toThrow(/millièmes/);
  });
});

describe('répartition par ligne d’une réception déclarée par produit (AV-177)', () => {
  it('lignes remplies dans l’ordre, excédent sur la dernière, produit non déclaré à 0', () => {
    const lines = [
      { lineId: 'a', productId: P1, dispatchedMilli: 30_000 },
      { lineId: 'b', productId: P1, dispatchedMilli: 28_000 },
      { lineId: 'c', productId: P2, dispatchedMilli: 5_000 },
    ];
    expect([...allocateReceivedToLines([q(P1, 59_000)], lines)]).toEqual([
      ['a', 30_000],
      ['b', 29_000],
      ['c', 0],
    ]);
    expect([...allocateReceivedToLines([q(P1, 20_000), q(P2, 5_000)], lines)]).toEqual([
      ['a', 20_000],
      ['b', 0],
      ['c', 5_000],
    ]);
  });

  it('quantité invalide refusée', () => {
    expect(() =>
      allocateReceivedToLines([q(P1, 1)], [{ lineId: 'a', productId: P1, dispatchedMilli: -1 }]),
    ).toThrow(/millièmes/);
  });
});

describe('prédicats de réglage exploitable (P9-25, AL-1)', () => {
  it('isValidUnmatchedHours : nombre fini strictement positif', () => {
    for (const valid of [24, 0.5]) expect(isValidUnmatchedHours(valid)).toBe(true);
    for (const invalid of [undefined, null, 0, -3, Number.NaN, Infinity, '48', true]) {
      expect(isValidUnmatchedHours(invalid)).toBe(false);
    }
  });

  it('isValidBlindReceiptMatchMode : EXACT ou SUBSET seulement', () => {
    for (const valid of ['EXACT', 'SUBSET']) expect(isValidBlindReceiptMatchMode(valid)).toBe(true);
    for (const invalid of ['exact', '', null, undefined, 1]) {
      expect(isValidBlindReceiptMatchMode(invalid)).toBe(false);
    }
  });
});

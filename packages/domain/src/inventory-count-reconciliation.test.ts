import { describe, expect, it } from 'vitest';
import {
  distributeLateMoveCompensation,
  distributeLotLessVariance,
  reconciliationDelta,
  resolveCountLineScope,
  type CountLotBalance,
} from './inventory-count-reconciliation.js';

const lot = (lotId: string, balance: number, day: number): CountLotBalance => ({
  lotId,
  balance,
  rankAt: new Date(Date.UTC(2026, 9, day)),
});
const closedLot = (lotId: string, balance: number, day: number): CountLotBalance => ({
  ...lot(lotId, balance, day),
  open: false,
});

describe('resolveCountLineScope — portée d une ligne comptée (BR-STK-040, BR-STK-045)', () => {
  it('une ligne qui désigne un lot porte sur ce lot', () => {
    expect(
      resolveCountLineScope({ lotId: 'L1', hasSiblingLotLine: false, productHasLots: true }),
    ).toBe('LOT');
  });

  it('sans lot, produit à lots, aucun lot compté dans l inventaire : tous les lots', () => {
    expect(
      resolveCountLineScope({ lotId: null, hasSiblingLotLine: false, productHasLots: true }),
    ).toBe('ALL_LOTS');
  });

  it('sans lot, mais le même inventaire compte des lots du produit : le reste sans lot', () => {
    expect(
      resolveCountLineScope({ lotId: null, hasSiblingLotLine: true, productHasLots: true }),
    ).toBe('NO_LOT');
  });

  it('sans lot et produit sans lot dans l emplacement : le sans-lot, comme avant', () => {
    expect(
      resolveCountLineScope({ lotId: null, hasSiblingLotLine: false, productHasLots: false }),
    ).toBe('NO_LOT');
  });
});

describe('distributeLotLessVariance — FIFO inverse (BR-STK-045)', () => {
  const lots = [lot('B', 10, 5), lot('A', 4, 1), lot('C', 7, 9)];

  it('un écart nul ne produit rien', () => {
    expect(distributeLotLessVariance(0, lots)).toEqual([]);
    expect(distributeLotLessVariance(0.0004, lots)).toEqual([]);
  });

  it('un gain va au lot le plus récent', () => {
    expect(distributeLotLessVariance(3, lots)).toEqual([
      { lotId: 'C', quantity: 3, direction: 'GAIN' },
    ]);
  });

  it('une perte prend le plus ancien d abord, dans la limite de son solde', () => {
    expect(distributeLotLessVariance(-3, lots)).toEqual([
      { lotId: 'A', quantity: 3, direction: 'LOSS' },
    ]);
    // 4 (lot A) + 2 (lot B) : l ordre des lots passés n a pas d importance, le rang FIFO décide.
    expect(distributeLotLessVariance(-6, lots)).toEqual([
      { lotId: 'A', quantity: 4, direction: 'LOSS' },
      { lotId: 'B', quantity: 2, direction: 'LOSS' },
    ]);
  });

  it('une perte qui dépasse le total des lots est imputée au lot le plus récent', () => {
    // total des lots : 21 ; perte de 25 : 4 + 10 + 7 puis 4 de plus sur le plus récent (C).
    expect(distributeLotLessVariance(-25, lots)).toEqual([
      { lotId: 'A', quantity: 4, direction: 'LOSS' },
      { lotId: 'B', quantity: 10, direction: 'LOSS' },
      { lotId: 'C', quantity: 11, direction: 'LOSS' },
    ]);
  });

  it('un lot à solde nul ou négatif n est pas entamé', () => {
    const withEmpty = [lot('A', 0, 1), lot('B', -2, 2), lot('C', 5, 3)];
    expect(distributeLotLessVariance(-4, withEmpty)).toEqual([
      { lotId: 'C', quantity: 4, direction: 'LOSS' },
    ]);
  });

  it('sans aucun lot, l écart va au sans-lot', () => {
    expect(distributeLotLessVariance(2.5, [])).toEqual([
      { lotId: null, quantity: 2.5, direction: 'GAIN' },
    ]);
    expect(distributeLotLessVariance(-1.25, [])).toEqual([
      { lotId: null, quantity: 1.25, direction: 'LOSS' },
    ]);
  });

  it('à rang égal, l ordre est celui de l identifiant (déterministe)', () => {
    const same = [lot('Z', 5, 1), lot('M', 5, 1)];
    expect(distributeLotLessVariance(-3, same)).toEqual([
      { lotId: 'M', quantity: 3, direction: 'LOSS' },
    ]);
  });

  it('calcule en millièmes : 0,3 − 0,1 − 0,2 ne laisse aucun reliquat', () => {
    const parts = distributeLotLessVariance(-0.3, [lot('A', 0.1, 1), lot('B', 0.2, 2)]);
    expect(parts).toEqual([
      { lotId: 'A', quantity: 0.1, direction: 'LOSS' },
      { lotId: 'B', quantity: 0.2, direction: 'LOSS' },
    ]);
    const total = parts.reduce((sum, part) => sum + Math.round(part.quantity * 1000), 0);
    expect(total).toBe(300);
  });
});

describe('distributeLotLessVariance — lots clos et sans-lot (BR-STK-045, BR-STK-050)', () => {
  it('un gain va au lot ouvert le plus récent, jamais à un lot clos (le serveur n’y sort jamais)', () => {
    const lots = [lot('A', 4, 1), lot('B', 6, 5), closedLot('C', 2, 9)];
    expect(distributeLotLessVariance(3, lots)).toEqual([
      { lotId: 'B', quantity: 3, direction: 'GAIN' },
    ]);
  });

  it('sans lot ouvert, un gain va au sans-lot', () => {
    expect(distributeLotLessVariance(3, [closedLot('A', 4, 1)])).toEqual([
      { lotId: null, quantity: 3, direction: 'GAIN' },
    ]);
  });

  it('les lots épuisés ne portent pas la perte : elle entame le sans-lot, non un lot qui passerait en négatif', () => {
    // Produit à lot facultatif : un ancien lot épuisé, 50 en stock sans lot, 45 comptés.
    expect(distributeLotLessVariance(-5, [lot('X', 0, 1)], 50)).toEqual([
      { lotId: null, quantity: 5, direction: 'LOSS' },
    ]);
  });

  it('une perte prend les lots d’abord, le sans-lot ensuite (comme la sortie du serveur)', () => {
    expect(distributeLotLessVariance(-6, [lot('A', 4, 1)], 3)).toEqual([
      { lotId: 'A', quantity: 4, direction: 'LOSS' },
      { lotId: null, quantity: 2, direction: 'LOSS' },
    ]);
  });

  it('ce qui dépasse les lots et le sans-lot est imputé au lot ouvert le plus récent', () => {
    expect(distributeLotLessVariance(-10, [lot('A', 4, 1)], 3)).toEqual([
      { lotId: 'A', quantity: 7, direction: 'LOSS' },
      { lotId: null, quantity: 3, direction: 'LOSS' },
    ]);
    // Sans lot ouvert, l'excès retourne au sans-lot.
    expect(distributeLotLessVariance(-10, [closedLot('A', 4, 1)], 3)).toEqual([
      { lotId: 'A', quantity: 4, direction: 'LOSS' },
      { lotId: null, quantity: 6, direction: 'LOSS' },
    ]);
  });
});

describe('distributeLateMoveCompensation — compensation d’un fait tardif, lot par lot (BR-STK-044, INV-STK-09)', () => {
  it('une vente tardive répartie sur deux lots est compensée sur chacun de ce qu’elle lui a pris', () => {
    // Vente de 7 : 4 sur le lot A, 3 sur le lot B ; le solde de la ligne a baissé de 7.
    expect(
      distributeLateMoveCompensation(7, [
        { lotId: 'A', effect: -4 },
        { lotId: 'B', effect: -3 },
      ]),
    ).toEqual([
      { lotId: 'A', quantity: 4, direction: 'GAIN' },
      { lotId: 'B', quantity: 3, direction: 'GAIN' },
    ]);
  });

  it('un écart plus petit que l’empreinte du fait ne rend que ce qui manque, dans l’ordre', () => {
    expect(
      distributeLateMoveCompensation(5, [
        { lotId: 'A', effect: -4 },
        { lotId: 'B', effect: -3 },
      ]),
    ).toEqual([
      { lotId: 'A', quantity: 4, direction: 'GAIN' },
      { lotId: 'B', quantity: 1, direction: 'GAIN' },
    ]);
  });

  it('un écart plus grand que l’empreinte : le reliquat va au premier lot touché', () => {
    expect(
      distributeLateMoveCompensation(9, [
        { lotId: 'A', effect: -4 },
        { lotId: 'B', effect: -3 },
      ]),
    ).toEqual([
      { lotId: 'A', quantity: 6, direction: 'GAIN' },
      { lotId: 'B', quantity: 3, direction: 'GAIN' },
    ]);
  });

  it('une entrée tardive (réception) est compensée en perte sur son lot', () => {
    expect(distributeLateMoveCompensation(-6, [{ lotId: 'A', effect: 6 }])).toEqual([
      { lotId: 'A', quantity: 6, direction: 'LOSS' },
    ]);
  });

  it('un écart de sens contraire à l’empreinte va tout entier au premier lot touché', () => {
    expect(distributeLateMoveCompensation(-2, [{ lotId: 'A', effect: -4 }])).toEqual([
      { lotId: 'A', quantity: 2, direction: 'LOSS' },
    ]);
  });

  it('le sans-lot est un lot comme un autre ; un écart nul ne produit rien', () => {
    expect(distributeLateMoveCompensation(2, [{ lotId: null, effect: -2 }])).toEqual([
      { lotId: null, quantity: 2, direction: 'GAIN' },
    ]);
    expect(distributeLateMoveCompensation(0, [{ lotId: 'A', effect: -2 }])).toEqual([]);
    expect(distributeLateMoveCompensation(0.0004, [{ lotId: 'A', effect: -2 }])).toEqual([]);
  });

  it('calcule en millièmes', () => {
    const parts = distributeLateMoveCompensation(0.3, [
      { lotId: 'A', effect: -0.1 },
      { lotId: 'B', effect: -0.2 },
    ]);
    expect(parts).toEqual([
      { lotId: 'A', quantity: 0.1, direction: 'GAIN' },
      { lotId: 'B', quantity: 0.2, direction: 'GAIN' },
    ]);
  });
});

describe('reconciliationDelta — rapprochement tardif (BR-STK-044, INV-STK-09)', () => {
  it('WF-08 : compté 94, solde à 12:00 de 93 après la vente tardive → un gain de 1', () => {
    expect(reconciliationDelta(94, 93)).toBe(1);
  });

  it('AT-021 : compté 97, solde 96 après une vente tardive d une unité → +1 ; écart net −3 + 1 = −2', () => {
    const variance = 97 - 100;
    const delta = reconciliationDelta(97, 96);
    expect(delta).toBe(1);
    expect(variance + delta).toBe(-2);
  });

  it('un solde déjà égal au compté ne produit rien, au millième près', () => {
    expect(reconciliationDelta(10, 10)).toBe(0);
    expect(reconciliationDelta(0.3, 0.1 + 0.2)).toBe(0);
  });

  it('un mouvement entrant tardif donne une perte de rapprochement', () => {
    expect(reconciliationDelta(50, 53.5)).toBe(-3.5);
  });
});

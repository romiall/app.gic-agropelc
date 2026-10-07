import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  availableOnExclusive,
  availableOnShared,
  recalculateCmup,
  roundCmupToXaf,
  selectLotsFifo,
  stockValueXaf,
  settlementValueXaf,
  evaluateStockThreshold,
} from './stock-engine.js';
import { quantityFromMilli, quantityMilliUnits, ZERO_QUANTITY, type Quantity } from './quantity.js';
import { xaf } from './money.js';

function domainErrorCode(fn: () => unknown): string {
  try {
    fn();
    throw new Error('expected to throw');
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
}

describe('availableOnExclusive / availableOnShared — strategie-stock.md §3.3', () => {
  it('exclusif : solde moins réservé', () => {
    expect(availableOnExclusive(100, 10)).toBe(90);
  });

  it('partagé : solde moins réservé moins (alloué global moins ma part)', () => {
    // solde 100, réservé 10, alloué au total 30 (dont 20 à moi) -> 100-10-(30-20) = 80
    expect(availableOnShared(100, 10, 30, 20)).toBe(80);
  });

  it('partagé : aucune allocation -> identique à exclusif', () => {
    expect(availableOnShared(100, 10, 0, 0)).toBe(availableOnExclusive(100, 10));
  });
});

describe('selectLotsFifo — BR-STK-050', () => {
  const lots = [
    { lotId: 'L1', qtyAvailable: 30, rankAt: new Date('2026-01-01') },
    { lotId: 'L2', qtyAvailable: 50, rankAt: new Date('2026-02-01') },
    { lotId: 'L3', qtyAvailable: 20, rankAt: new Date('2026-03-01') },
  ];

  it('consomme le lot le plus ancien en premier, sans dépasser sa quantité', () => {
    const result = selectLotsFifo(lots, 40);
    expect(result.allocations).toEqual([
      { lotId: 'L1', quantity: 30 },
      { lotId: 'L2', quantity: 10 },
    ]);
    expect(result.shortfall).toBe(0);
  });

  it('quantité exactement couverte par un seul lot', () => {
    const result = selectLotsFifo(lots, 30);
    expect(result.allocations).toEqual([{ lotId: 'L1', quantity: 30 }]);
  });

  it('quantité au-delà de tous les lots -> shortfall (BR-STK-018, décision au serveur)', () => {
    const result = selectLotsFifo(lots, 150);
    const total = result.allocations.reduce((sum, a) => sum + a.quantity, 0);
    expect(total).toBe(100);
    expect(result.shortfall).toBe(50);
  });

  it('un lot à solde nul est ignoré', () => {
    const result = selectLotsFifo(
      [{ lotId: 'L0', qtyAvailable: 0, rankAt: new Date('2025-12-01') }, ...lots],
      10,
    );
    expect(result.allocations).toEqual([{ lotId: 'L1', quantity: 10 }]);
  });

  it('quantité demandée non positive -> DomainError', () => {
    expect(domainErrorCode(() => selectLotsFifo(lots, 0))).toBe('QUANTITY_INVALID');
  });

  it('décimales : aucun reliquat flottant sur un stock exactement suffisant (P4-04)', () => {
    const decimals = (...quantities: number[]) =>
      quantities.map((qtyAvailable, index) => ({
        lotId: `D${index}`,
        qtyAvailable,
        rankAt: new Date(2026, 0, index + 1),
      }));
    // En flottant : 0,8 − 0,7 − 0,1 = 8·10⁻¹⁷, 0,9 − 0,3 × 3 = 1,1·10⁻¹⁶, 1,3 − 0,6 − 0,7 = 1,1·10⁻¹⁶.
    for (const [quantities, requested] of [
      [[0.7, 0.1], 0.8],
      [[0.3, 0.3, 0.3], 0.9],
      [[0.6, 0.7], 1.3],
    ] as const) {
      const result = selectLotsFifo(decimals(...quantities), requested);
      expect(result.shortfall).toBe(0);
      expect(result.allocations.map((a) => a.quantity)).toEqual([...quantities]);
    }
  });

  it('décimales : un vrai manque reste exact au millième', () => {
    const result = selectLotsFifo(
      [{ lotId: 'D0', qtyAvailable: 0.7, rankAt: new Date('2026-01-01') }],
      0.8,
    );
    expect(result.allocations).toEqual([{ lotId: 'D0', quantity: 0.7 }]);
    expect(result.shortfall).toBe(0.1);
  });
});

describe('recalculateCmup — AV-042, stratégie stock §9', () => {
  it("quantité de référence nulle -> CMUP = coût d'entrée", () => {
    expect(recalculateCmup(0, 0, 100, 450)).toBe(450);
  });

  it("quantité de référence négative -> CMUP = coût d'entrée (rupture)", () => {
    expect(recalculateCmup(-10, 999, 100, 450)).toBe(450);
  });

  it('moyenne pondérée standard', () => {
    // 100 en stock à 400, entrée de 50 à 460 -> (100*400 + 50*460) / 150 = 420
    expect(recalculateCmup(100, 400, 50, 460)).toBe(420);
  });

  it('arrondit à 2 décimales', () => {
    // (10*100 + 3*110) / 13 = 1330/13 = 102.307... -> 102.31
    expect(recalculateCmup(10, 100, 3, 110)).toBe(102.31);
  });

  it("quantité d'entrée non positive -> DomainError", () => {
    expect(domainErrorCode(() => recalculateCmup(10, 100, 0, 50))).toBe('QUANTITY_INVALID');
  });
});

describe('roundCmupToXaf — ADR-013 (demi supérieur)', () => {
  it('arrondit au franc le plus proche', () => {
    expect(roundCmupToXaf(102.31)).toBe(102);
    expect(roundCmupToXaf(102.5)).toBe(103);
    expect(roundCmupToXaf(102.49)).toBe(102);
  });
});

describe('stockValueXaf — BR-STK-054', () => {
  it('solde × CMUP arrondi au franc, puis montant arrondi demi supérieur', () => {
    // CMUP 102,5 → 103 XAF ; 12,5 × 103 = 1 287,5 → 1 288.
    expect(stockValueXaf(12.5, 102.5)).toBe(1288);
    expect(stockValueXaf(10, 2500)).toBe(25000);
  });

  it('solde nul → 0 ; solde négatif (INV-STK-05) → valeur négative', () => {
    expect(stockValueXaf(0, 2500)).toBe(0);
    expect(stockValueXaf(-3, 2500)).toBe(-7500);
  });
});

describe('evaluateStockThreshold — BR-STK-051', () => {
  it('disponible ≥ minimum → OK ; suggestion = cible − disponible − transit entrant', () => {
    expect(
      evaluateStockThreshold({ available: 12, minQty: 10, targetQty: 30, inTransitIn: 5 }),
    ).toEqual({ state: 'OK', suggestedQty: 13 });
  });

  it('0 < disponible < minimum → STOCK_LOW', () => {
    expect(
      evaluateStockThreshold({ available: 4, minQty: 10, targetQty: 30, inTransitIn: 0 }),
    ).toEqual({ state: 'STOCK_LOW', suggestedQty: 26 });
  });

  it('disponible ≤ 0 → STOCK_OUT (même sous un minimum nul)', () => {
    expect(
      evaluateStockThreshold({ available: 0, minQty: 0, targetQty: 5, inTransitIn: 0 }).state,
    ).toBe('STOCK_OUT');
    expect(
      evaluateStockThreshold({ available: -2, minQty: 10, targetQty: 30, inTransitIn: 0 }),
    ).toEqual({ state: 'STOCK_OUT', suggestedQty: 32 });
  });

  it('transit entrant couvrant la cible → suggestion plancher 0, jamais négative', () => {
    expect(
      evaluateStockThreshold({ available: 20, minQty: 10, targetQty: 30, inTransitIn: 25 })
        .suggestedQty,
    ).toBe(0);
  });
});

describe('settlementValueXaf (BR-STK-056, ADR-029 §5)', () => {
  const q = (units: number): Quantity => quantityFromMilli(units * 1000);

  /** Valeurs successives de rattachements de quantités données (en unités), dans l'ordre. */
  function sequence(originQty: number, originValue: number, steps: readonly number[]): number[] {
    let settled: Quantity = ZERO_QUANTITY;
    return steps.map((step) => {
      const value = settlementValueXaf({
        originQuantity: q(originQty),
        originValueXaf: xaf(originValue),
        settledQuantity: settled,
        quantity: q(step),
      });
      settled = quantityFromMilli(quantityMilliUnits(settled) + step * 1000);
      return value;
    });
  }

  it('répartit une valeur qui ne tombe pas juste sans perdre un franc (reliquat à la dernière)', () => {
    expect(sequence(3, 100, [1, 1, 1])).toEqual([33, 34, 33]);
    expect(sequence(3, 101, [1, 1, 1])).toEqual([34, 33, 34]);
    expect(sequence(10, 1001, [2, 8])).toEqual([200, 801]);
    expect(sequence(10, 2400, [4, 6])).toEqual([960, 1440]);
  });

  it("emporte toute la valeur d'un seul coup quand la quantité est soldée en une fois", () => {
    expect(sequence(7, 12_345, [7])).toEqual([12_345]);
    expect(sequence(3, 0, [1, 2])).toEqual([0, 0]);
  });

  it('accepte des quantités décimales (millièmes) et de très grandes valeurs sans dépassement', () => {
    const originQuantity = quantityFromMilli(20_000_000_000);
    const first = settlementValueXaf({
      originQuantity,
      originValueXaf: xaf(5_000_000_000),
      settledQuantity: ZERO_QUANTITY,
      quantity: quantityFromMilli(7_000_000_001),
    });
    const second = settlementValueXaf({
      originQuantity,
      originValueXaf: xaf(5_000_000_000),
      settledQuantity: quantityFromMilli(7_000_000_001),
      quantity: quantityFromMilli(12_999_999_999),
    });
    expect(first + second).toBe(5_000_000_000);
    expect(first).toBeGreaterThan(0);
  });

  it("propriété : toute partition de la quantité, dans tout ordre, somme exactement la valeur d'origine", () => {
    // Générateur pseudo-aléatoire à graine fixe (déterministe).
    let seed = 20_261_004;
    const next = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    for (let round = 0; round < 300; round++) {
      const totalMilli = 1 + Math.floor(next() * 50_000);
      const value = Math.floor(next() * 2_000_000);
      const cuts = new Set<number>();
      const parts = 1 + Math.floor(next() * 6);
      while (cuts.size < parts - 1 && cuts.size < totalMilli - 1) {
        cuts.add(1 + Math.floor(next() * (totalMilli - 1)));
      }
      const bounds = [0, ...[...cuts].sort((a, b) => a - b), totalMilli];
      const steps = bounds.slice(1).map((bound, i) => bound - bounds[i]!);
      for (let i = steps.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      }
      let settled = 0;
      let sum = 0;
      for (const step of steps) {
        const part = settlementValueXaf({
          originQuantity: quantityFromMilli(totalMilli),
          originValueXaf: xaf(value),
          settledQuantity: quantityFromMilli(settled),
          quantity: quantityFromMilli(step),
        });
        expect(part).toBeGreaterThanOrEqual(0);
        expect(part).toBeLessThanOrEqual(value);
        sum += part;
        expect(sum).toBeLessThanOrEqual(value);
        settled += step;
      }
      expect(sum).toBe(value);
    }
  });

  it('refuse un rattachement impossible (SETTLEMENT_INVALID)', () => {
    const base = { originQuantity: q(10), originValueXaf: xaf(1000), settledQuantity: q(8) };
    expect(domainErrorCode(() => settlementValueXaf({ ...base, quantity: q(3) }))).toBe(
      'SETTLEMENT_INVALID',
    );
    expect(domainErrorCode(() => settlementValueXaf({ ...base, quantity: ZERO_QUANTITY }))).toBe(
      'SETTLEMENT_INVALID',
    );
    expect(
      domainErrorCode(() =>
        settlementValueXaf({ ...base, originQuantity: ZERO_QUANTITY, quantity: q(1) }),
      ),
    ).toBe('SETTLEMENT_INVALID');
  });
});

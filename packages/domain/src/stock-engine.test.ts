import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  availableOnExclusive,
  availableOnShared,
  recalculateCmup,
  roundCmupToXaf,
  selectLotsFifo,
} from './stock-engine.js';

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

import { describe, expect, it } from 'vitest';
import {
  assessCashHolding,
  businessDaysBetween,
  cashHeldSince,
  cashHoldingThresholdFrom,
  DEFAULT_CASH_HOLDING_MAX_DAYS,
  DEFAULT_CASH_HOLDING_MAX_XAF,
} from './cash-holding.js';

const base = { balanceXaf: 50_000, daysWithoutTransfer: 1, maxXaf: 200_000, maxDays: 3 };

describe('assessCashHolding (D09 §14)', () => {
  it('dans les limites : aucune alerte, bord exclu (égal au plafond, égal au délai)', () => {
    expect(assessCashHolding(base)).toBeNull();
    expect(assessCashHolding({ ...base, balanceXaf: 200_000, daysWithoutTransfer: 3 })).toBeNull();
  });
  it('montant seul, durée seule, les deux', () => {
    expect(assessCashHolding({ ...base, balanceXaf: 200_001 })).toBe('AMOUNT');
    expect(assessCashHolding({ ...base, daysWithoutTransfer: 4 })).toBe('DAYS');
    expect(assessCashHolding({ ...base, balanceXaf: 300_000, daysWithoutTransfer: 9 })).toBe(
      'BOTH',
    );
  });
  it('un compte vide n’a rien à remettre : jamais signalé pour la durée', () => {
    expect(assessCashHolding({ ...base, balanceXaf: 0, daysWithoutTransfer: 90 })).toBeNull();
  });
  it('un seuil nul désactive son critère', () => {
    expect(assessCashHolding({ ...base, balanceXaf: 900_000, maxXaf: 0 })).toBeNull();
    expect(assessCashHolding({ ...base, daysWithoutTransfer: 90, maxDays: 0 })).toBeNull();
  });
});

describe('cashHeldSince (FIFO : l’espèce détenue est la plus récemment entrée)', () => {
  const at = (day: string) => new Date(`${day}T08:00:00.000Z`);
  const inflows = [
    { occurredAt: at('2026-10-12'), amountXaf: 40_000 },
    { occurredAt: at('2026-10-09'), amountXaf: 20_000 },
    { occurredAt: at('2026-10-02'), amountXaf: 30_000 },
  ];
  it('le solde est couvert par les entrées les plus récentes', () => {
    expect(cashHeldSince(40_000, inflows)).toEqual(at('2026-10-12'));
    expect(cashHeldSince(40_001, inflows)).toEqual(at('2026-10-09'));
    expect(cashHeldSince(60_000, inflows)).toEqual(at('2026-10-09'));
    expect(cashHeldSince(60_001, inflows)).toEqual(at('2026-10-02'));
    expect(cashHeldSince(90_000, inflows)).toEqual(at('2026-10-02'));
  });
  it('historique tronqué : la plus ancienne entrée lue ; solde nul ou aucune entrée : null', () => {
    expect(cashHeldSince(500_000, inflows)).toEqual(at('2026-10-02'));
    expect(cashHeldSince(0, inflows)).toBeNull();
    expect(cashHeldSince(-5, inflows)).toBeNull();
    expect(cashHeldSince(10, [])).toBeNull();
  });
});

describe('businessDaysBetween', () => {
  it('compte les jours métier entiers, signé', () => {
    expect(businessDaysBetween('2026-10-10', '2026-10-14')).toBe(4);
    expect(businessDaysBetween('2026-10-14', '2026-10-14')).toBe(0);
    expect(businessDaysBetween('2026-10-14', '2026-10-10')).toBe(-4);
    expect(businessDaysBetween('2026-09-30', '2026-10-01')).toBe(1);
  });
});

describe('cashHoldingThresholdFrom', () => {
  it('entier ≥ 0 (nombre ou chaîne) ; sinon le défaut', () => {
    expect(cashHoldingThresholdFrom(150_000, 1)).toBe(150_000);
    expect(cashHoldingThresholdFrom('5', 1)).toBe(5);
    expect(cashHoldingThresholdFrom(0, 1)).toBe(0);
    for (const bad of [-1, 2.5, 'x', '', null, undefined, {}]) {
      expect(cashHoldingThresholdFrom(bad, 7)).toBe(7);
    }
  });
  it('défauts du seed', () => {
    expect(DEFAULT_CASH_HOLDING_MAX_XAF).toBe(200_000);
    expect(DEFAULT_CASH_HOLDING_MAX_DAYS).toBe(3);
  });
});

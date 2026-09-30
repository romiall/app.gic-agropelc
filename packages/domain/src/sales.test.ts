import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { quantityFromDecimal as q, quantityToDecimal, ZERO_QUANTITY } from './quantity.js';
import { xaf } from './money.js';
import {
  allocatePayment,
  checkSaleCustomer,
  confirmableQuantity,
  creditCheck,
  discountFromPercentXaf,
  dueDateOf,
  excessPaymentXaf,
  isProbableDuplicatePayment,
  lineCancellationAmountXaf,
  maxDiscountPctOf,
  normalizePaymentReference,
  salesOrderLineAdjustment,
  salesOrderLineProgress,
  salesOrderStatusFromLines,
  priceOverrideCheck,
  pricingQuantity,
  receivableAging,
  saleBalances,
  saleLineAmounts,
  saleTotals,
  withinCancellationWindow,
} from './sales.js';

const code = (fn: () => unknown) => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
};
const dec = quantityToDecimal;

describe('pricingQuantity — BR-VEN-013, AV-031', () => {
  it('à l’unité : la quantité de base, le poids n’étant qu’une information', () => {
    expect(
      dec(pricingQuantity({ pricingMode: 'PER_UNIT', quantityBase: q(3), weightKg: q(4.2) })),
    ).toBe(3);
  });

  it('au poids : le poids pesé, obligatoire et positif', () => {
    expect(
      dec(pricingQuantity({ pricingMode: 'PER_WEIGHT', quantityBase: q(2), weightKg: q(3.75) })),
    ).toBe(3.75);
    expect(code(() => pricingQuantity({ pricingMode: 'PER_WEIGHT', quantityBase: q(2) }))).toBe(
      'WEIGHT_REQUIRED',
    );
    expect(
      code(() =>
        pricingQuantity({ pricingMode: 'PER_WEIGHT', quantityBase: q(2), weightKg: ZERO_QUANTITY }),
      ),
    ).toBe('WEIGHT_REQUIRED');
    expect(
      code(() => pricingQuantity({ pricingMode: 'PER_UNIT', quantityBase: ZERO_QUANTITY })),
    ).toBe('SALE_LINE_INVALID');
  });
});

describe('montants de ligne et totaux — BR-VEN-014, INV-VEN-03, AV-060', () => {
  it('arrondi au franc demi supérieur de quantité × prix, puis remise', () => {
    // 2,5 kg × 1 999 = 4 997,5 → 4 998.
    const line = saleLineAmounts({
      pricingQuantity: q(2.5),
      unitPriceXaf: xaf(1999),
      discountXaf: xaf(98),
      listUnitPriceXaf: xaf(2100),
    });
    expect(line).toEqual({
      grossXaf: 4998,
      discountXaf: 98,
      lineTotalXaf: 4900,
      listAmountXaf: 5250,
    });
  });

  it('sans prix catalogue, montant catalogue nul ; remise supérieure au brut refusée', () => {
    expect(
      saleLineAmounts({ pricingQuantity: q(2), unitPriceXaf: xaf(1000) }).listAmountXaf,
    ).toBeNull();
    expect(
      code(() =>
        saleLineAmounts({ pricingQuantity: q(1), unitPriceXaf: xaf(100), discountXaf: xaf(101) }),
      ),
    ).toBe('DISCOUNT_INVALID');
    expect(
      code(() => saleLineAmounts({ pricingQuantity: ZERO_QUANTITY, unitPriceXaf: xaf(1) })),
    ).toBe('SALE_LINE_INVALID');
  });

  it('total = Σ des lignes arrondies ; taxes à 0 (AV-041) ; vente vide refusée', () => {
    const lines = [
      saleLineAmounts({ pricingQuantity: q(1.5), unitPriceXaf: xaf(333) }), // 499,5 → 500
      saleLineAmounts({ pricingQuantity: q(1.5), unitPriceXaf: xaf(333), discountXaf: xaf(50) }),
    ];
    expect(saleTotals(lines)).toEqual({
      subtotalXaf: 1000,
      discountTotalXaf: 50,
      taxTotalXaf: 0,
      totalXaf: 950,
    });
    expect(code(() => saleTotals([]))).toBe('SALE_EMPTY');
  });

  it('remise en pourcentage convertie au franc, deux décimales au plus', () => {
    expect(discountFromPercentXaf(xaf(9999), 5)).toBe(500); // 499,95 → 500
    expect(discountFromPercentXaf(xaf(1000), 2.5)).toBe(25);
    expect(discountFromPercentXaf(xaf(10), 0)).toBe(0);
    expect(code(() => discountFromPercentXaf(xaf(10), 101))).toBe('DISCOUNT_INVALID');
    expect(code(() => discountFromPercentXaf(xaf(10), 1.234))).toBe('DISCOUNT_INVALID');
  });
});

describe('dérogation de prix — BR-VEN-015, AV-026', () => {
  it('plafond du rôle le plus favorable ; permission sans plafond = 0 %', () => {
    expect(maxDiscountPctOf([])).toBeNull();
    expect(maxDiscountPctOf([5, 15, undefined])).toBe(15);
    expect(maxDiscountPctOf([null])).toBe(0);
    expect(code(() => maxDiscountPctOf([150]))).toBe('DISCOUNT_LIMIT_INVALID');
  });

  it('dans le plafond, au-delà, sans prix de référence, sans permission', () => {
    expect(
      priceOverrideCheck({
        listAmountXaf: xaf(10000),
        lineTotalXaf: xaf(10000),
        maxDiscountPct: null,
      }),
    ).toEqual({
      outcome: 'NONE',
      discountBp: 0,
    });
    expect(
      priceOverrideCheck({ listAmountXaf: xaf(10000), lineTotalXaf: xaf(9500), maxDiscountPct: 5 }),
    ).toEqual({
      outcome: 'WITHIN_LIMIT',
      discountBp: 500,
    });
    // 5,001 % arrondi au supérieur : au-delà de 5 %.
    expect(
      priceOverrideCheck({
        listAmountXaf: xaf(100000),
        lineTotalXaf: xaf(94999),
        maxDiscountPct: 5,
      }).outcome,
    ).toBe('EXCEEDS_LIMIT');
    expect(
      priceOverrideCheck({ listAmountXaf: null, lineTotalXaf: xaf(500), maxDiscountPct: 15 }),
    ).toEqual({
      outcome: 'NO_REFERENCE_PRICE',
      discountBp: null,
    });
    expect(
      priceOverrideCheck({
        listAmountXaf: xaf(1000),
        lineTotalXaf: xaf(900),
        maxDiscountPct: null,
      }),
    ).toEqual({
      outcome: 'NOT_PERMITTED',
      discountBp: 1000,
    });
    // Prix supérieur au catalogue : dérogation sans remise.
    expect(
      priceOverrideCheck({ listAmountXaf: xaf(1000), lineTotalXaf: xaf(1100), maxDiscountPct: 0 }),
    ).toEqual({
      outcome: 'WITHIN_LIMIT',
      discountBp: 0,
    });
  });
});

describe('crédit et client — BR-VEN-024, BR-VEN-025, AV-027, AV-028', () => {
  it('sans crédit, dans le plafond, client non autorisé, dépassement', () => {
    expect(
      creditCheck({
        creditAllowed: false,
        creditLimitXaf: null,
        outstandingXaf: xaf(0),
        newCreditXaf: xaf(0),
      }),
    ).toEqual({ outcome: 'NO_CREDIT', exceedsByXaf: 0 });
    expect(
      creditCheck({
        creditAllowed: true,
        creditLimitXaf: xaf(100000),
        outstandingXaf: xaf(60000),
        newCreditXaf: xaf(40000),
      }),
    ).toEqual({ outcome: 'WITHIN_LIMIT', exceedsByXaf: 0 });
    expect(
      creditCheck({
        creditAllowed: false,
        creditLimitXaf: xaf(100000),
        outstandingXaf: xaf(0),
        newCreditXaf: xaf(5000),
      }),
    ).toEqual({ outcome: 'NOT_ALLOWED', exceedsByXaf: 5000 });
    expect(
      creditCheck({
        creditAllowed: true,
        creditLimitXaf: xaf(100000),
        outstandingXaf: xaf(60000),
        newCreditXaf: xaf(45000),
      }),
    ).toEqual({ outcome: 'EXCEEDS_LIMIT', exceedsByXaf: 5000 });
    // Sans plafond défini, tout crédit dépasse (défaut prudent).
    expect(
      creditCheck({
        creditAllowed: true,
        creditLimitXaf: null,
        outstandingXaf: xaf(0),
        newCreditXaf: xaf(1),
      }),
    ).toEqual({ outcome: 'EXCEEDS_LIMIT', exceedsByXaf: 1 });
  });

  it('vente anonyme intégralement payée ; commande avec client', () => {
    expect(() =>
      checkSaleCustomer({
        hasCustomer: false,
        isOrder: false,
        totalXaf: xaf(500),
        paidXaf: xaf(500),
      }),
    ).not.toThrow();
    expect(
      code(() =>
        checkSaleCustomer({
          hasCustomer: false,
          isOrder: false,
          totalXaf: xaf(500),
          paidXaf: xaf(499),
        }),
      ),
    ).toBe('ANONYMOUS_REQUIRES_FULL_PAYMENT');
    expect(
      code(() =>
        checkSaleCustomer({ hasCustomer: false, isOrder: true, totalXaf: xaf(0), paidXaf: xaf(0) }),
      ),
    ).toBe('ORDER_CUSTOMER_REQUIRED');
    expect(() =>
      checkSaleCustomer({ hasCustomer: true, isOrder: true, totalXaf: xaf(500), paidXaf: xaf(0) }),
    ).not.toThrow();
  });
});

describe('paiements — BR-VEN-026, BR-FIN-003 à 005, INV-VEN-06, INV-FIN-03, INV-FIN-04', () => {
  it('statut dérivé du net (total − annulé) et du payé', () => {
    expect(saleBalances({ totalXaf: xaf(1000), paidXaf: xaf(0) })).toEqual({
      netTotalXaf: 1000,
      balanceDueXaf: 1000,
      paymentStatus: 'UNPAID',
    });
    expect(
      saleBalances({ totalXaf: xaf(1000), cancelledXaf: xaf(400), paidXaf: xaf(200) }),
    ).toEqual({
      netTotalXaf: 600,
      balanceDueXaf: 400,
      paymentStatus: 'PARTIALLY_PAID',
    });
    expect(saleBalances({ totalXaf: xaf(0), paidXaf: xaf(0) }).paymentStatus).toBe('PAID');
    expect(
      code(() => saleBalances({ totalXaf: xaf(1000), cancelledXaf: xaf(400), paidXaf: xaf(700) })),
    ).toBe('PAYMENT_OVER_ALLOCATED');
    expect(
      code(() => saleBalances({ totalXaf: xaf(1000), cancelledXaf: xaf(1001), paidXaf: xaf(0) })),
    ).toBe('CANCELLATION_INVALID');
    expect(excessPaymentXaf(xaf(600), xaf(700))).toBe(100);
    expect(excessPaymentXaf(xaf(600), xaf(500))).toBe(0);
  });

  it('affectation dans l’ordre donné, reste en crédit client', () => {
    expect(
      allocatePayment(xaf(10000), [
        { targetId: 'a', balanceXaf: xaf(3000) },
        { targetId: 'b', balanceXaf: xaf(0) },
        { targetId: 'c', balanceXaf: xaf(5000) },
      ]),
    ).toEqual({
      allocations: [
        { targetId: 'a', amountXaf: 3000 },
        { targetId: 'c', amountXaf: 5000 },
      ],
      unallocatedXaf: 2000,
    });
    expect(allocatePayment(xaf(2500), [{ targetId: 'a', balanceXaf: xaf(3000) }])).toEqual({
      allocations: [{ targetId: 'a', amountXaf: 2500 }],
      unallocatedXaf: 0,
    });
    expect(code(() => allocatePayment(xaf(0), []))).toBe('PAYMENT_INVALID');
  });

  it('référence normalisée ; doublon probable sans référence', () => {
    expect(normalizePaymentReference(' mp 2309.123 ')).toBe('MP2309.123');
    expect(normalizePaymentReference('   ')).toBeNull();
    expect(normalizePaymentReference(null)).toBeNull();
    const base = {
      customerId: 'c1',
      amountXaf: xaf(5000),
      occurredAt: new Date('2026-10-01T09:00:00Z'),
    };
    expect(
      isProbableDuplicatePayment({
        a: base,
        b: { ...base, occurredAt: new Date('2026-10-01T09:10:00Z') },
        windowMinutes: 10,
      }),
    ).toBe(true);
    expect(
      isProbableDuplicatePayment({
        a: base,
        b: { ...base, occurredAt: new Date('2026-10-01T09:10:01Z') },
        windowMinutes: 10,
      }),
    ).toBe(false);
    expect(
      isProbableDuplicatePayment({
        a: base,
        b: { ...base, amountXaf: xaf(5001) },
        windowMinutes: 10,
      }),
    ).toBe(false);
    expect(
      isProbableDuplicatePayment({
        a: { ...base, customerId: null },
        b: { ...base, customerId: null },
        windowMinutes: 10,
      }),
    ).toBe(false);
  });
});

describe('annulation, échéance et ancienneté — BR-VEN-023, BR-VEN-028, BR-FIN-007, AV-030, AV-129', () => {
  it('délai d’annulation directe', () => {
    const sale = new Date('2026-10-01T10:00:00Z');
    expect(
      withinCancellationWindow({
        saleOccurredAt: sale,
        cancelAt: new Date('2026-10-01T10:15:00Z'),
        windowMinutes: 15,
      }),
    ).toBe(true);
    expect(
      withinCancellationWindow({
        saleOccurredAt: sale,
        cancelAt: new Date('2026-10-01T10:15:01Z'),
        windowMinutes: 15,
      }),
    ).toBe(false);
    expect(
      code(() =>
        withinCancellationWindow({ saleOccurredAt: sale, cancelAt: sale, windowMinutes: -1 }),
      ),
    ).toBe('THRESHOLD_INVALID');
  });

  it('échéance au jour métier Douala de la vente + délai', () => {
    // 23:30 UTC = 00:30 le lendemain à Douala.
    expect(dueDateOf(new Date('2026-09-30T23:30:00Z'), 30)).toBe('2026-10-31');
    expect(dueDateOf(new Date('2026-10-01T08:00:00Z'), 0)).toBe('2026-10-01');
    expect(code(() => dueDateOf(new Date(), -1))).toBe('PAYMENT_TERMS_INVALID');
  });

  it('jours de retard et tranches', () => {
    expect(receivableAging('2026-10-31', '2026-10-31')).toEqual({
      daysOverdue: 0,
      overdue: false,
      bucket: '0-30',
    });
    expect(receivableAging('2026-10-31', '2026-10-20')).toEqual({
      daysOverdue: 0,
      overdue: false,
      bucket: '0-30',
    });
    expect(receivableAging('2026-10-31', '2026-12-01')).toEqual({
      daysOverdue: 31,
      overdue: true,
      bucket: '31-60',
    });
    expect(receivableAging('2026-01-01', '2026-04-01').bucket).toBe('61-90');
    expect(receivableAging('2026-01-01', '2026-06-01').bucket).toBe('>90');
  });

  it('annulation partielle au prorata ; la dernière emporte le reste exact', () => {
    const line = { lineTotalXaf: xaf(1000), quantity: q(3) };
    const first = lineCancellationAmountXaf({
      ...line,
      alreadyCancelledQuantity: ZERO_QUANTITY,
      alreadyCancelledXaf: xaf(0),
      cancelQuantity: q(1),
    });
    expect(first).toBe(333);
    const second = lineCancellationAmountXaf({
      ...line,
      alreadyCancelledQuantity: q(1),
      alreadyCancelledXaf: first,
      cancelQuantity: q(1),
    });
    expect(second).toBe(333);
    const last = lineCancellationAmountXaf({
      ...line,
      alreadyCancelledQuantity: q(2),
      alreadyCancelledXaf: xaf(first + second),
      cancelQuantity: q(1),
    });
    expect(first + second + last).toBe(1000);
    expect(
      code(() =>
        lineCancellationAmountXaf({
          ...line,
          alreadyCancelledQuantity: q(2),
          alreadyCancelledXaf: xaf(666),
          cancelQuantity: q(2),
        }),
      ),
    ).toBe('CANCELLATION_INVALID');
    // Demi supérieur : 1 000 × 1/8 = 125 ; 1 001 × 1/2 = 500,5 → 501.
    expect(
      lineCancellationAmountXaf({
        lineTotalXaf: xaf(1001),
        quantity: q(2),
        alreadyCancelledQuantity: ZERO_QUANTITY,
        alreadyCancelledXaf: xaf(0),
        cancelQuantity: q(1),
      }),
    ).toBe(501);
  });
});

describe('commandes — ADR-028, AV-127, AV-128, AV-130, INV-VEN-04', () => {
  it('en attente et à livrer ; ligne incohérente refusée', () => {
    const progress = salesOrderLineProgress({ ordered: q(100), sold: q(70), delivered: q(30) });
    expect([dec(progress.pending), dec(progress.undelivered)]).toEqual([30, 40]);
    expect(
      code(() => salesOrderLineProgress({ ordered: q(10), sold: q(11), delivered: q(0) })),
    ).toBe('ORDER_LINE_INCONSISTENT');
    expect(
      code(() => salesOrderLineProgress({ ordered: q(10), sold: q(5), delivered: q(6) })),
    ).toBe('ORDER_LINE_INCONSISTENT');
  });

  it('vente du disponible (AV-127)', () => {
    expect(dec(confirmableQuantity(q(100), q(60)))).toBe(60);
    expect(dec(confirmableQuantity(q(100), q(150)))).toBe(100);
    expect(dec(confirmableQuantity(q(100), q(-5)))).toBe(0);
  });

  it('ajustement : baisse sur l’attente puis le vendu non livré, hausse en attente, jamais sous le livré', () => {
    const line = { ordered: q(100), sold: q(70), delivered: q(30) };
    const down = salesOrderLineAdjustment(line, q(50));
    expect([dec(down.cancelPending), dec(down.cancelUndelivered), dec(down.addPending)]).toEqual([
      30, 20, 0,
    ]);
    const small = salesOrderLineAdjustment(line, q(80));
    expect([dec(small.cancelPending), dec(small.cancelUndelivered)]).toEqual([20, 0]);
    const up = salesOrderLineAdjustment(line, q(120));
    expect(dec(up.addPending)).toBe(20);
    // Reste non livré annulé (AV-128) = ajustement au livré.
    const rest = salesOrderLineAdjustment(line, q(30));
    expect([dec(rest.cancelPending), dec(rest.cancelUndelivered)]).toEqual([30, 40]);
    expect(code(() => salesOrderLineAdjustment(line, q(29)))).toBe(
      'ORDER_QUANTITY_BELOW_DELIVERED',
    );
  });

  it('statut dérivé des lignes', () => {
    expect(salesOrderStatusFromLines([], { draft: true })).toBe('DRAFT');
    expect(salesOrderStatusFromLines([{ ordered: q(10), sold: q(0), delivered: q(0) }])).toBe(
      'CONFIRMED',
    );
    expect(salesOrderStatusFromLines([{ ordered: q(10), sold: q(10), delivered: q(0) }])).toBe(
      'CONFIRMED',
    );
    expect(salesOrderStatusFromLines([{ ordered: q(10), sold: q(10), delivered: q(4) }])).toBe(
      'PARTIALLY_FULFILLED',
    );
    expect(salesOrderStatusFromLines([{ ordered: q(10), sold: q(10), delivered: q(10) }])).toBe(
      'FULFILLED',
    );
    expect(
      salesOrderStatusFromLines([{ ordered: q(4), sold: q(4), delivered: q(4) }], {
        remainderCancelled: true,
      }),
    ).toBe('CLOSED');
    expect(salesOrderStatusFromLines([{ ordered: q(0), sold: q(0), delivered: q(0) }])).toBe(
      'CANCELLED',
    );
  });
});

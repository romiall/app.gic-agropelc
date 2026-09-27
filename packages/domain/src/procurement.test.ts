import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { quantityFromDecimal as q, quantityToDecimal, ZERO_QUANTITY } from './quantity.js';
import { xaf } from './money.js';
import {
  orderAmounts,
  orderLineRemaining,
  orderRequiresApproval,
  orderStatusFromLines,
  overReceiptQuantity,
  receiptAcceptedValueXaf,
  receiptLineQuantities,
  receiptPhotoRequired,
  requestStatusFromLines,
} from './procurement.js';

const code = (fn: () => unknown) => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
};

describe('receiptLineQuantities — BR-APP-007, INV-APP-01', () => {
  it('accepté = livré − rejeté ; rejet signalé', () => {
    const line = receiptLineQuantities({ delivered: q(98), rejected: q(3) });
    expect(quantityToDecimal(line.accepted)).toBe(95);
    expect(line.hasRejection).toBe(true);
    expect(receiptLineQuantities({ delivered: q(10), rejected: ZERO_QUANTITY }).hasRejection).toBe(
      false,
    );
  });

  it('rejet complet admis (produit non commandé) ; livré nul ou rejet hors bornes refusés', () => {
    expect(
      quantityToDecimal(receiptLineQuantities({ delivered: q(4), rejected: q(4) }).accepted),
    ).toBe(0);
    expect(
      code(() => receiptLineQuantities({ delivered: ZERO_QUANTITY, rejected: ZERO_QUANTITY })),
    ).toBe('RECEIPT_LINE_INVALID');
    expect(code(() => receiptLineQuantities({ delivered: q(4), rejected: q(5) }))).toBe(
      'RECEIPT_LINE_INVALID',
    );
    expect(code(() => receiptLineQuantities({ delivered: q(4), rejected: q(-1) }))).toBe(
      'RECEIPT_LINE_INVALID',
    );
  });
});

describe('reliquat et excédent — BR-APP-009, BR-APP-010 (AT-023)', () => {
  const line = { ordered: q(100), accepted: q(95), closed: ZERO_QUANTITY };

  it('AT-023 : BC de 100, livré 98, rejeté 3 → accepté 95, reliquat 5', () => {
    expect(quantityToDecimal(orderLineRemaining(line))).toBe(5);
    expect(quantityToDecimal(orderLineRemaining({ ...line, closed: q(5) }))).toBe(0);
    expect(quantityToDecimal(orderLineRemaining({ ...line, cancelled: true }))).toBe(0);
  });

  it('excédent au-delà du commandé, avec tolérance paramétrée (AV-053)', () => {
    expect(quantityToDecimal(overReceiptQuantity(line, q(5), 0))).toBe(0);
    expect(quantityToDecimal(overReceiptQuantity(line, q(8), 0))).toBe(3);
    expect(quantityToDecimal(overReceiptQuantity(line, q(8), 2))).toBe(1); // 2 % de 100 = 2
    expect(quantityToDecimal(overReceiptQuantity({ ...line, closed: q(5) }, q(1), 0))).toBe(1);
    expect(code(() => overReceiptQuantity(line, q(1), -1))).toBe('TOLERANCE_INVALID');
  });
});

describe('statuts dérivés — SM-PURCHASE-ORDER, SM-PURCHASE-REQUEST', () => {
  it('BC : envoyé, partiellement reçu, reçu, clôturé', () => {
    const open = { ordered: q(10), accepted: ZERO_QUANTITY, closed: ZERO_QUANTITY };
    expect(orderStatusFromLines([open])).toBe('SENT');
    expect(orderStatusFromLines([{ ...open, accepted: q(4) }, open])).toBe('PARTIALLY_RECEIVED');
    expect(
      orderStatusFromLines([
        { ...open, accepted: q(10) },
        { ...open, cancelled: true },
      ]),
    ).toBe('RECEIVED');
    expect(orderStatusFromLines([{ ...open, accepted: q(4), closed: q(6) }])).toBe('CLOSED');
  });

  it('DA : approuvée, partiellement commandée, commandée', () => {
    expect(requestStatusFromLines([{ requested: q(5), ordered: ZERO_QUANTITY }])).toBe('APPROVED');
    expect(
      requestStatusFromLines([
        { requested: q(5), ordered: q(5) },
        { requested: q(2), ordered: ZERO_QUANTITY },
      ]),
    ).toBe('PARTIALLY_ORDERED');
    expect(requestStatusFromLines([{ requested: q(5), ordered: q(5) }])).toBe('ORDERED');
  });
});

describe('receiptPhotoRequired — BR-APP-014', () => {
  it('sans BC, ou à partir du seuil de valeur acceptée', () => {
    expect(
      receiptPhotoRequired({ withoutOrder: true, acceptedValueXaf: 0, thresholdXaf: 100_000 }),
    ).toBe(true);
    expect(
      receiptPhotoRequired({
        withoutOrder: false,
        acceptedValueXaf: 100_000,
        thresholdXaf: 100_000,
      }),
    ).toBe(true);
    expect(
      receiptPhotoRequired({
        withoutOrder: false,
        acceptedValueXaf: 99_999,
        thresholdXaf: 100_000,
      }),
    ).toBe(false);
  });
});

describe('montants — BR-APP-005, AV-051', () => {
  it('lignes arrondies au franc, total, seuil strictement dépassé', () => {
    const { lineTotals, total } = orderAmounts([
      { quantity: q(100), unitPriceXaf: 15_000 },
      { quantity: q(2.5), unitPriceXaf: 333 },
    ]);
    expect(lineTotals).toEqual([1_500_000, 833]); // 832,5 → 833 (demi supérieur)
    expect(total).toBe(1_500_833);
    expect(orderRequiresApproval(total, 500_000)).toBe(true);
    expect(orderRequiresApproval(xaf(500_000), 500_000)).toBe(false);
    expect(code(() => orderAmounts([{ quantity: q(1), unitPriceXaf: -1 }]))).toBe('PRICE_INVALID');
    expect(code(() => orderAmounts([{ quantity: q(1), unitPriceXaf: 10.5 }]))).toBe(
      'PRICE_INVALID',
    );
    expect(code(() => orderAmounts([{ quantity: ZERO_QUANTITY, unitPriceXaf: 10 }]))).toBe(
      'QUANTITY_INVALID',
    );
  });

  it('valeur acceptée d’une réception', () => {
    expect(
      receiptAcceptedValueXaf([
        { accepted: q(95), unitCostXaf: 15_000 },
        { accepted: ZERO_QUANTITY, unitCostXaf: 900 },
      ]),
    ).toBe(1_425_000);
  });
});

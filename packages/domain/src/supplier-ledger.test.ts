import { describe, expect, it } from 'vitest';
import { quantityFromDecimal, quantityToDecimal } from './quantity.js';
import {
  invoicedQuantitiesByOrderLine,
  matchSupplierInvoice,
  normalizedInvoiceRef,
  planSupplierPayment,
  quantityExcessSince,
  supplierInvoiceDueDate,
  supplierInvoiceStatusFromPaid,
  supplierInvoiceTransition,
  supplierPaymentRequiresApproval,
  supplierPaymentTransition,
  type InvoiceLineInput,
  type PayableInvoice,
} from './supplier-ledger.js';

const q = quantityFromDecimal;
const order = (overrides: Partial<{ accepted: number; invoiced: number; price: number }> = {}) => ({
  supplierId: 'fournisseur',
  lines: [
    {
      poLineId: 'ligne-bc',
      unitPriceXaf: overrides.price ?? 15_000,
      accepted: q(overrides.accepted ?? 95),
      invoiced: q(overrides.invoiced ?? 0),
    },
  ],
});
const line = (quantity: number, unitPrice = 15_000, total?: number): InvoiceLineInput => ({
  poLineId: 'ligne-bc',
  quantity: q(quantity),
  unitPriceXaf: unitPrice,
  lineTotalXaf: total ?? quantity * unitPrice,
});
const match = (
  overrides: Partial<Parameters<typeof matchSupplierInvoice>[0]> = {},
): ReturnType<typeof matchSupplierInvoice> =>
  matchSupplierInvoice({
    supplierId: 'fournisseur',
    order: order(),
    lines: [line(95)],
    printedTotalXaf: null,
    qtyTolerancePct: 0,
    priceToleranceXaf: 0,
    withoutOrderMode: 'REVIEW',
    ...overrides,
  });

describe('rapprochement d’une facture (BR-FIN-031, AT-025)', () => {
  it('95 facturés pour 95 acceptés au prix du BC : conforme, total 1 425 000', () => {
    const result = match({ printedTotalXaf: 1_425_000 });
    expect(result.conforming).toBe(true);
    expect(result.totalXaf).toBe(1_425_000);
    expect(result.details).toEqual([]);
  });

  it('98 facturés pour 95 acceptés : MISMATCH (QUANTITY_ABOVE_ACCEPTED, 95 contre 98)', () => {
    const result = match({ lines: [line(98)] });
    expect(result.conforming).toBe(false);
    expect(result.totalXaf).toBe(1_470_000);
    expect(result.details).toEqual([
      {
        reason: 'QUANTITY_ABOVE_ACCEPTED',
        lineIndex: null,
        poLineId: 'ligne-bc',
        expected: 95,
        actual: 98,
      },
    ]);
  });

  it('le déjà facturé compte : 50 + 50 pour 95 acceptés est un écart ; deux lignes s’additionnent', () => {
    expect(match({ order: order({ invoiced: 50 }), lines: [line(50)] }).conforming).toBe(false);
    expect(match({ order: order({ invoiced: 45 }), lines: [line(50)] }).conforming).toBe(true);
    expect(match({ lines: [line(50), line(46)] }).details[0]?.reason).toBe(
      'QUANTITY_ABOVE_ACCEPTED',
    );
    expect(invoicedQuantitiesByOrderLine([line(50), line(45)]).get('ligne-bc')).toBe(q(95));
  });

  it('tolérance de quantité en pour cent de l’accepté (AV-053)', () => {
    expect(match({ lines: [line(98)], qtyTolerancePct: 3 }).conforming).toBe(false);
    expect(match({ lines: [line(97)], qtyTolerancePct: 3 }).conforming).toBe(true);
  });

  it('prix différent du BC : PRICE_MISMATCH, sauf dans la tolérance', () => {
    const result = match({ lines: [line(95, 15_100)] });
    expect(result.details.map((d) => d.reason)).toEqual(['PRICE_MISMATCH']);
    expect(result.details[0]).toMatchObject({ expected: 15_000, actual: 15_100, lineIndex: 0 });
    expect(match({ lines: [line(95, 15_100)], priceToleranceXaf: 100 }).conforming).toBe(true);
  });

  it('montant de ligne et total imprimé incohérents', () => {
    expect(match({ lines: [line(95, 15_000, 1_425_001)] }).details.map((d) => d.reason)).toEqual([
      'LINE_AMOUNT_MISMATCH',
    ]);
    expect(match({ printedTotalXaf: 1_400_000 }).details).toEqual([
      {
        reason: 'TOTAL_MISMATCH',
        lineIndex: null,
        poLineId: null,
        expected: 1_425_000,
        actual: 1_400_000,
      },
    ]);
  });

  it('ligne hors BC et fournisseur différent : écarts', () => {
    const transport: InvoiceLineInput = {
      poLineId: null,
      quantity: null,
      unitPriceXaf: null,
      lineTotalXaf: 20_000,
    };
    expect(match({ lines: [line(95), transport] }).details.map((d) => d.reason)).toEqual([
      'LINE_NOT_ON_ORDER',
    ]);
    expect(match({ supplierId: 'autre' }).details.map((d) => d.reason)).toEqual([
      'SUPPLIER_MISMATCH',
    ]);
  });

  it('facture sans BC : revue par défaut, approuvée en mode APPROVE (AV-271)', () => {
    const service: InvoiceLineInput = {
      poLineId: null,
      quantity: null,
      unitPriceXaf: null,
      lineTotalXaf: 30_000,
    };
    expect(match({ order: null, lines: [service] }).details.map((d) => d.reason)).toEqual([
      'NO_PURCHASE_ORDER',
    ]);
    expect(match({ order: null, lines: [service], withoutOrderMode: 'APPROVE' }).conforming).toBe(
      true,
    );
  });

  it('données invalides : refus (ligne de BC sans quantité, ligne étrangère, montant, facture vide)', () => {
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    };
    expect(codeOf(() => match({ lines: [] }))).toBe('INVOICE_LINE_INVALID');
    expect(
      codeOf(() =>
        match({
          lines: [{ poLineId: 'ligne-bc', quantity: null, unitPriceXaf: 1, lineTotalXaf: 1 }],
        }),
      ),
    ).toBe('INVOICE_LINE_INVALID');
    expect(codeOf(() => match({ lines: [{ ...line(1), poLineId: 'autre-ligne' }] }))).toBe(
      'PO_LINE_MISMATCH',
    );
    expect(codeOf(() => match({ order: null, lines: [line(1)] }))).toBe('PO_LINE_MISMATCH');
    expect(codeOf(() => match({ lines: [line(1, 15_000, -5)] }))).toBe('AMOUNT_INVALID');
    expect(codeOf(() => match({ lines: [line(1, -1, 0)] }))).toBe('AMOUNT_INVALID');
  });

  it('quantités décimales : comparaison en millièmes', () => {
    const result = match({
      order: order({ accepted: 10.5, price: 1_000 }),
      lines: [line(10.501, 1_000, 10_501)],
    });
    expect(result.details[0]).toMatchObject({
      reason: 'QUANTITY_ABOVE_ACCEPTED',
      expected: 10.5,
      actual: 10.501,
    });
    expect(
      quantityToDecimal(
        invoicedQuantitiesByOrderLine([line(10.5, 1_000, 10_500)]).get('ligne-bc')!,
      ),
    ).toBe(10.5);
  });
});

describe('échéance (AV-273)', () => {
  it('saisie, sinon date + délai du fournisseur, sinon la date', () => {
    expect(
      supplierInvoiceDueDate({
        invoiceDate: '2026-10-01',
        dueDate: '2026-10-20',
        paymentTermsDays: 30,
      }),
    ).toBe('2026-10-20');
    expect(
      supplierInvoiceDueDate({ invoiceDate: '2026-10-01', dueDate: null, paymentTermsDays: 30 }),
    ).toBe('2026-10-31');
    expect(
      supplierInvoiceDueDate({ invoiceDate: '2026-10-01', dueDate: null, paymentTermsDays: null }),
    ).toBe('2026-10-01');
  });
  it('échéance antérieure à la facture : refus', () => {
    expect(() =>
      supplierInvoiceDueDate({
        invoiceDate: '2026-10-01',
        dueDate: '2026-09-30',
        paymentTermsDays: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVOICE_DUE_DATE_INVALID' }));
  });
});

describe('transitions d’une facture (SM-SUPPLIER-INVOICE, AV-272)', () => {
  it('approbation, contestation, annulation', () => {
    expect(supplierInvoiceTransition('MISMATCH', 'APPROVE', 0)).toBe('APPROVED');
    expect(supplierInvoiceTransition('DISPUTED', 'APPROVE', 0)).toBe('APPROVED');
    expect(supplierInvoiceTransition('MISMATCH', 'DISPUTE', 0)).toBe('DISPUTED');
    expect(supplierInvoiceTransition('MISMATCH', 'CANCEL', 0)).toBe('CANCELLED');
    expect(supplierInvoiceTransition('DISPUTED', 'CANCEL', 0)).toBe('CANCELLED');
    expect(supplierInvoiceTransition('APPROVED', 'CANCEL', 0)).toBe('CANCELLED');
  });
  it('payée : annulation refusée (INVOICE_HAS_PAYMENTS) ; autres transitions hors table', () => {
    expect(() => supplierInvoiceTransition('PARTIALLY_PAID', 'CANCEL', 10)).toThrow(
      expect.objectContaining({ code: 'INVOICE_HAS_PAYMENTS' }),
    );
    expect(() => supplierInvoiceTransition('APPROVED', 'APPROVE', 0)).toThrow(
      expect.objectContaining({ code: 'INVOICE_STATUS_INVALID' }),
    );
    expect(() => supplierInvoiceTransition('DISPUTED', 'DISPUTE', 0)).toThrow(
      expect.objectContaining({ code: 'INVOICE_STATUS_INVALID' }),
    );
    expect(() => supplierInvoiceTransition('CANCELLED', 'CANCEL', 0)).toThrow(
      expect.objectContaining({ code: 'INVOICE_STATUS_INVALID' }),
    );
  });
  it('statut payé (INV-FIN-07)', () => {
    expect(supplierInvoiceStatusFromPaid(1_425_000, 0)).toBe('APPROVED');
    expect(supplierInvoiceStatusFromPaid(1_425_000, 425_000)).toBe('PARTIALLY_PAID');
    expect(supplierInvoiceStatusFromPaid(1_425_000, 1_425_000)).toBe('PAID');
    expect(() => supplierInvoiceStatusFromPaid(1_425_000, 1_425_001)).toThrow(
      expect.objectContaining({ code: 'ALLOCATION_EXCEEDS' }),
    );
    expect(() => supplierInvoiceStatusFromPaid(10, -1)).toThrow(
      expect.objectContaining({ code: 'AMOUNT_INVALID' }),
    );
  });
});

describe('paiement fournisseur (BR-FIN-032, 033, AV-275)', () => {
  const invoices = new Map<string, PayableInvoice>([
    ['f1', { supplierId: 'fournisseur', status: 'APPROVED', balanceXaf: 1_425_000 }],
    ['f2', { supplierId: 'fournisseur', status: 'PARTIALLY_PAID', balanceXaf: 100_000 }],
    ['f3', { supplierId: 'fournisseur', status: 'MISMATCH', balanceXaf: 50_000 }],
    ['f4', { supplierId: 'autre', status: 'APPROVED', balanceXaf: 50_000 }],
  ]);
  const plan = (overrides: Partial<Parameters<typeof planSupplierPayment>[0]> = {}) =>
    planSupplierPayment({
      supplierId: 'fournisseur',
      availableXaf: 1_525_000,
      allocations: [
        { invoiceId: 'f1', amountXaf: 1_425_000 },
        { invoiceId: 'f2', amountXaf: 100_000 },
      ],
      invoices,
      advanceAllowed: true,
      ...overrides,
    });
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  };

  it('seuil de validation strict (500 000)', () => {
    expect(supplierPaymentRequiresApproval(500_000, 500_000)).toBe(false);
    expect(supplierPaymentRequiresApproval(1_425_000, 500_000)).toBe(true);
  });

  it('paiement entièrement affecté, puis avance', () => {
    expect(plan().unallocatedXaf).toBe(0);
    expect(plan({ availableXaf: 1_600_000 }).unallocatedXaf).toBe(75_000);
    expect(plan({ allocations: [] }).unallocatedXaf).toBe(1_525_000);
  });

  it('refus : solde dépassé, facture non payable ou d’un autre fournisseur, doublon, montant', () => {
    expect(codeOf(() => plan({ allocations: [{ invoiceId: 'f2', amountXaf: 100_001 }] }))).toBe(
      'ALLOCATION_EXCEEDS',
    );
    expect(codeOf(() => plan({ allocations: [{ invoiceId: 'f3', amountXaf: 1 }] }))).toBe(
      'ALLOCATION_INVALID',
    );
    expect(codeOf(() => plan({ allocations: [{ invoiceId: 'f4', amountXaf: 1 }] }))).toBe(
      'ALLOCATION_INVALID',
    );
    expect(codeOf(() => plan({ allocations: [{ invoiceId: 'inconnue', amountXaf: 1 }] }))).toBe(
      'ALLOCATION_INVALID',
    );
    expect(
      codeOf(() =>
        plan({
          allocations: [
            { invoiceId: 'f2', amountXaf: 1 },
            { invoiceId: 'f2', amountXaf: 1 },
          ],
        }),
      ),
    ).toBe('ALLOCATION_INVALID');
    expect(codeOf(() => plan({ allocations: [{ invoiceId: 'f2', amountXaf: 0 }] }))).toBe(
      'AMOUNT_INVALID',
    );
    expect(codeOf(() => plan({ availableXaf: 1_000_000 }))).toBe('SUPPLIER_PAYMENT_EXCEEDS');
    expect(codeOf(() => plan({ availableXaf: -1 }))).toBe('AMOUNT_INVALID');
  });

  it('avance refusée si elle n’est pas admise', () => {
    expect(codeOf(() => plan({ availableXaf: 1_600_000, advanceAllowed: false }))).toBe(
      'SUPPLIER_PAYMENT_EXCEEDS',
    );
    expect(plan({ advanceAllowed: false }).unallocatedXaf).toBe(0);
  });

  it('transitions (SM-SUPPLIER-PAYMENT)', () => {
    expect(supplierPaymentTransition('PENDING_APPROVAL', 'APPROVE')).toBe('RECORDED');
    expect(supplierPaymentTransition('PENDING_APPROVAL', 'REJECT')).toBe('REJECTED');
    expect(supplierPaymentTransition('PENDING_APPROVAL', 'CANCEL')).toBe('CANCELLED');
    expect(supplierPaymentTransition('RECORDED', 'CANCEL')).toBe('CANCELLED');
    expect(codeOf(() => supplierPaymentTransition('RECORDED', 'APPROVE'))).toBe(
      'SUPPLIER_PAYMENT_STATUS_INVALID',
    );
    expect(codeOf(() => supplierPaymentTransition('CANCELLED', 'CANCEL'))).toBe(
      'SUPPLIER_PAYMENT_STATUS_INVALID',
    );
  });
});

describe('revue de P8-14 : produit, écart apparu depuis la demande, référence normalisée', () => {
  it('produit saisi différent de celui de la ligne de BC : PRODUCT_MISMATCH ; même produit, quelle que soit la casse : conforme', () => {
    const withProduct = (productId: string) =>
      match({
        order: {
          supplierId: 'fournisseur',
          lines: [{ ...order().lines[0]!, productId: 'aliment' }],
        },
        lines: [{ ...line(95), productId }],
      });
    expect(withProduct('autre').details).toEqual([
      {
        reason: 'PRODUCT_MISMATCH',
        lineIndex: 0,
        poLineId: 'ligne-bc',
        expected: null,
        actual: null,
      },
    ]);
    expect(withProduct('ALIMENT').conforming).toBe(true);
  });

  it('dépassement de l’accepté apparu depuis la saisie : signalé ; déjà connu de la demande : non', () => {
    const atRecord = match({ lines: [line(95, 15_500)] });
    expect(atRecord.details.map((detail) => detail.reason)).toEqual(['PRICE_MISMATCH']);
    const now = match({ order: order({ invoiced: 95 }), lines: [line(95, 15_500)] });
    expect(quantityExcessSince(atRecord.details, now)).toEqual(['ligne-bc']);
    expect(quantityExcessSince(now.details, now)).toEqual([]);
    expect(quantityExcessSince(atRecord.details, atRecord)).toEqual([]);
  });

  it('référence fournisseur sans casse ni ponctuation', () => {
    expect(normalizedInvoiceRef('fa-0012')).toBe('FA0012');
    expect(normalizedInvoiceRef(' FA 0012 ')).toBe('FA0012');
    expect(normalizedInvoiceRef('FA/0012')).toBe(normalizedInvoiceRef('fa.0012'));
  });
});

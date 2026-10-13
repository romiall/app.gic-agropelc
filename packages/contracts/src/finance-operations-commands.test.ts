import { describe, expect, it } from 'vitest';
import {
  SUPPLIER_INVOICE_MAX_LINES,
  SUPPLIER_PAYMENT_MAX_ALLOCATIONS,
  expenseCancelPayloadSchema,
  expenseCategoryCreatePayloadSchema,
  expenseCategoryStatusPayloadSchema,
  expenseCategoryUpdatePayloadSchema,
  expensePayPayloadSchema,
  expenseRecordPayloadSchema,
  supplierInvoiceDecisionPayloadSchema,
  supplierInvoiceRecordPayloadSchema,
  supplierPaymentAllocatePayloadSchema,
  supplierPaymentCancelPayloadSchema,
  supplierPaymentRecordPayloadSchema,
} from './finance-operations-commands.js';

const A = '0198c3a0-1111-7aaa-8bbb-000000000001';
const B = '0198c3a0-2222-7aaa-8bbb-000000000002';
const C = '0198c3a0-3333-7aaa-8bbb-000000000003';

describe('catégories de dépense', () => {
  it('création : code en majuscules, type de coût admis', () => {
    expect(
      expenseCategoryCreatePayloadSchema.safeParse({
        code: 'TRANSPORT',
        label: 'Transport',
        allowedOnPos: true,
      }).success,
    ).toBe(true);
    expect(
      expenseCategoryCreatePayloadSchema.safeParse({
        code: 'SOINS',
        label: 'Soins',
        defaultCostType: 'VETERINAIRE',
      }).success,
    ).toBe(true);
    for (const payload of [
      { code: 'transport', label: 'Transport' },
      { code: 'T', label: 'Transport' },
      { code: 'TRANSPORT', label: '' },
      { code: 'ANIMAUX_X', label: 'x', defaultCostType: 'ANIMAUX' },
    ]) {
      expect(expenseCategoryCreatePayloadSchema.safeParse(payload).success).toBe(false);
    }
  });
  it('modification : au moins un champ ; statut : motif', () => {
    expect(expenseCategoryUpdatePayloadSchema.safeParse({ allowedOnPos: false }).success).toBe(
      true,
    );
    expect(expenseCategoryUpdatePayloadSchema.safeParse({ defaultCostType: null }).success).toBe(
      true,
    );
    expect(expenseCategoryUpdatePayloadSchema.safeParse({}).success).toBe(false);
    expect(expenseCategoryStatusPayloadSchema.safeParse({ reason: 'Doublon' }).success).toBe(true);
    expect(expenseCategoryStatusPayloadSchema.safeParse({ reason: ' ' }).success).toBe(false);
  });
});

describe('dépenses', () => {
  const paid = {
    categoryId: A,
    amountXaf: 2_000,
    description: 'Sachets',
    siteId: B,
    paidNow: true,
    paidFromAccountId: C,
  };
  it('payée : compte obligatoire ; à payer : sans compte', () => {
    expect(expenseRecordPayloadSchema.safeParse(paid).success).toBe(true);
    expect(
      expenseRecordPayloadSchema.safeParse({
        ...paid,
        paidNow: false,
        paidFromAccountId: undefined,
      }).success,
    ).toBe(true);
    expect(
      expenseRecordPayloadSchema.safeParse({ ...paid, paidFromAccountId: undefined }).success,
    ).toBe(false);
    expect(expenseRecordPayloadSchema.safeParse({ ...paid, paidNow: false }).success).toBe(false);
  });
  it('montant entier strictement positif, site obligatoire', () => {
    for (const amountXaf of [0, -1, 10.5]) {
      expect(expenseRecordPayloadSchema.safeParse({ ...paid, amountXaf }).success).toBe(false);
    }
    expect(expenseRecordPayloadSchema.safeParse({ ...paid, siteId: undefined }).success).toBe(
      false,
    );
  });
  it('objet de coût : espèce seulement sur un site', () => {
    expect(
      expenseRecordPayloadSchema.safeParse({
        ...paid,
        costObject: { type: 'PRODUCTION_LOT', id: A },
      }).success,
    ).toBe(true);
    expect(
      expenseRecordPayloadSchema.safeParse({
        ...paid,
        costObject: { type: 'SITE', id: B, speciesGroup: 'PORC' },
      }).success,
    ).toBe(true);
    expect(
      expenseRecordPayloadSchema.safeParse({
        ...paid,
        costObject: { type: 'PRODUCTION_LOT', id: A, speciesGroup: 'PORC' },
      }).success,
    ).toBe(false);
    expect(
      expenseRecordPayloadSchema.safeParse({ ...paid, costObject: { type: 'PDV', id: A } }).success,
    ).toBe(false);
  });
  it('paiement et annulation', () => {
    expect(expensePayPayloadSchema.safeParse({ paidFromAccountId: C }).success).toBe(true);
    expect(expensePayPayloadSchema.safeParse({}).success).toBe(false);
    expect(expenseCancelPayloadSchema.safeParse({ reason: 'Saisie en double' }).success).toBe(true);
    expect(expenseCancelPayloadSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('factures fournisseurs', () => {
  const invoice = {
    supplierId: A,
    supplierInvoiceRef: 'F-2026-118',
    invoiceDate: '2026-10-10',
    purchaseOrderId: B,
    printedTotalXaf: 1_470_000,
    lines: [
      {
        poLineId: C,
        description: 'Aliment 50 kg',
        quantity: 98,
        unitPriceXaf: 15_000,
        lineTotalXaf: 1_470_000,
      },
    ],
  };
  it('facture rattachée à un BC (AT-025 : 98 sacs)', () => {
    expect(supplierInvoiceRecordPayloadSchema.safeParse(invoice).success).toBe(true);
  });
  it('dates : format, existence, échéance après la facture', () => {
    expect(
      supplierInvoiceRecordPayloadSchema.safeParse({ ...invoice, dueDate: '2026-11-09' }).success,
    ).toBe(true);
    for (const dates of [
      { invoiceDate: '10/10/2026' },
      { invoiceDate: '2026-02-31' },
      { invoiceDate: '2026-13-45' },
      { dueDate: '2026-10-09' },
    ]) {
      expect(supplierInvoiceRecordPayloadSchema.safeParse({ ...invoice, ...dates }).success).toBe(
        false,
      );
    }
  });
  it('lignes : au moins une, au plus 100 ; ligne de BC sans BC refusée', () => {
    expect(supplierInvoiceRecordPayloadSchema.safeParse({ ...invoice, lines: [] }).success).toBe(
      false,
    );
    const many = Array.from({ length: SUPPLIER_INVOICE_MAX_LINES + 1 }, () => ({
      description: 'Frais',
      lineTotalXaf: 1,
    }));
    expect(supplierInvoiceRecordPayloadSchema.safeParse({ ...invoice, lines: many }).success).toBe(
      false,
    );
    expect(
      supplierInvoiceRecordPayloadSchema.safeParse({ ...invoice, purchaseOrderId: undefined })
        .success,
    ).toBe(false);
    expect(
      supplierInvoiceRecordPayloadSchema.safeParse({
        ...invoice,
        purchaseOrderId: undefined,
        lines: [{ description: 'Transport', lineTotalXaf: 20_000 }],
      }).success,
    ).toBe(true);
  });
  it('quantité à trois décimales au plus', () => {
    expect(
      supplierInvoiceRecordPayloadSchema.safeParse({
        ...invoice,
        lines: [{ ...invoice.lines[0], quantity: 1.0001 }],
      }).success,
    ).toBe(false);
  });
  it('décisions : motif obligatoire', () => {
    expect(
      supplierInvoiceDecisionPayloadSchema.safeParse({ reason: 'Avoir de 3 sacs' }).success,
    ).toBe(true);
    expect(supplierInvoiceDecisionPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('paiements fournisseurs', () => {
  const payment = {
    supplierId: A,
    amountXaf: 1_425_000,
    paymentMethodCode: 'VIREMENT',
    fromAccountId: B,
    allocations: [{ invoiceId: C, amountXaf: 1_425_000 }],
  };
  it('affecté en entier, ou avance sans affectation', () => {
    expect(supplierPaymentRecordPayloadSchema.safeParse(payment).success).toBe(true);
    expect(
      supplierPaymentRecordPayloadSchema.safeParse({ ...payment, allocations: [] }).success,
    ).toBe(true);
  });
  it('refus : affectations au-delà du montant, facture en double, affectation nulle', () => {
    expect(
      supplierPaymentRecordPayloadSchema.safeParse({ ...payment, amountXaf: 1_000_000 }).success,
    ).toBe(false);
    expect(
      supplierPaymentRecordPayloadSchema.safeParse({
        ...payment,
        allocations: [
          { invoiceId: C, amountXaf: 1 },
          { invoiceId: C, amountXaf: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      supplierPaymentRecordPayloadSchema.safeParse({
        ...payment,
        allocations: [{ invoiceId: C, amountXaf: 0 }],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: SUPPLIER_PAYMENT_MAX_ALLOCATIONS + 1 }, (_, index) => ({
      invoiceId: `0198c3a0-1111-7aaa-8bbb-${String(index).padStart(12, '0')}`,
      amountXaf: 1,
    }));
    expect(
      supplierPaymentRecordPayloadSchema.safeParse({ ...payment, allocations: many }).success,
    ).toBe(false);
  });
  it('affectation ultérieure : au moins une ; annulation : motif', () => {
    expect(
      supplierPaymentAllocatePayloadSchema.safeParse({
        allocations: [{ invoiceId: C, amountXaf: 5 }],
      }).success,
    ).toBe(true);
    expect(supplierPaymentAllocatePayloadSchema.safeParse({ allocations: [] }).success).toBe(false);
    expect(
      supplierPaymentCancelPayloadSchema.safeParse({ reason: 'Virement rejeté par la banque' })
        .success,
    ).toBe(true);
    expect(supplierPaymentCancelPayloadSchema.safeParse({ reason: '' }).success).toBe(false);
  });
});

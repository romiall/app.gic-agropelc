import { describe, expect, it } from 'vitest';
import { supplierInvoiceRecordPayloadSchema } from '@gic/contracts';
import {
  duplicateInvoice,
  emptyInvoiceDraft,
  freeLine,
  invoiceActions,
  invoiceDecisionPayload,
  invoiceIssues,
  invoiceListPaths,
  invoicePreview,
  invoiceRecordPayload,
  linesFromMatching,
  parseInvoiceLine,
  sortInvoices,
  type InvoiceDraft,
  type OrderMatchingItem,
  type SupplierInvoiceItem,
} from './supplier-invoice.js';

const SUPPLIER = '01900000-0000-7000-8000-0000000000a1';
const OTHER_SUPPLIER = '01900000-0000-7000-8000-0000000000a2';
const ORDER = '01900000-0000-7000-8000-0000000000a3';
const LINE_A = '01900000-0000-7000-8000-0000000000a4';
const LINE_B = '01900000-0000-7000-8000-0000000000a5';
const PRODUCT_A = '01900000-0000-7000-8000-0000000000a6';
const PRODUCT_B = '01900000-0000-7000-8000-0000000000a7';
const USER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

const invoice = (overrides: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem => ({
  id: 'i1',
  docNumber: 'FF-2026-000001',
  siteId: null,
  supplierId: SUPPLIER,
  supplierInvoiceRef: 'FA-0012',
  invoiceDate: '2026-10-10',
  dueDate: '2026-11-09',
  purchaseOrderId: ORDER,
  totalXaf: 1_470_000,
  printedTotalXaf: null,
  paidXaf: 0,
  balanceXaf: 0,
  status: 'MISMATCH',
  mismatchDetails: [],
  approvalRequestId: null,
  approvedBy: null,
  approvedAt: null,
  approvalReason: null,
  disputeReason: null,
  cancelReason: null,
  occurredAt: '2026-10-10T10:00:00.000Z',
  createdBy: OTHER,
  ...overrides,
});

const matching: OrderMatchingItem = {
  orderId: ORDER,
  docNumber: 'BC-2026-000003',
  siteId: 'site',
  supplierId: SUPPLIER,
  status: 'RECEIVED',
  lines: [
    {
      poLineId: LINE_B,
      lineNo: 2,
      productId: PRODUCT_B,
      unitCode: 'SAC',
      status: 'RECEIVED',
      orderedQtyBase: 10,
      acceptedQtyBase: 10,
      invoicedQtyBase: 10,
      remainingQtyBase: 0,
      unitPriceXaf: 8_000,
    },
    {
      poLineId: LINE_A,
      lineNo: 1,
      productId: PRODUCT_A,
      unitCode: 'SAC',
      status: 'RECEIVED',
      orderedQtyBase: 100,
      acceptedQtyBase: 95,
      invoicedQtyBase: 0,
      remainingQtyBase: 0,
      unitPriceXaf: 15_000,
    },
  ],
};

const draftWith = (overrides: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  ...emptyInvoiceDraft('2026-10-10'),
  supplierId: SUPPLIER,
  purchaseOrderId: ORDER,
  supplierInvoiceRef: 'FA-0013',
  lines: linesFromMatching(matching, (line) => `Produit ${line.lineNo}`),
  ...overrides,
});

describe('factures fournisseurs (ECR-FIN-03, P8E-05)', () => {
  it('lectures : un chemin par statut du groupe, fournisseur facultatif ; tri par échéance', () => {
    expect(invoiceListPaths('TO_DECIDE', '')).toEqual([
      '/api/v1/supplier-invoices?status=MISMATCH&limit=200',
      '/api/v1/supplier-invoices?status=DISPUTED&limit=200',
    ]);
    expect(invoiceListPaths('PAID', SUPPLIER)).toEqual([
      `/api/v1/supplier-invoices?status=PAID&limit=200&supplier_id=${SUPPLIER}`,
    ]);
    expect(
      sortInvoices([
        invoice({ id: 'late', dueDate: '2026-12-01' }),
        invoice({ id: 'soon', dueDate: '2026-10-20' }),
        invoice({
          id: 'soon-newer',
          dueDate: '2026-10-20',
          occurredAt: '2026-10-11T10:00:00.000Z',
        }),
      ]).map((item) => item.id),
    ).toEqual(['soon-newer', 'soon', 'late']);
  });

  it('actions : contester un écart, approuver sauf sa propre facture, annuler sans paiement', () => {
    expect(invoiceActions(invoice(), USER, true)).toEqual({
      dispute: true,
      approve: true,
      cancel: true,
      ownInvoice: false,
    });
    expect(invoiceActions(invoice({ createdBy: USER }), USER, true)).toMatchObject({
      approve: false,
      ownInvoice: true,
    });
    expect(invoiceActions(invoice({ status: 'DISPUTED' }), USER, true)).toMatchObject({
      dispute: false,
      approve: true,
      cancel: true,
    });
    expect(invoiceActions(invoice({ status: 'APPROVED' }), USER, true)).toMatchObject({
      approve: false,
      cancel: true,
    });
    expect(invoiceActions(invoice({ status: 'APPROVED', paidXaf: 1 }), USER, true).cancel).toBe(
      false,
    );
    expect(invoiceActions(invoice({ status: 'PARTIALLY_PAID', paidXaf: 10 }), USER, true)).toEqual({
      dispute: false,
      approve: false,
      cancel: false,
      ownInvoice: false,
    });
    // Sans droit de décider (Resp. achats) : lecture seule.
    expect(invoiceActions(invoice(), USER, false)).toMatchObject({
      dispute: false,
      approve: false,
      cancel: false,
    });
  });

  it('lignes proposées du bon : accepté non facturé, prix du bon ; ligne entièrement facturée vide', () => {
    const lines = linesFromMatching(matching, (line) => `Produit ${line.lineNo}`);
    expect(lines.map((line) => [line.poLineId, line.quantityText, line.unitPriceText])).toEqual([
      [LINE_A, '95', '15000'],
      [LINE_B, '', '8000'],
    ]);
    const [a, b] = lines.map(parseInvoiceLine);
    expect(a).toMatchObject({
      quantity: 95,
      unitPriceXaf: 15_000,
      totalXaf: 1_425_000,
      empty: false,
    });
    // Ligne de BC sans quantité : non facturée.
    expect(b!.empty).toBe(true);
    // Montant de la facture papier saisi : il l'emporte sur le calcul.
    expect(parseInvoiceLine({ ...lines[0]!, totalText: '1425001' })).toMatchObject({
      computedXaf: 1_425_000,
      totalXaf: 1_425_001,
    });
  });

  it('doublon de référence : normalisée, même fournisseur, factures non annulées', () => {
    const list = [
      invoice({ supplierInvoiceRef: 'FA-0012' }),
      invoice({ supplierInvoiceRef: 'FA-0099', status: 'CANCELLED' }),
      invoice({ supplierInvoiceRef: 'FA-0050', supplierId: OTHER_SUPPLIER }),
    ];
    expect(duplicateInvoice('fa 0012', SUPPLIER, list)?.docNumber).toBe('FF-2026-000001');
    expect(duplicateInvoice('FA0099', SUPPLIER, list)).toBeUndefined();
    expect(duplicateInvoice('FA-0050', SUPPLIER, list)).toBeUndefined();
    expect(duplicateInvoice('--', SUPPLIER, list)).toBeUndefined();
  });

  it('contrôles de la saisie', () => {
    expect(invoiceIssues(draftWith(), [])).toEqual([]);
    expect(invoiceIssues(emptyInvoiceDraft('2026-10-10'), [])).toEqual([
      'SUPPLIER',
      'REF',
      'NO_LINE',
    ]);
    expect(invoiceIssues(draftWith({ supplierInvoiceRef: 'fa-0012' }), [invoice()])).toContain(
      'DUPLICATE',
    );
    expect(invoiceIssues(draftWith({ dueDate: '2026-10-01' }), [])).toEqual(['DUE_DATE']);
    expect(invoiceIssues(draftWith({ invoiceDate: '10/10/2026' }), [])).toContain('DATE');
    expect(invoiceIssues(draftWith({ printedTotalText: 'mille' }), [])).toEqual(['PRINTED_TOTAL']);
    const lines = draftWith().lines;
    expect(
      invoiceIssues(draftWith({ lines: [{ ...lines[0]!, unitPriceText: '' }, lines[1]!] }), []),
    ).toContain('LINE_PRICE');
    expect(
      invoiceIssues(draftWith({ lines: [{ ...lines[0]!, quantityText: '0' }, lines[1]!] }), []),
    ).toContain('LINE_QUANTITY');
    // Ligne libre (facture sans BC) : description et montant.
    expect(
      invoiceIssues(
        draftWith({
          purchaseOrderId: '',
          lines: [{ ...freeLine('l1'), totalText: '5000' }],
        }),
        [],
      ),
    ).toEqual(['LINE_DESCRIPTION']);
  });

  it('aperçu indicatif : conforme, écart de quantité et de prix, sans BC, total imprimé ; échéance', () => {
    const conforming = invoicePreview({ draft: draftWith(), matching, paymentTermsDays: 30 });
    expect(conforming).toMatchObject({
      errorCode: null,
      dueDate: '2026-11-09',
      match: { conforming: true, totalXaf: 1_425_000 },
    });
    const lines = draftWith().lines;
    const over = invoicePreview({
      draft: draftWith({
        lines: [{ ...lines[0]!, quantityText: '98', unitPriceText: '15500' }, lines[1]!],
        printedTotalText: '1000',
      }),
      matching,
      paymentTermsDays: null,
    });
    expect(over.dueDate).toBe('2026-10-10');
    expect(over.match?.conforming).toBe(false);
    expect(over.match?.details.map((detail) => detail.reason)).toEqual([
      'PRICE_MISMATCH',
      'QUANTITY_ABOVE_ACCEPTED',
      'TOTAL_MISMATCH',
    ]);
    // Sans bon de commande : examen (mode par défaut du registre, AV-271).
    const withoutOrder = invoicePreview({
      draft: draftWith({
        purchaseOrderId: '',
        lines: [{ ...freeLine('l1'), description: 'Transport', totalText: '20000' }],
      }),
      matching: null,
      paymentTermsDays: null,
    });
    expect(withoutOrder.match?.details.map((detail) => detail.reason)).toEqual([
      'NO_PURCHASE_ORDER',
    ]);
    // Bon choisi mais pas encore lu : pas d'aperçu.
    expect(
      invoicePreview({ draft: draftWith(), matching: null, paymentTermsDays: null }).match,
    ).toBeNull();
    // Échéance avant la date : refusée.
    expect(
      invoicePreview({
        draft: draftWith({ dueDate: '2026-10-01' }),
        matching,
        paymentTermsDays: null,
      }).dueDate,
    ).toBeNull();
  });

  it('charge utile conforme au contrat : lignes non vides, champs facultatifs omis', () => {
    const payload = invoiceRecordPayload(
      draftWith({ comment: '  Livraison du 9  ', printedTotalText: '1425000' }),
    );
    expect(payload).toEqual({
      supplierId: SUPPLIER,
      supplierInvoiceRef: 'FA-0013',
      invoiceDate: '2026-10-10',
      purchaseOrderId: ORDER,
      printedTotalXaf: 1_425_000,
      lines: [
        {
          poLineId: LINE_A,
          productId: PRODUCT_A,
          description: 'Produit 1',
          quantity: 95,
          unitPriceXaf: 15_000,
          lineTotalXaf: 1_425_000,
        },
      ],
      comment: 'Livraison du 9',
    });
    expect(supplierInvoiceRecordPayloadSchema.safeParse(payload).success).toBe(true);
    const free = invoiceRecordPayload(
      draftWith({
        purchaseOrderId: '',
        dueDate: '2026-11-30',
        lines: [{ ...freeLine('l1'), description: ' Transport ', totalText: '20000' }],
      }),
    );
    expect(free).toEqual({
      supplierId: SUPPLIER,
      supplierInvoiceRef: 'FA-0013',
      invoiceDate: '2026-10-10',
      dueDate: '2026-11-30',
      lines: [{ description: 'Transport', lineTotalXaf: 20_000 }],
    });
    expect(supplierInvoiceRecordPayloadSchema.safeParse(free).success).toBe(true);
  });

  it('revue de P8E-05 : unité de base proposée, montant trop grand sans exception', () => {
    // Quantités du rapprochement en unité de base : l'unité d'achat du bon (SAC) n'est jamais reprise.
    expect(linesFromMatching(matching, () => 'x').map((line) => line.unitCode)).toEqual([
      null,
      null,
    ]);
    expect(
      linesFromMatching(
        matching,
        () => 'x',
        (line) => (line.productId === PRODUCT_A ? 'KG' : null),
      ).map((line) => line.unitCode),
    ).toEqual(['KG', null]);
    // Quantité × prix au-delà d'un entier sûr : pas de montant calculé, pas d'exception au rendu.
    const huge = { ...freeLine('h'), description: 'Erreur de collage' };
    expect(
      parseInvoiceLine({ ...huge, quantityText: '1500', unitPriceText: '10000000000000' }),
    ).toMatchObject({ computedXaf: null, totalXaf: null, empty: false });
    expect(
      invoiceIssues(
        draftWith({
          purchaseOrderId: '',
          lines: [{ ...huge, quantityText: '1500', unitPriceText: '10000000000000' }],
        }),
        [],
      ),
    ).toEqual(['LINE_TOTAL']);
  });

  it('revue de P8E-05 : contrôles restants de la saisie', () => {
    const free = (index: number) => ({
      ...freeLine(`l${index}`),
      description: `Ligne ${index}`,
      totalText: '100',
    });
    expect(
      invoiceIssues(
        draftWith({ purchaseOrderId: '', lines: Array.from({ length: 101 }, (_, i) => free(i)) }),
        [],
      ),
    ).toEqual(['TOO_MANY_LINES']);
    // Ligne libre avec un prix seul : montant manquant.
    expect(
      invoiceIssues(
        draftWith({
          purchaseOrderId: '',
          lines: [{ ...freeLine('p'), description: 'Transport', unitPriceText: '5000' }],
        }),
        [],
      ),
    ).toEqual(['LINE_TOTAL']);
    expect(invoiceIssues(draftWith({ supplierInvoiceRef: '   ' }), [])).toEqual(['REF']);
    // Dates du calendrier seulement.
    expect(invoiceIssues(draftWith({ dueDate: '2026-13-40' }), [])).toEqual(['DUE_DATE']);
    expect(invoiceIssues(draftWith({ invoiceDate: '2026-02-30' }), [])).toContain('DATE');
    expect(
      invoicePreview({
        draft: draftWith({ dueDate: '2026-13-40' }),
        matching,
        paymentTermsDays: 30,
      }).dueDate,
    ).toBeNull();
    // Quantité décimale à la virgule.
    const lines = draftWith().lines;
    expect(
      invoiceRecordPayload(
        draftWith({ lines: [{ ...lines[0]!, quantityText: '12,5' }, lines[1]!] }),
      ).lines[0],
    ).toMatchObject({ quantity: 12.5, lineTotalXaf: 187_500 });
    expect(invoiceDecisionPayload('  Prix non convenu ')).toEqual({ reason: 'Prix non convenu' });
  });

  it('revue de P8E-05 : aperçu — rang du brouillon, ligne étrangère au bon refusée', () => {
    const [a, b] = draftWith().lines;
    // La ligne B, entièrement facturée, reste vide devant la ligne A en écart de prix.
    const preview = invoicePreview({
      draft: draftWith({ lines: [b!, { ...a!, unitPriceText: '15500' }] }),
      matching,
      paymentTermsDays: null,
    });
    // Le serveur ne reçoit que la ligne A (rang 0) ; l'aperçu la nomme « Ligne 2 » comme le formulaire.
    expect(preview.match?.details).toEqual([
      expect.objectContaining({ reason: 'PRICE_MISMATCH', lineIndex: 1, poLineId: LINE_A }),
    ]);
    expect(
      invoicePreview({
        draft: draftWith({ lines: [{ ...a!, poLineId: '01900000-0000-7000-8000-0000000000ff' }] }),
        matching,
        paymentTermsDays: null,
      }),
    ).toMatchObject({ match: null, errorCode: 'PO_LINE_MISMATCH' });
  });
});

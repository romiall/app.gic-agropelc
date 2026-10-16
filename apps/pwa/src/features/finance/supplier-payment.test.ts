import { describe, expect, it } from 'vitest';
import {
  SUPPLIER_PAYMENT_MAX_ALLOCATIONS,
  supplierPaymentAllocatePayloadSchema,
  supplierPaymentCancelPayloadSchema,
  supplierPaymentRecordPayloadSchema,
} from '@gic/contracts';
import type { PaymentMethodData } from '../sales/types.js';
import type { CashAccountItem, SupplierPaymentItem } from '../treasury/treasury.js';
import type { PayableInvoiceItem } from './supplier-invoice.js';
import {
  accountsForMethod,
  allocatePayload,
  allocationsOnInvoices,
  autoAllocation,
  EMPTY_PAYMENT_DRAFT,
  MAX_PAYMENT_ALLOCATIONS,
  netOfPlanned,
  payableInvoices,
  paymentCancelPayload,
  paymentActions,
  paymentIssues,
  paymentListPaths,
  paymentMethodsFor,
  paymentPreview,
  paymentRecordPayload,
  paymentSettings,
  paymentsOfGroup,
  pendingSummary,
  planPreviewForAllocation,
  plannedByInvoice,
  shownAllocations,
  type PaymentDraft,
} from './supplier-payment.js';

const USER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const SUPPLIER = '01900000-0000-7000-8000-0000000004a1';
const INVOICE_A = '01900000-0000-7000-8000-0000000004b1';
const INVOICE_B = '01900000-0000-7000-8000-0000000004b2';
const BANK = '01900000-0000-7000-8000-0000000004b3';
const CASH = '01900000-0000-7000-8000-0000000004b4';

const payment = (overrides: Partial<SupplierPaymentItem> = {}): SupplierPaymentItem => ({
  id: 'p1',
  docNumber: 'PF-2026-000001',
  supplierId: SUPPLIER,
  amountXaf: 120_000,
  paymentMethodCode: 'VIREMENT',
  fromAccountId: BANK,
  externalReference: 'VIR-1',
  status: 'RECORDED',
  unallocatedXaf: 0,
  disbursedAt: '2026-10-10T10:00:00.000Z',
  approvalRequestId: null,
  decidedBy: null,
  decidedAt: null,
  cancelReason: null,
  occurredAt: '2026-10-10T10:00:00.000Z',
  createdBy: USER,
  ...overrides,
});

const account = (overrides: Partial<CashAccountItem> = {}): CashAccountItem => ({
  id: BANK,
  code: 'BANQUE',
  name: 'Banque Atlantique',
  accountType: 'BANQUE',
  siteId: null,
  holderUserId: null,
  balanceXaf: 5_000_000,
  status: 'ACTIVE',
  ...overrides,
});

const method = (overrides: Partial<PaymentMethodData> = {}): PaymentMethodData =>
  ({
    id: 'm1',
    code: 'VIREMENT',
    label: 'Virement',
    requires_reference: true,
    default_account_type: 'BANQUE',
    is_active: true,
    version: 1,
    ...overrides,
  }) as PaymentMethodData;

const payable = (overrides: Partial<PayableInvoiceItem> = {}): PayableInvoiceItem => ({
  invoiceId: INVOICE_A,
  docNumber: 'FF-2026-000001',
  supplierInvoiceRef: 'FA-1',
  invoiceDate: '2026-09-01',
  dueDate: '2026-10-01',
  totalXaf: 300_000,
  paidXaf: 0,
  balanceXaf: 300_000,
  daysOverdue: 9,
  overdue: true,
  bucket: '0-30',
  ...overrides,
});

const invoices = [
  payable(),
  payable({
    invoiceId: INVOICE_B,
    docNumber: 'FF-2026-000002',
    dueDate: '2026-11-01',
    totalXaf: 500_000,
    paidXaf: 100_000,
    balanceXaf: 400_000,
    overdue: false,
    daysOverdue: 0,
  }),
];

const draft = (overrides: Partial<PaymentDraft> = {}): PaymentDraft => ({
  ...EMPTY_PAYMENT_DRAFT,
  supplierId: SUPPLIER,
  amountText: '400000',
  methodCode: 'VIREMENT',
  accountId: BANK,
  reference: 'VIR-77',
  allocations: { [INVOICE_A]: '300000', [INVOICE_B]: '100000' },
  ...overrides,
});

describe('paiements fournisseurs (ECR-FIN-04, P8E-06)', () => {
  it('lectures par groupe ; avances à affecter : décaissés avec un reste non affecté', () => {
    expect(paymentListPaths('CLOSED', SUPPLIER)).toEqual([
      `/api/v1/supplier-payments?status=REJECTED&limit=200&supplier_id=${SUPPLIER}`,
      `/api/v1/supplier-payments?status=CANCELLED&limit=200&supplier_id=${SUPPLIER}`,
    ]);
    expect(paymentListPaths('ADVANCES', '')).toEqual([
      '/api/v1/supplier-payments?status=RECORDED&limit=200',
    ]);
    const items = [
      payment({ id: 'a', unallocatedXaf: 0 }),
      payment({ id: 'b', unallocatedXaf: 20_000, occurredAt: '2026-10-11T10:00:00.000Z' }),
    ];
    expect(paymentsOfGroup('ADVANCES', items).map((item) => item.id)).toEqual(['b']);
    expect(paymentsOfGroup('RECORDED', items).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('actions : affecter une avance (Finance) ; annuler en attente (auteur) ou décaissé (Direction)', () => {
    const finance = { mayRecord: true, mayApprove: false };
    const direction = { mayRecord: false, mayApprove: true };
    expect(paymentActions(payment({ unallocatedXaf: 20_000 }), USER, finance)).toEqual({
      allocate: true,
      cancel: false,
    });
    expect(paymentActions(payment(), USER, finance).allocate).toBe(false);
    expect(paymentActions(payment({ status: 'PENDING_APPROVAL' }), USER, finance).cancel).toBe(
      true,
    );
    expect(
      paymentActions(payment({ status: 'PENDING_APPROVAL', createdBy: OTHER }), USER, finance)
        .cancel,
    ).toBe(false);
    expect(paymentActions(payment(), USER, direction)).toEqual({ allocate: false, cancel: true });
    expect(paymentActions(payment({ status: 'PENDING_APPROVAL' }), USER, direction).cancel).toBe(
      false,
    );
    expect(paymentActions(payment({ status: 'CANCELLED' }), USER, direction).cancel).toBe(false);
  });

  it('moyens actifs ; comptes compatibles avec le moyen, jamais la caisse personnelle d’un autre', () => {
    expect(
      paymentMethodsFor([
        method(),
        method({ code: 'ESPECES', label: 'Espèces', default_account_type: 'CAISSE_UTILISATEUR' }),
        method({ code: 'OLD', label: 'Ancien', is_active: false }),
      ]).map((entry) => entry.code),
    ).toEqual(['ESPECES', 'VIREMENT']);
    const accounts = [
      account(),
      account({ id: CASH, name: 'Caisse centrale', accountType: 'CAISSE_CENTRALE' }),
      account({
        id: 'perso',
        name: 'Caisse de Paul',
        accountType: 'CAISSE_UTILISATEUR',
        holderUserId: OTHER,
      }),
      account({ id: 'momo', name: 'Orange Money', accountType: 'MOBILE_MONEY' }),
      account({ id: 'off', name: 'Ancienne banque', status: 'INACTIVE' }),
    ];
    expect(accountsForMethod(method(), accounts, USER).map((entry) => entry.id)).toEqual([BANK]);
    expect(
      accountsForMethod(method({ default_account_type: 'CAISSE_UTILISATEUR' }), accounts, USER).map(
        (entry) => entry.id,
      ),
    ).toEqual([CASH]);
    expect(accountsForMethod(undefined, accounts, USER)).toEqual([]);
  });

  it('factures payables par échéance ; affectation proposée jusqu’au montant', () => {
    expect(
      payableInvoices([...invoices, payable({ invoiceId: 'soldee', balanceXaf: 0 })]).map(
        (i) => i.invoiceId,
      ),
    ).toEqual([INVOICE_A, INVOICE_B]);
    expect(autoAllocation(invoices, 350_000)).toEqual({
      [INVOICE_A]: '300000',
      [INVOICE_B]: '50000',
    });
    expect(autoAllocation(invoices, 1_000_000)).toEqual({
      [INVOICE_A]: '300000',
      [INVOICE_B]: '400000',
    });
  });

  it('aperçu : avance, dépassement, seuil de la Direction, caisse insuffisante', () => {
    expect(paymentPreview({ draft: draft(), invoices, account: account() })).toEqual({
      amountXaf: 400_000,
      unallocatedXaf: 0,
      planError: null,
      needsApproval: false,
      cashInsufficient: false,
    });
    expect(
      paymentPreview({
        draft: draft({ amountText: '450000' }),
        invoices,
        account: account(),
      }).unallocatedXaf,
    ).toBe(50_000);
    expect(
      paymentPreview({
        draft: draft({ allocations: { [INVOICE_A]: '300001' } }),
        invoices,
        account: account(),
      }).planError,
    ).toBe('ALLOCATION_EXCEEDS');
    expect(
      paymentPreview({
        draft: draft({ amountText: '100000' }),
        invoices,
        account: account(),
      }).planError,
    ).toBe('SUPPLIER_PAYMENT_EXCEEDS');
    // Avance refusée par le paramètre : distinguée du dépassement des affectations.
    expect(
      paymentPreview({
        draft: draft({ amountText: '450000' }),
        invoices,
        account: account(),
        advanceAllowed: false,
      }).planError,
    ).toBe('ADVANCE_NOT_ALLOWED');
    expect(
      paymentPreview({
        draft: draft({ amountText: '400000' }),
        invoices,
        account: account(),
        advanceAllowed: false,
      }).planError,
    ).toBeNull();
    // Seuil paramétré : strict.
    expect(
      paymentPreview({
        draft: draft({ amountText: '300001', allocations: {} }),
        invoices,
        account: account(),
        thresholdXaf: 300_000,
      }).needsApproval,
    ).toBe(true);
    // Au-delà du seuil (strict) : en attente de la Direction, aucune caisse jugée.
    const big = paymentPreview({
      draft: draft({ amountText: '500001', allocations: {} }),
      invoices,
      account: account({ accountType: 'CAISSE_CENTRALE', balanceXaf: 10 }),
    });
    expect(big).toMatchObject({ needsApproval: true, cashInsufficient: false });
    expect(
      paymentPreview({
        draft: draft({ amountText: '500000', allocations: {} }),
        invoices,
        account: account({ accountType: 'CAISSE_CENTRALE', balanceXaf: 10 }),
      }),
    ).toMatchObject({ needsApproval: false, cashInsufficient: true });
  });

  it('contrôles et charges utiles conformes au contrat', () => {
    expect(paymentIssues({ draft: draft(), method: method(), account: account() })).toEqual([]);
    expect(
      paymentIssues({ draft: EMPTY_PAYMENT_DRAFT, method: undefined, account: undefined }),
    ).toEqual(['SUPPLIER', 'AMOUNT', 'METHOD', 'ACCOUNT']);
    expect(
      paymentIssues({ draft: draft({ reference: ' ' }), method: method(), account: account() }),
    ).toEqual(['REFERENCE']);
    expect(
      paymentIssues({
        draft: draft({ allocations: { [INVOICE_A]: 'mille' } }),
        method: method(),
        account: account(),
      }),
    ).toEqual(['ALLOCATION_AMOUNT']);
    const payload = paymentRecordPayload(draft({ comment: ' Solde septembre ' }));
    expect(payload).toEqual({
      supplierId: SUPPLIER,
      amountXaf: 400_000,
      paymentMethodCode: 'VIREMENT',
      fromAccountId: BANK,
      externalReference: 'VIR-77',
      allocations: [
        { invoiceId: INVOICE_A, amountXaf: 300_000 },
        { invoiceId: INVOICE_B, amountXaf: 100_000 },
      ],
      comment: 'Solde septembre',
    });
    expect(supplierPaymentRecordPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      paymentRecordPayload(draft({ reference: '', allocations: { [INVOICE_A]: ' ' } })),
    ).not.toHaveProperty('externalReference');
    expect(allocatePayload({ [INVOICE_A]: '20000', [INVOICE_B]: '' })).toEqual({
      allocations: [{ invoiceId: INVOICE_A, amountXaf: 20_000 }],
    });
  });

  it('paramètres lus dans « me » s’ils sont servis, sinon les défauts ; paiements en attente', () => {
    const now = new Date('2026-10-10T10:00:00.000Z');
    expect(paymentSettings([], now)).toEqual({ thresholdXaf: 500_000, advanceAllowed: true });
    const setting = (key: string, value: unknown) => ({
      id: key,
      key,
      value,
      scope_type: 'GLOBAL',
      scope_id: null,
      valid_from: '2026-01-01T00:00:00.000Z',
    });
    expect(
      paymentSettings(
        [
          setting('finance.supplier_payment_approval_xaf', 250_000),
          setting('finance.supplier_advance_allowed', false),
        ],
        now,
      ),
    ).toEqual({ thresholdXaf: 250_000, advanceAllowed: false });
    // Valeurs illisibles : défauts.
    expect(
      paymentSettings(
        [
          setting('finance.supplier_payment_approval_xaf', 'beaucoup'),
          setting('finance.supplier_advance_allowed', 'non'),
        ],
        now,
      ),
    ).toEqual({ thresholdXaf: 500_000, advanceAllowed: true });
    // Seuil négatif ou non fini : défaut ; seuil nul : admis.
    for (const value of [-5, Number.POSITIVE_INFINITY]) {
      expect(
        paymentSettings([setting('finance.supplier_payment_approval_xaf', value)], now)
          .thresholdXaf,
      ).toBe(500_000);
    }
    expect(
      paymentSettings([setting('finance.supplier_payment_approval_xaf', 0)], now).thresholdXaf,
    ).toBe(0);
    expect(
      pendingSummary([
        payment({ status: 'PENDING_APPROVAL', amountXaf: 600_000 }),
        payment({ status: 'PENDING_APPROVAL', amountXaf: 700_000 }),
        payment({ status: 'RECORDED', amountXaf: 1 }),
      ]),
    ).toEqual({ count: 2, totalXaf: 1_300_000 });
  });

  it('affectation d’une avance : au moins une, montants positifs, règle partagée sur le disponible', () => {
    const base = { supplierId: SUPPLIER, availableXaf: 100_000, invoices };
    expect(planPreviewForAllocation({ ...base, allocations: {} })).toEqual({
      valid: false,
      error: null,
    });
    expect(planPreviewForAllocation({ ...base, allocations: { [INVOICE_A]: '0' } })).toEqual({
      valid: false,
      error: 'AMOUNT_INVALID',
    });
    expect(
      planPreviewForAllocation({
        ...base,
        allocations: { [INVOICE_A]: '60000', [INVOICE_B]: '50000' },
      }),
    ).toEqual({ valid: false, error: 'SUPPLIER_PAYMENT_EXCEEDS' });
    expect(planPreviewForAllocation({ ...base, allocations: { other: '10' } })).toEqual({
      valid: false,
      error: 'ALLOCATION_INVALID',
    });
    // Le reste demeure une avance.
    expect(planPreviewForAllocation({ ...base, allocations: { [INVOICE_A]: '60000' } })).toEqual({
      valid: true,
      error: null,
    });
  });

  it('revue de P8E-06 : actions isolées par droit et par statut', () => {
    const finance = { mayRecord: true, mayApprove: false };
    const direction = { mayRecord: false, mayApprove: true };
    // Avance d'un paiement décaissé : la Finance seule l'affecte.
    expect(paymentActions(payment({ unallocatedXaf: 20_000 }), USER, direction).allocate).toBe(
      false,
    );
    // Paiement en attente avec un reste : rien à affecter avant la décision.
    expect(
      paymentActions(payment({ status: 'PENDING_APPROVAL', unallocatedXaf: 30_000 }), USER, finance)
        .allocate,
    ).toBe(false);
    // Sa propre caisse personnelle reste proposée.
    expect(
      accountsForMethod(
        method({ default_account_type: 'CAISSE_UTILISATEUR' }),
        [account({ id: 'mine', accountType: 'CAISSE_UTILISATEUR', holderUserId: USER })],
        USER,
      ).map((entry) => entry.id),
    ).toEqual(['mine']);
  });

  it('revue de P8E-06 : caisse insuffisante (caisses seulement, borne stricte), seuils limites', () => {
    const preview = (
      amountText: string,
      overrides: Partial<CashAccountItem>,
      thresholdXaf?: number,
    ) =>
      paymentPreview({
        draft: draft({ amountText, allocations: {} }),
        invoices,
        account: account(overrides),
        ...(thresholdXaf !== undefined ? { thresholdXaf } : {}),
      });
    expect(preview('400000', { accountType: 'BANQUE', balanceXaf: 1_000 }).cashInsufficient).toBe(
      false,
    );
    expect(
      preview('300000', { accountType: 'CAISSE_CENTRALE', balanceXaf: 300_000 }).cashInsufficient,
    ).toBe(false);
    expect(
      preview('300001', { accountType: 'CAISSE_CENTRALE', balanceXaf: 300_000 }).cashInsufficient,
    ).toBe(true);
    // Seuil à 0 : tout paiement attend la Direction ; seuil négatif : idem (strict).
    expect(preview('1', {}, 0).needsApproval).toBe(true);
    expect(preview('1', {}, -1).needsApproval).toBe(true);
  });

  it('revue de P8E-06 : reste dû dépassé, montant nul, 50 affectations au plus, contrats', () => {
    expect(
      planPreviewForAllocation({
        supplierId: SUPPLIER,
        availableXaf: 1_000_000,
        allocations: { [INVOICE_B]: '400001' },
        invoices,
      }),
    ).toEqual({ valid: false, error: 'ALLOCATION_EXCEEDS' });
    expect(
      paymentPreview({
        draft: draft({ amountText: '1000000', allocations: { [INVOICE_B]: '400001' } }),
        invoices,
        account: account(),
      }).planError,
    ).toBe('ALLOCATION_EXCEEDS');
    expect(
      paymentIssues({ draft: draft({ amountText: '0' }), method: method(), account: account() }),
    ).toEqual(['AMOUNT']);
    expect(MAX_PAYMENT_ALLOCATIONS).toBe(SUPPLIER_PAYMENT_MAX_ALLOCATIONS);
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`i${index}`, '1']));
    expect(
      paymentIssues({
        draft: draft({ allocations: many(MAX_PAYMENT_ALLOCATIONS) }),
        method: method(),
        account: account(),
      }),
    ).toEqual([]);
    expect(
      paymentIssues({
        draft: draft({ allocations: many(MAX_PAYMENT_ALLOCATIONS + 1) }),
        method: method(),
        account: account(),
      }),
    ).toEqual(['TOO_MANY_ALLOCATIONS']);
    // « Répartir » ne propose jamais plus de 50 factures.
    const sixty = Array.from({ length: 60 }, (_, index) =>
      payable({ invoiceId: `f${index}`, docNumber: `FF-${index}`, balanceXaf: 10 }),
    );
    expect(Object.keys(autoAllocation(sixty, 1_000_000))).toHaveLength(MAX_PAYMENT_ALLOCATIONS);
    expect(
      supplierPaymentAllocatePayloadSchema.safeParse(allocatePayload({ [INVOICE_A]: '1000' }))
        .success,
    ).toBe(true);
    expect(paymentCancelPayload('  Erreur  ')).toEqual({ reason: 'Erreur' });
    expect(supplierPaymentCancelPayloadSchema.safeParse(paymentCancelPayload(' x ')).success).toBe(
      true,
    );
  });

  it('revue de P8E-06 : affectations limitées aux factures payables ; montants déjà prévus', () => {
    expect(
      allocationsOnInvoices({ [INVOICE_A]: '10', soldee: '20' }, [{ invoiceId: INVOICE_A }]),
    ).toEqual({ [INVOICE_A]: '10' });
    const planned = plannedByInvoice([
      {
        docNumber: 'PF-1',
        status: 'PENDING_APPROVAL',
        allocations: [
          {
            paymentId: 'p',
            invoiceId: INVOICE_A,
            amountXaf: 200_000,
            status: 'PLANNED',
            activatedAt: null,
            reversedAt: null,
          },
        ],
      },
      {
        docNumber: 'PF-2',
        status: 'PENDING_APPROVAL',
        allocations: [
          {
            paymentId: 'q',
            invoiceId: INVOICE_A,
            amountXaf: 50_000,
            status: 'PLANNED',
            activatedAt: null,
            reversedAt: null,
          },
          {
            paymentId: 'q',
            invoiceId: INVOICE_B,
            amountXaf: 1,
            status: 'REVERSED',
            activatedAt: null,
            reversedAt: null,
          },
        ],
      },
      // Décidé entre-temps : ne compte plus.
      {
        docNumber: 'PF-3',
        status: 'RECORDED',
        allocations: [
          {
            paymentId: 'r',
            invoiceId: INVOICE_B,
            amountXaf: 9,
            status: 'PLANNED',
            activatedAt: null,
            reversedAt: null,
          },
        ],
      },
    ]);
    expect(planned).toEqual({ [INVOICE_A]: { amountXaf: 250_000, docNumbers: ['PF-1', 'PF-2'] } });
    // « Répartir » sur le reste net : A n'a plus que 50 000 à recevoir.
    expect(autoAllocation(netOfPlanned(invoices, planned), 350_000)).toEqual({
      [INVOICE_A]: '50000',
      [INVOICE_B]: '300000',
    });
    expect(
      netOfPlanned([payable({ balanceXaf: 10 })], {
        [INVOICE_A]: { amountXaf: 99, docNumbers: [] },
      })[0]!.balanceXaf,
    ).toBe(0);
  });

  it('revue de P8E-06 : affectations montrées et texte de la liste vide selon le statut', () => {
    const line = (status: string, amountXaf: number) => ({
      paymentId: 'p',
      invoiceId: INVOICE_A,
      amountXaf,
      status,
      activatedAt: null,
      reversedAt: null,
    });
    // Complément regroupé : la ligne remplacée disparaît d'un paiement décaissé.
    expect(
      shownAllocations({
        status: 'RECORDED',
        allocations: [line('REVERSED', 100_000), line('ACTIVE', 150_000)],
      }).allocations.map((entry) => entry.amountXaf),
    ).toEqual([150_000]);
    expect(
      shownAllocations({ status: 'CANCELLED', allocations: [line('REVERSED', 100_000)] })
        .allocations,
    ).toHaveLength(1);
    expect(shownAllocations({ status: 'RECORDED', allocations: [] }).emptyKey).toBe(
      'no_allocation',
    );
    expect(shownAllocations({ status: 'PENDING_APPROVAL', allocations: [] }).emptyKey).toBe(
      'no_allocation_pending',
    );
    expect(shownAllocations({ status: 'REJECTED', allocations: [] }).emptyKey).toBe(
      'no_allocation_closed',
    );
  });
});

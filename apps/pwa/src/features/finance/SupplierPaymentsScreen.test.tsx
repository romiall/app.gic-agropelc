import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { supplierPaymentRecordPayloadSchema } from '@gic/contracts';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { reportSyncOutcome, resetConnectivityForTests } from '../../platform/connectivity.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { REPEATED_FAILURE_ATTEMPTS, submitCommand } from '../sales/submit.js';
import type { CashAccountItem, SupplierPaymentItem } from '../treasury/treasury.js';
import type { PayablesResponse, SupplierInvoiceItem } from './supplier-invoice.js';
import type { SupplierPaymentDetail } from './supplier-payment.js';
import { SupplierPaymentsScreen } from './SupplierPaymentsScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T12:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
    deviceId: '01900000-0000-7000-8000-0000000000d0',
  }),
}));

const request = vi.mocked(authorizedRequest);
const SUPPLIER = '01900000-0000-7000-8000-0000000005a1';
const OTHER_SUPPLIER = '01900000-0000-7000-8000-0000000005a2';
const INVOICE_A = '01900000-0000-7000-8000-0000000005b1';
const INVOICE_B = '01900000-0000-7000-8000-0000000005b2';
const MOMO = '01900000-0000-7000-8000-0000000005c1';
const CENTRAL = '01900000-0000-7000-8000-0000000005c2';
const POS_CASH = '01900000-0000-7000-8000-0000000005c3';
const PAUL_CASH = '01900000-0000-7000-8000-0000000005c4';
const PENDING_MINE = '01900000-0000-7000-8000-0000000005d1';
const PENDING_OTHER = '01900000-0000-7000-8000-0000000005d2';
const RECORDED = '01900000-0000-7000-8000-0000000005d3';
const ADVANCE = '01900000-0000-7000-8000-0000000005d4';
const OTHER_USER = '01900000-0000-7000-8000-000000000002';
const INACTIVE_SUPPLIER = '01900000-0000-7000-8000-0000000005a3';

/** Réponse refusée (droit), en panne, ou jamais reçue pour un chemin. */
const DENIED = { __status: 403 } as const;
const BROKEN = { __status: 500 } as const;
const NEVER = { __never: true } as const;

type Routes = Record<string, unknown>;

function payment(overrides: Partial<SupplierPaymentItem> = {}): SupplierPaymentItem {
  return {
    id: RECORDED,
    docNumber: 'PF-2026-000003',
    supplierId: SUPPLIER,
    amountXaf: 120_000,
    paymentMethodCode: 'MOBILE_MONEY_ORANGE',
    fromAccountId: MOMO,
    externalReference: 'OM-77',
    status: 'RECORDED',
    unallocatedXaf: 0,
    disbursedAt: '2026-10-09T10:00:00.000Z',
    approvalRequestId: null,
    decidedBy: null,
    decidedAt: null,
    cancelReason: null,
    occurredAt: '2026-10-09T10:00:00.000Z',
    createdBy: OTHER_USER,
    ...overrides,
  };
}

function account(overrides: Partial<CashAccountItem> = {}): CashAccountItem {
  return {
    id: MOMO,
    code: 'OM',
    name: 'Orange Money Finance',
    accountType: 'MOBILE_MONEY',
    siteId: null,
    holderUserId: null,
    balanceXaf: 5_000_000,
    status: 'ACTIVE',
    ...overrides,
  };
}

const payables: PayablesResponse = {
  as_of: '2026-10-10',
  total_balance_xaf: 700_000,
  total_advance_xaf: 0,
  suppliers: [
    {
      supplierId: SUPPLIER,
      balanceXaf: 700_000,
      overdueXaf: 300_000,
      advanceXaf: 0,
      netXaf: 700_000,
      buckets: { '0-30': 700_000, '31-60': 0, '61-90': 0, '>90': 0 },
      invoices: [
        {
          invoiceId: INVOICE_B,
          docNumber: 'FF-2026-000002',
          supplierInvoiceRef: 'FA-2',
          invoiceDate: '2026-10-01',
          dueDate: '2026-11-01',
          totalXaf: 500_000,
          paidXaf: 100_000,
          balanceXaf: 400_000,
          daysOverdue: 0,
          overdue: false,
          bucket: '0-30',
        },
        {
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
        },
      ],
    },
  ],
};

const detail: SupplierPaymentDetail = {
  ...payment(),
  allocations: [
    // Ligne remplacée par le regroupement d'un complément : masquée d'un paiement décaissé.
    {
      paymentId: RECORDED,
      invoiceId: INVOICE_A,
      amountXaf: 100_000,
      status: 'REVERSED',
      activatedAt: '2026-10-09T10:00:00.000Z',
      reversedAt: '2026-10-09T11:00:00.000Z',
    },
    {
      paymentId: RECORDED,
      invoiceId: INVOICE_A,
      amountXaf: 120_000,
      status: 'ACTIVE',
      activatedAt: '2026-10-09T10:00:00.000Z',
      reversedAt: null,
    },
  ],
};

const page = (items: readonly SupplierPaymentItem[]) => ({
  supplier_payments: items,
  next_cursor: null,
});

function invoiceItem(id: string, docNumber: string): SupplierInvoiceItem {
  return {
    id,
    docNumber,
    siteId: null,
    supplierId: SUPPLIER,
    supplierInvoiceRef: docNumber,
    invoiceDate: '2026-09-01',
    dueDate: '2026-10-01',
    purchaseOrderId: null,
    totalXaf: 300_000,
    printedTotalXaf: null,
    paidXaf: 120_000,
    balanceXaf: 180_000,
    status: 'PARTIALLY_PAID',
    mismatchDetails: [],
    approvalRequestId: null,
    approvedBy: null,
    approvedAt: null,
    approvalReason: null,
    disputeReason: null,
    cancelReason: null,
    occurredAt: '2026-09-01T10:00:00.000Z',
    createdBy: OTHER_USER,
  };
}

function baseRoutes(): Routes {
  return {
    '/api/v1/suppliers': {
      suppliers: [
        {
          id: SUPPLIER,
          code: 'PROVENDA',
          name: 'Provenderie du Centre',
          suppliedCategories: [],
          contactName: null,
          phone: null,
          email: null,
          taxId: null,
          paymentTermsDays: 30,
          status: 'ACTIVE',
        },
        {
          id: OTHER_SUPPLIER,
          code: 'VETO',
          name: 'Vétérinaires associés',
          suppliedCategories: [],
          contactName: null,
          phone: null,
          email: null,
          taxId: null,
          paymentTermsDays: null,
          status: 'ACTIVE',
        },
        {
          id: INACTIVE_SUPPLIER,
          code: 'ANCIEN',
          name: 'Ancien fournisseur',
          suppliedCategories: [],
          contactName: null,
          phone: null,
          email: null,
          taxId: null,
          paymentTermsDays: null,
          status: 'INACTIVE',
        },
      ],
    },
    '/api/v1/cash-accounts': {
      cash_accounts: [
        account(),
        account({
          id: CENTRAL,
          code: 'CC',
          name: 'Caisse centrale',
          accountType: 'CAISSE_CENTRALE',
        }),
        account({
          id: POS_CASH,
          code: 'PDV',
          name: 'Caisse du PDV',
          accountType: 'CAISSE_PDV',
          balanceXaf: 100_000,
        }),
        account({
          id: PAUL_CASH,
          code: 'PAUL',
          name: 'Caisse de Paul',
          accountType: 'CAISSE_UTILISATEUR',
          holderUserId: OTHER_USER,
        }),
      ],
    },
    '/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200': page([
      payment({
        id: PENDING_MINE,
        docNumber: 'PF-2026-000001',
        status: 'PENDING_APPROVAL',
        amountXaf: 600_000,
        // Reste non affecté d'un paiement en attente : rien à affecter avant la décision.
        unallocatedXaf: 600_000,
        disbursedAt: null,
        createdBy: IDS.user,
      }),
      payment({
        id: PENDING_OTHER,
        docNumber: 'PF-2026-000002',
        status: 'PENDING_APPROVAL',
        amountXaf: 700_000,
        disbursedAt: null,
      }),
    ]),
    '/api/v1/supplier-payments?status=RECORDED&limit=200': page([
      payment(),
      payment({
        id: ADVANCE,
        docNumber: 'PF-2026-000004',
        amountXaf: 200_000,
        unallocatedXaf: 50_000,
        occurredAt: '2026-10-08T10:00:00.000Z',
      }),
    ]),
    '/api/v1/supplier-payments?status=REJECTED&limit=200': page([
      payment({
        id: 'rej',
        docNumber: 'PF-2026-000005',
        status: 'REJECTED',
        decidedAt: '2026-10-09T15:00:00.000Z',
      }),
    ]),
    '/api/v1/supplier-payments?status=CANCELLED&limit=200': page([
      payment({
        id: 'can',
        docNumber: 'PF-2026-000006',
        status: 'CANCELLED',
        cancelReason: 'Double saisie',
      }),
    ]),
    [`/api/v1/supplier-payments/${RECORDED}`]: { supplier_payment: detail },
    [`/api/v1/supplier-payments/${PENDING_OTHER}`]: {
      supplier_payment: {
        ...payment({
          id: PENDING_OTHER,
          docNumber: 'PF-2026-000002',
          status: 'PENDING_APPROVAL',
          amountXaf: 700_000,
        }),
        allocations: [
          {
            paymentId: PENDING_OTHER,
            invoiceId: INVOICE_A,
            amountXaf: 200_000,
            status: 'PLANNED',
            activatedAt: null,
            reversedAt: null,
          },
        ],
      },
    },
    [`/api/v1/supplier-payments/${PENDING_MINE}`]: {
      supplier_payment: {
        ...payment({ id: PENDING_MINE, docNumber: 'PF-2026-000001', status: 'PENDING_APPROVAL' }),
        allocations: [],
      },
    },
    '/api/v1/supplier-payments/can': {
      supplier_payment: {
        ...payment({ id: 'can', docNumber: 'PF-2026-000006', status: 'CANCELLED' }),
        allocations: [],
      },
    },
    [`/api/v1/supplier-invoices?supplier_id=${SUPPLIER}&limit=200`]: {
      supplier_invoices: [invoiceItem(INVOICE_A, 'FF-2026-000001')],
      next_cursor: null,
    },
    [`/api/v1/payables?supplier_id=${SUPPLIER}`]: payables,
    [`/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200&supplier_id=${SUPPLIER}`]: page([
      payment({
        id: PENDING_OTHER,
        docNumber: 'PF-2026-000002',
        status: 'PENDING_APPROVAL',
        amountXaf: 700_000,
      }),
    ]),
    [`/api/v1/payables?supplier_id=${OTHER_SUPPLIER}`]: { ...payables, suppliers: [] },
    [`/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200&supplier_id=${OTHER_SUPPLIER}`]:
      page([]),
  };
}

function serve(routes: Routes) {
  request.mockImplementation((_db, path) => {
    const data = routes[path];
    if (data === NEVER) return new Promise(() => {}) as ReturnType<typeof authorizedRequest>;
    const status =
      data && typeof data === 'object' && '__status' in data
        ? (data as { __status: number }).__status
        : data
          ? null
          : 500;
    return Promise.resolve(
      status === null
        ? { ok: true, data }
        : { ok: false, reason: 'HTTP_ERROR', status, message: `route : ${path}` },
    ) as ReturnType<typeof authorizedRequest>;
  });
}

function readsOf(path: string): number {
  return request.mock.calls.filter(([, called]) => called === path).length;
}

async function rememberRoles(roles: readonly string[]) {
  await getDb().navigation.put({
    user_id: IDS.user,
    roles: [...roles],
    sections: [],
    saved_at: '2026-10-10T08:00:00.000Z',
  });
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <SupplierPaymentsScreen />
    </MemoryRouter>,
  );
}

async function outbox() {
  return getDb().outbox.orderBy('device_seq').toArray();
}

async function showGroup(user: ReturnType<typeof userEvent.setup>, group: string) {
  await user.selectOptions(await screen.findByLabelText('Paiements à afficher'), group);
}

describe('Paiements fournisseurs (ECR-FIN-04, P8E-06)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    request.mockReset();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    resetConnectivityForTests();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
  });

  it('Finance : paiements en attente, annulation du sien seulement ; avance affectée, relectures', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const mine = await screen.findByRole('listitem', { name: 'PF-2026-000001' });
    expect(within(mine).getByText('Provenderie du Centre')).toBeInTheDocument();
    // Moyen nommé une fois les référentiels de l'appareil lus.
    expect(
      await within(mine).findByText(
        /^Orange Money depuis Orange Money Finance · saisi le .* par vous · référence OM-77$/,
      ),
    ).toBeInTheDocument();
    expect(
      within(mine).getByText('En attente de la Direction (rien n’est décaissé)'),
    ).toBeInTheDocument();
    // En attente : ni avance annoncée, ni affectation avant la décision.
    expect(within(mine).queryByText(/avance non affectée/)).toBeNull();
    expect(within(mine).queryByRole('button', { name: /^Affecter/ })).toBeNull();
    expect(within(mine).getByRole('button', { name: 'Annuler PF-2026-000001' })).toBeEnabled();
    const other = screen.getByRole('listitem', { name: 'PF-2026-000002' });
    expect(within(other).queryByRole('button', { name: /^Annuler/ })).toBeNull();
    // La Finance ne décide pas : pas de lien vers la file.
    expect(screen.queryByRole('link', { name: /file des validations/ })).toBeNull();

    // Décaissés : la Finance n'annule pas (Direction) ; avances à affecter seules dans leur groupe.
    await showGroup(user, 'RECORDED');
    const recorded = await screen.findByRole('listitem', { name: 'PF-2026-000003' });
    expect(within(recorded).queryByRole('button', { name: /^Annuler/ })).toBeNull();
    // Saisi et décaissé le même jour : une seule date.
    expect(within(recorded).queryByText(/décaissé le/)).toBeNull();
    await showGroup(user, 'ADVANCES');
    const advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    expect(screen.queryByRole('listitem', { name: 'PF-2026-000003' })).toBeNull();
    expect(within(advance).getByText(/avance non affectée : 50\s000 F CFA/)).toBeInTheDocument();
    // Décaissé à la décision, après la saisie (AV-276).
    expect(within(advance).getByText(/· décaissé le /)).toBeInTheDocument();

    const listBefore = readsOf('/api/v1/supplier-payments?status=RECORDED&limit=200');
    const accountsBefore = readsOf('/api/v1/cash-accounts');
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    const spread = await within(advance).findByRole('button', { name: /^Répartir/ });
    await waitFor(() => expect(spread).toHaveFocus());
    const submit = within(advance).getByRole('button', { name: 'Affecter' });
    expect(submit).toBeDisabled();
    await user.click(spread);
    // Échéance la plus ancienne d'abord : la facture A reçoit les 50 000.
    expect(within(advance).getByLabelText(/^FF-2026-000001/)).toHaveValue('50000');
    expect(within(advance).getByLabelText(/^FF-2026-000002/)).toHaveValue('');
    await user.click(submit);
    const announced = await screen.findByText('Affectation en cours d’envoi…');
    await waitFor(() => expect(announced.closest('[tabindex="-1"]')).toHaveFocus());
    const [allocate] = await outbox();
    expect(allocate).toMatchObject({
      command_type: 'finance.supplier_payment.allocate',
      aggregate_type: 'SUPPLIER_PAYMENT',
      aggregate_id: ADVANCE,
      payload: { allocations: [{ invoiceId: INVOICE_A, amountXaf: 50_000 }] },
    });
    // Toute opération relit la liste et les comptes ; sa réponse aussi.
    await waitFor(() =>
      expect(readsOf('/api/v1/supplier-payments?status=RECORDED&limit=200')).toBeGreaterThan(
        listBefore,
      ),
    );
    expect(readsOf('/api/v1/cash-accounts')).toBeGreaterThan(accountsBefore);
    const afterSend = readsOf('/api/v1/supplier-payments?status=RECORDED&limit=200');
    await getDb().outbox.update(allocate!.command_id, {
      status: 'SYNCED',
      server_refs: { docNumber: 'PF-2026-000004' },
    });
    expect(await screen.findByText('Avance de PF-2026-000004 affectée.')).toBeInTheDocument();
    await waitFor(() =>
      expect(readsOf('/api/v1/supplier-payments?status=RECORDED&limit=200')).toBeGreaterThan(
        afterSend,
      ),
    );
  });

  it('affectation : reste dû ou disponible dépassés annoncés, envoi bloqué ; fermer rend le focus', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    await showGroup(user, 'ADVANCES');
    const advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    const a = await within(advance).findByLabelText(/^FF-2026-000001/);
    await user.type(a, '60000');
    expect(
      within(advance).getByText('Les affectations dépassent le montant disponible.'),
    ).toBeInTheDocument();
    expect(within(advance).getByRole('button', { name: 'Affecter' })).toBeDisabled();
    await user.clear(a);
    await user.type(within(advance).getByLabelText(/^FF-2026-000002/), '400001');
    expect(
      within(advance).getByText('Une affectation dépasse le reste dû de sa facture.'),
    ).toBeInTheDocument();
    await user.click(within(advance).getByRole('button', { name: 'Fermer' }));
    expect(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    ).toHaveFocus();
  });

  it('affectation : envoi bloqué pendant la relecture des factures à payer', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    await showGroup(user, 'ADVANCES');
    const advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    await user.click(await within(advance).findByRole('button', { name: /^Répartir/ }));
    const submit = within(advance).getByRole('button', { name: 'Affecter' });
    expect(submit).toBeEnabled();
    // Retour du réseau : la liste revient vite, les factures à payer jamais.
    serve({ ...baseRoutes(), [`/api/v1/payables?supplier_id=${SUPPLIER}`]: NEVER });
    const before = readsOf('/api/v1/supplier-payments?status=RECORDED&limit=200');
    act(() => reportSyncOutcome('OFFLINE'));
    act(() => reportSyncOutcome('SYNCED'));
    await waitFor(() =>
      expect(readsOf('/api/v1/supplier-payments?status=RECORDED&limit=200')).toBeGreaterThan(
        before,
      ),
    );
    await waitFor(() => expect(screen.queryByText(/^Actualisation en cours/)).toBeNull());
    expect(submit).toBeDisabled();
  });

  it('affectation : factures à payer en panne (relance), refusées (sans relance) ou absentes', async () => {
    await rememberRoles(['FINANCE']);
    serve({ ...baseRoutes(), [`/api/v1/payables?supplier_id=${SUPPLIER}`]: BROKEN });
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    await showGroup(user, 'ADVANCES');
    let advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    expect(await within(advance).findByText(/^Factures à payer indisponibles/)).toBeInTheDocument();
    const retry = within(advance).getByRole('button', { name: 'Relire les factures à payer' });
    await waitFor(() => expect(retry).toHaveFocus());
    serve(baseRoutes());
    await user.click(retry);
    expect(await within(advance).findByLabelText(/^FF-2026-000001/)).toBeInTheDocument();
    unmount();

    serve({ ...baseRoutes(), [`/api/v1/payables?supplier_id=${SUPPLIER}`]: DENIED });
    const second = renderScreen();
    await showGroup(user, 'ADVANCES');
    advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    expect(
      await within(advance).findByText('Lecture non accessible avec vos droits.'),
    ).toBeInTheDocument();
    expect(within(advance).queryByRole('button', { name: /^Relire/ })).toBeNull();
    second.unmount();

    // Aucune facture à payer : le focus va au seul bouton utile.
    serve({
      ...baseRoutes(),
      [`/api/v1/payables?supplier_id=${SUPPLIER}`]: { ...payables, suppliers: [] },
    });
    renderScreen();
    await showGroup(user, 'ADVANCES');
    advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    expect(
      await within(advance).findByText('Aucune facture à payer pour ce fournisseur.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(advance).getByRole('button', { name: 'Fermer' })).toHaveFocus(),
    );
  });

  it('Direction : lien vers la file ; motif remis à zéro d’une fiche à l’autre ; annule un décaissé', async () => {
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'PF-2026-000001' });
    expect(
      screen.getByRole('link', { name: 'Décider les paiements dans la file des validations' }),
    ).toHaveAttribute('href', '/validations?types=SUPPLIER_PAYMENT');
    // En attente : seul son auteur l'annule.
    expect(screen.queryByRole('button', { name: 'Annuler PF-2026-000001' })).toBeNull();
    // Direction : aucune saisie.
    expect(screen.queryByRole('region', { name: 'Nouveau paiement fournisseur' })).toBeNull();

    await showGroup(user, 'RECORDED');
    const recorded = await screen.findByRole('listitem', { name: 'PF-2026-000003' });
    const withAdvance = screen.getByRole('listitem', { name: 'PF-2026-000004' });
    expect(screen.queryByRole('link', { name: /file des validations/ })).toBeNull();
    // L'affectation d'une avance est réservée à la Finance.
    expect(within(withAdvance).queryByRole('button', { name: /^Affecter/ })).toBeNull();
    await user.click(within(recorded).getByRole('button', { name: 'Annuler PF-2026-000003' }));
    await user.type(within(recorded).getByLabelText('Motif de l’annulation'), 'Brouillon');
    // Autre fiche : le motif ne la suit pas.
    await user.click(within(withAdvance).getByRole('button', { name: 'Annuler PF-2026-000004' }));
    expect(within(withAdvance).getByLabelText('Motif de l’annulation')).toHaveValue('');
    expect(within(withAdvance).getByRole('button', { name: 'Annuler le paiement' })).toBeDisabled();
    await user.click(within(recorded).getByRole('button', { name: 'Annuler PF-2026-000003' }));
    const reason = within(recorded).getByLabelText('Motif de l’annulation');
    expect(reason).toHaveValue('');
    expect(reason).toHaveFocus();
    expect(within(recorded).getByText(/Le montant revient au compte/)).toBeInTheDocument();
    const submit = within(recorded).getByRole('button', { name: 'Annuler le paiement' });
    expect(submit).toBeDisabled();
    await user.type(reason, ' Virement rejeté par la banque ');
    await user.click(submit);
    expect(await screen.findByText('Annulation en cours d’envoi…')).toBeInTheDocument();
    const [cancel] = await outbox();
    expect(cancel).toMatchObject({
      command_type: 'finance.supplier_payment.cancel',
      aggregate_id: RECORDED,
      payload: { reason: 'Virement rejeté par la banque' },
    });
    // Annulation sans réponse : une seconde opération attend.
    expect(
      within(withAdvance).getByRole('button', { name: 'Annuler PF-2026-000004' }),
    ).toBeDisabled();
  });

  it('Resp. achats : lecture seule, comptes non lus ; affectations à la demande selon le statut', async () => {
    await rememberRoles(['RESP_ACHATS']);
    serve({
      ...baseRoutes(),
      '/api/v1/supplier-payments/rej': BROKEN,
      [`/api/v1/supplier-payments?status=REJECTED&limit=200&supplier_id=${OTHER_SUPPLIER}`]: page(
        [],
      ),
      [`/api/v1/supplier-payments?status=CANCELLED&limit=200&supplier_id=${OTHER_SUPPLIER}`]: page(
        [],
      ),
    });
    const user = userEvent.setup();
    renderScreen();
    const pending = await screen.findByRole('listitem', { name: 'PF-2026-000001' });
    await user.click(
      within(pending).getByRole('button', { name: 'Voir les affectations de PF-2026-000001' }),
    );
    expect(
      await within(pending).findByText(
        'Aucune facture prévue : le montant deviendra une avance si la Direction l’approuve.',
      ),
    ).toBeInTheDocument();
    await showGroup(user, 'RECORDED');
    const recorded = await screen.findByRole('listitem', { name: 'PF-2026-000003' });
    // Sans droit sur les comptes : jamais lus (pas de refus journalisé), nom abrégé.
    expect(readsOf('/api/v1/cash-accounts')).toBe(0);
    expect(within(recorded).getByText(/depuis …05c1/)).toBeInTheDocument();
    expect(screen.queryByText(/Comptes de trésorerie indisponibles/)).toBeNull();
    // Lecture seule.
    expect(within(recorded).queryByRole('button', { name: /^(Annuler|Affecter)/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Nouveau paiement fournisseur' })).toBeNull();
    await user.click(
      within(recorded).getByRole('button', { name: 'Voir les affectations de PF-2026-000003' }),
    );
    expect(
      await within(recorded).findByText(/^FF-2026-000001 : 120\s000 F CFA \(décaissé\)$/),
    ).toBeInTheDocument();
    // La ligne remplacée par le regroupement d'un complément n'est pas montrée.
    expect(within(recorded).queryByText(/100\s000 F CFA/)).toBeNull();

    await showGroup(user, 'CLOSED');
    const rejected = await screen.findByRole('listitem', { name: 'PF-2026-000005' });
    expect(within(rejected).getByText(/^Refusé par la Direction · décidé le /)).toBeInTheDocument();
    await user.click(
      within(rejected).getByRole('button', { name: 'Voir les affectations de PF-2026-000005' }),
    );
    expect(await within(rejected).findByText(/^Affectations indisponibles/)).toBeInTheDocument();
    expect(
      within(rejected).getByRole('button', { name: 'Relire les affectations de PF-2026-000005' }),
    ).toBeInTheDocument();
    const cancelled = screen.getByRole('listitem', { name: 'PF-2026-000006' });
    expect(
      within(cancelled).getByText('Motif de l’annulation : Double saisie'),
    ).toBeInTheDocument();
    await user.click(
      within(cancelled).getByRole('button', { name: 'Voir les affectations de PF-2026-000006' }),
    );
    expect(await within(cancelled).findByText('Aucune affectation.')).toBeInTheDocument();
    await user.click(
      within(cancelled).getByRole('button', { name: 'Masquer les affectations de PF-2026-000006' }),
    );
    expect(within(cancelled).queryByText('Aucune affectation.')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Filtrer par fournisseur'), OTHER_SUPPLIER);
    expect(await screen.findByText('Aucun paiement dans ce groupe.')).toBeInTheDocument();
  });

  it('saisie : montants déjà prévus déduits de la répartition, fournisseurs inactifs, charge utile conforme', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouveau paiement fournisseur' });
    const supplierSelect = within(form).getByLabelText('Fournisseur du paiement');
    // Un fournisseur désactivé à qui l'on doit encore reste payable, signalé, après les actifs.
    await waitFor(() =>
      expect(
        within(supplierSelect)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual([
        'Choisir le fournisseur',
        'Provenderie du Centre',
        'Vétérinaires associés',
        'Ancien fournisseur (inactif)',
      ]),
    );
    await user.selectOptions(supplierSelect, SUPPLIER);
    expect(
      await within(form).findByText(/^1 paiement de ce fournisseur attend la Direction \(700\s000/),
    ).toBeInTheDocument();
    const a = await within(form).findByLabelText(/^FF-2026-000001 \(réf\. FA-1\)/);
    expect(within(form).getByText('Échue depuis 9 jours.')).toBeInTheDocument();
    expect(
      within(form).getByText(
        /^Déjà prévu : 200\s000 F CFA par PF-2026-000002, en attente de la Direction\.$/,
      ),
    ).toBeInTheDocument();
    // Échéance la plus proche d'abord.
    const fields = within(form)
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('aria-label'));
    expect(fields).toEqual(['FF-2026-000001', 'FF-2026-000002']);
    await user.type(within(form).getByLabelText('Montant payé (F CFA)'), '350000');
    await user.selectOptions(
      within(form).getByLabelText('Moyen de paiement'),
      'MOBILE_MONEY_ORANGE',
    );
    // Un seul compte compatible : choisi.
    expect(within(form).getByLabelText('Payé depuis le compte')).toHaveValue(MOMO);
    expect(within(form).getByText('Ce moyen de paiement exige une référence.')).toBeInTheDocument();
    await user.type(
      within(form).getByLabelText('Référence du paiement (exigée par ce moyen)'),
      'OM-99',
    );
    await user.click(within(form).getByRole('button', { name: /^Répartir/ }));
    // A n'a plus que 100 000 à recevoir une fois les 200 000 prévus déduits.
    expect(a).toHaveValue('100000');
    expect(within(form).getByLabelText(/^FF-2026-000002 \(réf/)).toHaveValue('250000');
    // Changer de fournisseur efface la répartition.
    await user.selectOptions(supplierSelect, OTHER_SUPPLIER);
    expect(
      await within(form).findByText('Aucune facture à payer pour ce fournisseur.'),
    ).toBeInTheDocument();
    await user.selectOptions(supplierSelect, SUPPLIER);
    expect(await within(form).findByLabelText(/^FF-2026-000001 \(réf/)).toHaveValue('');
    await user.click(within(form).getByRole('button', { name: /^Répartir/ }));
    expect(within(form).queryByText(/Reste non affecté/)).toBeNull();
    const accountsBefore = readsOf('/api/v1/cash-accounts');
    await user.click(within(form).getByRole('button', { name: 'Enregistrer le paiement' }));
    expect(await screen.findByText('Paiement en cours d’envoi…')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Nouveau paiement fournisseur' })).toHaveFocus(),
    );
    // Sans réponse : pas de nouvelle saisie (un second décaissement serait possible).
    expect(screen.queryByRole('button', { name: 'Nouveau paiement' })).toBeNull();
    const [record] = await outbox();
    expect(record).toMatchObject({
      command_type: 'finance.supplier_payment.record',
      aggregate_type: 'SUPPLIER_PAYMENT',
      captured_offline: false,
      payload: {
        supplierId: SUPPLIER,
        amountXaf: 350_000,
        paymentMethodCode: 'MOBILE_MONEY_ORANGE',
        fromAccountId: MOMO,
        externalReference: 'OM-99',
        allocations: [
          { invoiceId: INVOICE_A, amountXaf: 100_000 },
          { invoiceId: INVOICE_B, amountXaf: 250_000 },
        ],
      },
    });
    expect(supplierPaymentRecordPayloadSchema.safeParse(record!.payload).success).toBe(true);
    await waitFor(() => expect(readsOf('/api/v1/cash-accounts')).toBeGreaterThan(accountsBefore));

    await getDb().outbox.update(record!.command_id, {
      status: 'SYNCED',
      server_refs: { status: 'RECORDED', docNumber: 'PF-2026-000009' },
    });
    expect(await screen.findByText('Paiement PF-2026-000009 enregistré.')).toBeInTheDocument();
    expect(screen.getByText(/^Paiement décaissé : le compte/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Corriger la saisie' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Nouveau paiement' }));
    const supplier = within(form).getByLabelText('Fournisseur du paiement');
    await waitFor(() => expect(supplier).toHaveFocus());
    expect(supplier).toHaveValue('');
  });

  it('saisie : statut « en attente de la Direction », refus du serveur puis correction de la saisie', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouveau paiement fournisseur' });
    const fill = async (amount: string) => {
      await user.selectOptions(within(form).getByLabelText('Fournisseur du paiement'), SUPPLIER);
      await within(form).findByLabelText(/^FF-2026-000001 \(réf/);
      await user.type(within(form).getByLabelText('Montant payé (F CFA)'), amount);
      await user.selectOptions(
        within(form).getByLabelText('Moyen de paiement'),
        'MOBILE_MONEY_ORANGE',
      );
      await user.type(
        within(form).getByLabelText('Référence du paiement (exigée par ce moyen)'),
        'OM-1',
      );
      await user.click(within(form).getByRole('button', { name: 'Enregistrer le paiement' }));
    };
    await fill('600000');
    await screen.findByText('Paiement en cours d’envoi…');
    let [record] = await outbox();
    await getDb().outbox.update(record!.command_id, {
      status: 'SYNCED',
      server_refs: { status: 'PENDING_APPROVAL', docNumber: 'PF-2026-000010' },
    });
    expect(
      await screen.findByText(/^Paiement en attente de la Direction : rien n’est décaissé/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Paiement décaissé/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Nouveau paiement' }));

    await fill('300000');
    await screen.findByText('Paiement en cours d’envoi…');
    [, record] = await outbox();
    await getDb().outbox.update(record!.command_id, {
      status: 'REJECTED',
      last_error: {
        code: 'CASH_SESSION_REQUIRED',
        message_fr: 'Aucune session de caisse ouverte sur ce point de vente.',
      },
    });
    expect(
      await screen.findByText(/^Paiement refusé : Aucune session de caisse ouverte/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Corriger la saisie' }));
    // La saisie est gardée : il suffit de la corriger.
    expect(within(form).getByLabelText('Montant payé (F CFA)')).toHaveValue('300000');
    await waitFor(() =>
      expect(within(form).getByLabelText('Fournisseur du paiement')).toHaveFocus(),
    );
  });

  it('saisie : avance, seuil indicatif, plusieurs comptes, caisse du PDV insuffisante (avertissement), reste dû dépassé', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouveau paiement fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur du paiement'), SUPPLIER);
    const a = await within(form).findByLabelText(/^FF-2026-000001 \(réf/);
    const amount = within(form).getByLabelText('Montant payé (F CFA)');
    await user.type(amount, '450000');
    await user.type(a, '300000');
    expect(
      within(form).getByText(/^Reste non affecté : 150\s000 F CFA, enregistré comme avance/),
    ).toBeInTheDocument();
    await user.clear(amount);
    await user.type(amount, '600000');
    expect(
      within(form).getByText(/^Au-delà de 500\s000 F CFA \(seuil indicatif\)/),
    ).toBeInTheDocument();
    // Espèces : caisses seulement, jamais celle d'un autre ; plusieurs : aucune présélection.
    await user.selectOptions(within(form).getByLabelText('Moyen de paiement'), 'ESPECES');
    const accountSelect = within(form).getByLabelText('Payé depuis le compte');
    expect(
      within(accountSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Choisir le compte',
      expect.stringMatching(/^Caisse centrale/),
      expect.stringMatching(/^Caisse du PDV/),
    ]);
    expect(accountSelect).toHaveValue('');
    expect(within(form).getByText('Choisissez le compte d’où payer.')).toBeInTheDocument();
    await user.selectOptions(accountSelect, POS_CASH);
    expect(
      within(form).getByText(
        'Caisse de point de vente : une session de caisse ouverte est exigée.',
      ),
    ).toBeInTheDocument();
    // Sous le seuil, une caisse insuffisante est signalée sans bloquer : le serveur tranche.
    await user.clear(amount);
    await user.type(amount, '300000');
    expect(
      within(form).getByText(/^Solde de la caisse insuffisant : décaissé tout de suite/),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Enregistrer le paiement' })).toBeEnabled();
    await user.clear(a);
    await user.type(a, '300001');
    expect(
      within(form).getByText('Une affectation dépasse le reste dû de sa facture.'),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Enregistrer le paiement' })).toBeDisabled();
  });

  it('saisie : une facture sortie des dettes relues n’est plus affectée ni envoyée', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouveau paiement fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur du paiement'), SUPPLIER);
    const a = await within(form).findByLabelText(/^FF-2026-000001 \(réf/);
    await user.type(within(form).getByLabelText('Montant payé (F CFA)'), '100000');
    await user.selectOptions(
      within(form).getByLabelText('Moyen de paiement'),
      'MOBILE_MONEY_ORANGE',
    );
    await user.type(
      within(form).getByLabelText('Référence du paiement (exigée par ce moyen)'),
      'OM-4',
    );
    await user.type(a, '50000');
    await user.type(within(form).getByLabelText(/^FF-2026-000002 \(réf/), '50000');
    // La facture B est soldée entre-temps : elle quitte les dettes relues au retour du réseau.
    serve({
      ...baseRoutes(),
      [`/api/v1/payables?supplier_id=${SUPPLIER}`]: {
        ...payables,
        suppliers: [
          {
            ...payables.suppliers[0]!,
            invoices: payables.suppliers[0]!.invoices.filter(
              (invoice) => invoice.invoiceId === INVOICE_A,
            ),
          },
        ],
      },
    });
    act(() => reportSyncOutcome('OFFLINE'));
    act(() => reportSyncOutcome('SYNCED'));
    await waitFor(() => expect(within(form).queryByLabelText(/^FF-2026-000002 \(réf/)).toBeNull());
    expect(within(form).queryByText(/^Affectation impossible/)).toBeNull();
    const send = within(form).getByRole('button', { name: 'Enregistrer le paiement' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await screen.findByText('Paiement en cours d’envoi…');
    const [record] = await outbox();
    expect(record!.payload).toMatchObject({
      allocations: [{ invoiceId: INVOICE_A, amountXaf: 50_000 }],
    });
  });

  it('saisie : envoi bloqué pendant la lecture des factures ; un double clic n’enregistre qu’un paiement', async () => {
    await rememberRoles(['FINANCE']);
    serve({ ...baseRoutes(), [`/api/v1/payables?supplier_id=${SUPPLIER}`]: NEVER });
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    let form = await screen.findByRole('region', { name: 'Nouveau paiement fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur du paiement'), SUPPLIER);
    await user.type(within(form).getByLabelText('Montant payé (F CFA)'), '1000');
    await user.selectOptions(
      within(form).getByLabelText('Moyen de paiement'),
      'MOBILE_MONEY_ORANGE',
    );
    await user.type(
      within(form).getByLabelText('Référence du paiement (exigée par ce moyen)'),
      'OM-2',
    );
    expect(
      await within(form).findByText('Lecture des factures à payer du fournisseur en cours…'),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Enregistrer le paiement' })).toBeDisabled();
    unmount();

    serve(baseRoutes());
    renderScreen();
    form = await screen.findByRole('region', { name: 'Nouveau paiement fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur du paiement'), SUPPLIER);
    await within(form).findByLabelText(/^FF-2026-000001 \(réf/);
    await user.type(within(form).getByLabelText('Montant payé (F CFA)'), '1000');
    await user.selectOptions(
      within(form).getByLabelText('Moyen de paiement'),
      'MOBILE_MONEY_ORANGE',
    );
    await user.type(
      within(form).getByLabelText('Référence du paiement (exigée par ce moyen)'),
      'OM-3',
    );
    await user.dblClick(within(form).getByRole('button', { name: 'Enregistrer le paiement' }));
    await screen.findByText('Paiement en cours d’envoi…');
    expect(
      (await outbox()).filter(
        (command) => command.command_type === 'finance.supplier_payment.record',
      ),
    ).toHaveLength(1);
  });

  it('pannes et refus : liste, comptes, factures et paiements en attente du fournisseur ; refus sans relance', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      '/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200': BROKEN,
      '/api/v1/cash-accounts': BROKEN,
      [`/api/v1/payables?supplier_id=${SUPPLIER}`]: BROKEN,
      [`/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200&supplier_id=${SUPPLIER}`]:
        BROKEN,
    });
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    expect(
      await screen.findByText('Paiements indisponibles : le serveur n’a pas répondu.'),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Comptes de trésorerie indisponibles/)).toBeInTheDocument();
    const form = screen.getByRole('region', { name: 'Nouveau paiement fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur du paiement'), SUPPLIER);
    expect(await within(form).findByText(/Factures à payer indisponibles/)).toBeInTheDocument();
    expect(
      await within(form).findByText(/^Paiements en attente de ce fournisseur indisponibles/),
    ).toBeInTheDocument();
    // Comptes illisibles : pas de « aucun compte » trompeur.
    await user.selectOptions(within(form).getByLabelText('Moyen de paiement'), 'ESPECES');
    expect(within(form).queryByText('Aucun compte actif pour ce moyen de paiement.')).toBeNull();
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Relire les paiements' }));
    expect(await screen.findByRole('listitem', { name: 'PF-2026-000001' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Relire les comptes' }));
    await user.click(within(form).getByRole('button', { name: 'Relire les factures à payer' }));
    await user.click(within(form).getByRole('button', { name: 'Relire les paiements en attente' }));
    expect(await within(form).findByLabelText(/^FF-2026-000001 \(réf/)).toBeInTheDocument();
    expect(
      await within(form).findByText(/^1 paiement de ce fournisseur attend la Direction/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/Comptes de trésorerie indisponibles/)).toBeNull(),
    );
    unmount();

    serve({
      ...baseRoutes(),
      '/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200': DENIED,
    });
    renderScreen();
    expect(
      await screen.findByText('Paiements fournisseurs non accessibles avec vos droits.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Relire les paiements' })).toBeNull();
  });

  it('liste périmée (relecture en échec) : message et actions bloquées jusqu’à une relecture', async () => {
    await rememberRoles(['FINANCE']);
    renderScreen();
    const mine = await screen.findByRole('listitem', { name: 'PF-2026-000001' });
    expect(within(mine).getByRole('button', { name: 'Annuler PF-2026-000001' })).toBeEnabled();
    serve({
      ...baseRoutes(),
      '/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200': BROKEN,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(
      await screen.findByText(/^Actualisation impossible : le serveur n’a pas répondu/),
    ).toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: 'Annuler PF-2026-000001' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Relire les paiements' })).toBeInTheDocument();
  });

  it('affectation d’une avance : les montants déjà prévus par la Direction sont annoncés et déduits de « Répartir » (revue de P8E-10)', async () => {
    await rememberRoles(['FINANCE']);
    const base = baseRoutes();
    const planned = base[`/api/v1/supplier-payments/${PENDING_OTHER}`] as {
      supplier_payment: SupplierPaymentDetail;
    };
    serve({
      ...base,
      [`/api/v1/supplier-payments/${PENDING_OTHER}`]: {
        supplier_payment: {
          ...planned.supplier_payment,
          allocations: [{ ...planned.supplier_payment.allocations[0]!, amountXaf: 280_000 }],
        },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    await showGroup(user, 'ADVANCES');
    const advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    // La facture A (300 000) a déjà 280 000 prévus : 20 000 restent affectables, puis la facture B.
    expect(
      await within(advance).findByText(
        /^Déjà prévu : 280\s000 F CFA par PF-2026-000002, en attente de la Direction\.$/,
      ),
    ).toBeInTheDocument();
    await user.click(await within(advance).findByRole('button', { name: /^Répartir/ }));
    expect(within(advance).getByLabelText(/^FF-2026-000001/)).toHaveValue('20000');
    expect(within(advance).getByLabelText(/^FF-2026-000002/)).toHaveValue('30000');
  });

  it('affectation d’une avance : paiements en attente illisibles — annoncé, relançable (revue de P8E-10)', async () => {
    await rememberRoles(['FINANCE']);
    const pendingPath = `/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=200&supplier_id=${SUPPLIER}`;
    serve({ ...baseRoutes(), [pendingPath]: BROKEN });
    const user = userEvent.setup();
    renderScreen();
    await showGroup(user, 'ADVANCES');
    const advance = await screen.findByRole('listitem', { name: 'PF-2026-000004' });
    await user.click(
      within(advance).getByRole('button', { name: 'Affecter l’avance de PF-2026-000004' }),
    );
    expect(
      await within(advance).findByText(/^Paiements en attente de ce fournisseur indisponibles/),
    ).toBeInTheDocument();
    serve(baseRoutes());
    await user.click(
      within(advance).getByRole('button', { name: 'Relire les paiements en attente' }),
    );
    await waitFor(() =>
      expect(
        within(advance).queryByText(/^Paiements en attente de ce fournisseur indisponibles/),
      ).toBeNull(),
    );
  });

  it('opérations en attente au retour sur l’écran : annulation annoncée et bloquante, paiement repris ; hors ligne : brouillon gardé', async () => {
    await rememberRoles(['FINANCE']);
    await submitCommand({
      authorUserId: IDS.user,
      commandType: 'finance.supplier_payment.cancel',
      aggregateType: 'SUPPLIER_PAYMENT',
      aggregateId: PENDING_MINE,
      payload: { reason: 'Erreur' },
    });
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    expect(await screen.findByText('Annulation en cours d’envoi…')).toBeInTheDocument();
    const mine = await screen.findByRole('listitem', { name: 'PF-2026-000001' });
    expect(within(mine).getByRole('button', { name: 'Annuler PF-2026-000001' })).toBeDisabled();

    let form = screen.getByRole('region', { name: 'Nouveau paiement fournisseur' });
    await user.type(within(form).getByLabelText('Montant payé (F CFA)'), '1000');
    act(() => reportSyncOutcome('OFFLINE'));
    expect(await screen.findByText(/^Hors ligne : les paiements affichés/)).toBeInTheDocument();
    expect(
      within(form).getByText(/^Hors ligne : le paiement sera enregistrable/),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Montant payé (F CFA)')).toHaveValue('1000');
    expect(screen.getByRole('listitem', { name: 'PF-2026-000001' })).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Enregistrer le paiement' })).toBeDisabled();
    unmount();
    act(() => reportSyncOutcome('SYNCED'));

    // Paiement envoyé sans réponse : repris au retour, aucune nouvelle saisie possible.
    await submitCommand({
      authorUserId: IDS.user,
      commandType: 'finance.supplier_payment.record',
      aggregateType: 'SUPPLIER_PAYMENT',
      aggregateId: '01900000-0000-7000-8000-0000000005e1',
      payload: {},
    });
    renderScreen();
    form = await screen.findByRole('region', { name: 'Nouveau paiement fournisseur' });
    expect(await within(form).findByText('Paiement en cours d’envoi…')).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Enregistrer le paiement' })).toBeNull();
    expect(within(form).queryByRole('button', { name: 'Nouveau paiement' })).toBeNull();
  });

  it('opération retenue derrière une opération plus ancienne en échec répété : l’écran ne se bloque pas', async () => {
    await rememberRoles(['FINANCE']);
    const held = await submitCommand({
      authorUserId: IDS.user,
      commandType: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: '01900000-0000-7000-8000-0000000005ff',
      payload: {},
    });
    await getDb().outbox.update(held.command_id, { busy_retries: REPEATED_FAILURE_ATTEMPTS });
    await submitCommand({
      authorUserId: IDS.user,
      commandType: 'finance.supplier_payment.cancel',
      aggregateType: 'SUPPLIER_PAYMENT',
      aggregateId: PENDING_OTHER,
      payload: { reason: 'Erreur' },
    });
    renderScreen();
    const mine = await screen.findByRole('listitem', { name: 'PF-2026-000001' });
    expect(
      await screen.findByText(/^Cette opération attend une opération précédente/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(mine).getByRole('button', { name: 'Annuler PF-2026-000001' })).toBeEnabled(),
    );
  });

  it('ouvert hors ligne, rien de lu : « en ligne seulement » pour la liste des paiements (revue de P8E-10)', async () => {
    await rememberRoles(['FINANCE']);
    act(() => reportSyncOutcome('OFFLINE'));
    renderScreen();
    expect(
      await screen.findByText(
        'Lecture en ligne seulement : reconnectez-vous pour afficher les paiements.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Chargement des données de l’appareil…')).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PhotoModule from '../attachments/photo.js';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { supplierInvoiceRecordPayloadSchema } from '@gic/contracts';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { reportSyncOutcome, resetConnectivityForTests } from '../../platform/connectivity.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { REPEATED_FAILURE_ATTEMPTS, submitCommand } from '../sales/submit.js';
import type { OrderView } from '../procurement/orders.js';
import type {
  OrderMatchingItem,
  PayablesResponse,
  SupplierInvoiceDetail,
  SupplierInvoiceItem,
} from './supplier-invoice.js';
import { SupplierInvoicesScreen } from './SupplierInvoicesScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T12:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
vi.mock('../attachments/photo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PhotoModule>();
  return {
    ...actual,
    browserPhotoCodec: {
      decode: async () => ({ width: 1600, height: 1200, source: null }),
      encode: async () =>
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: 'image/jpeg' }),
    },
  };
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
const SUPPLIER = '01900000-0000-7000-8000-0000000004a1';
const OTHER_SUPPLIER = '01900000-0000-7000-8000-0000000004a2';
const ORDER = '01900000-0000-7000-8000-0000000004a3';
const PO_LINE = '01900000-0000-7000-8000-0000000004a4';
const INVOICE = '01900000-0000-7000-8000-0000000004a5';
const MINE = '01900000-0000-7000-8000-0000000004a6';
const PAID = '01900000-0000-7000-8000-0000000004a7';
const SCAN = '01900000-0000-7000-8000-0000000004a8';
const APPROVED = '01900000-0000-7000-8000-0000000004a9';
const PO_LINE_2 = '01900000-0000-7000-8000-0000000004aa';
const OTHER_USER = '01900000-0000-7000-8000-000000000002';

/** Réponse refusée (droit), en panne, ou jamais reçue pour un chemin. */
const DENIED = { __status: 403 } as const;
const BROKEN = { __status: 500 } as const;
const NEVER = { __never: true } as const;

type Routes = Record<string, unknown>;

type InvoiceWithPieces = SupplierInvoiceItem & {
  attachments: { id: string; kind: string; uploadStatus: string }[];
};

function invoice(overrides: Partial<InvoiceWithPieces> = {}): InvoiceWithPieces {
  return {
    id: INVOICE,
    docNumber: 'FF-2026-000007',
    siteId: null,
    supplierId: SUPPLIER,
    supplierInvoiceRef: 'FA-0012',
    invoiceDate: '2026-10-08',
    dueDate: '2026-11-07',
    purchaseOrderId: ORDER,
    totalXaf: 1_470_000,
    printedTotalXaf: null,
    paidXaf: 0,
    balanceXaf: 0,
    status: 'MISMATCH',
    mismatchDetails: [
      {
        reason: 'QUANTITY_ABOVE_ACCEPTED',
        lineIndex: null,
        poLineId: PO_LINE,
        expected: 95,
        actual: 98,
      },
      {
        reason: 'PRICE_MISMATCH',
        lineIndex: 0,
        poLineId: PO_LINE,
        expected: 15_000,
        actual: 15_500,
      },
    ],
    approvalRequestId: null,
    approvedBy: null,
    approvedAt: null,
    approvalReason: null,
    disputeReason: null,
    cancelReason: null,
    occurredAt: '2026-10-08T10:00:00.000Z',
    createdBy: OTHER_USER,
    attachments: [{ id: SCAN, kind: 'INVOICE', uploadStatus: 'AVAILABLE' }],
    ...overrides,
  };
}

const payables: PayablesResponse = {
  as_of: '2026-10-10',
  total_balance_xaf: 2_150_000,
  total_advance_xaf: 20_000,
  suppliers: [
    {
      supplierId: SUPPLIER,
      balanceXaf: 2_150_000,
      overdueXaf: 650_000,
      advanceXaf: 20_000,
      netXaf: 2_130_000,
      buckets: { '0-30': 1_500_000, '31-60': 650_000, '61-90': 0, '>90': 0 },
      invoices: [],
    },
  ],
};

const order: OrderView = {
  id: ORDER,
  docNumber: 'BC-2026-000003',
  siteId: IDS.site,
  supplierId: SUPPLIER,
  deliveryLocationId: IDS.pos,
  expectedDeliveryDate: null,
  status: 'RECEIVED',
  totalXaf: 1_500_000,
  sentAt: '2026-10-01T08:00:00.000Z',
  closedReason: null,
  occurredAt: '2026-10-01T08:00:00.000Z',
  lines: [],
};

const matching: OrderMatchingItem = {
  orderId: ORDER,
  docNumber: 'BC-2026-000003',
  siteId: IDS.site,
  supplierId: SUPPLIER,
  status: 'RECEIVED',
  lines: [
    {
      poLineId: PO_LINE,
      lineNo: 1,
      productId: IDS.chicken,
      unitCode: 'U',
      status: 'RECEIVED',
      orderedQtyBase: 100,
      acceptedQtyBase: 95,
      invoicedQtyBase: 0,
      remainingQtyBase: 0,
      unitPriceXaf: 15_000,
    },
  ],
};

const detail: SupplierInvoiceDetail = {
  ...invoice({
    id: PAID,
    docNumber: 'FF-2026-000005',
    status: 'PARTIALLY_PAID',
    paidXaf: 500_000,
    balanceXaf: 970_000,
  }),
  lines: [
    {
      lineNo: 1,
      poLineId: PO_LINE,
      receiptLineId: null,
      productId: IDS.chicken,
      description: 'Poulet de chair',
      quantityBase: 98,
      unitPriceXaf: 15_000,
      lineTotalXaf: 1_470_000,
    },
  ],
  allocations: [
    {
      paymentId: 'p1',
      invoiceId: PAID,
      amountXaf: 500_000,
      status: 'ACTIVE',
      activatedAt: '2026-10-09T10:00:00.000Z',
      reversedAt: null,
    },
  ],
};

const empty = { supplier_invoices: [], next_cursor: null };

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
      ],
    },
    '/api/v1/payables': payables,
    '/api/v1/supplier-invoices?status=MISMATCH&limit=200': {
      supplier_invoices: [
        invoice(),
        invoice({ id: MINE, docNumber: 'FF-2026-000008', createdBy: IDS.user }),
      ],
      next_cursor: null,
    },
    '/api/v1/supplier-invoices?status=DISPUTED&limit=200': empty,
    '/api/v1/supplier-invoices?status=APPROVED&limit=200': empty,
    '/api/v1/supplier-invoices?status=PARTIALLY_PAID&limit=200': {
      supplier_invoices: [detail],
      next_cursor: null,
    },
    [`/api/v1/supplier-invoices/${PAID}`]: { supplier_invoice: detail },
    [`/api/v1/purchase-orders?supplier_id=${SUPPLIER}&limit=200`]: {
      purchase_orders: [
        order,
        { ...order, id: 'draft', docNumber: 'BC-2026-000009', status: 'DRAFT' },
      ],
      next_cursor: null,
    },
    [`/api/v1/supplier-invoices?supplier_id=${SUPPLIER}&limit=200`]: {
      supplier_invoices: [invoice()],
      next_cursor: null,
    },
    [`/api/v1/purchase-orders/${ORDER}/matching`]: { matching },
    [`/api/v1/purchase-orders?supplier_id=${OTHER_SUPPLIER}&limit=200`]: {
      purchase_orders: [],
      next_cursor: null,
    },
    [`/api/v1/supplier-invoices?supplier_id=${OTHER_SUPPLIER}&limit=200`]: empty,
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

/** Nombre de lectures d'un chemin depuis le début du test. */
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
      <SupplierInvoicesScreen />
    </MemoryRouter>,
  );
}

async function outbox() {
  return getDb().outbox.orderBy('device_seq').toArray();
}

/** Aucun bouton « Joindre… » n'apparaît, même après la lecture locale des photos (asynchrone). */
async function expectNoAttach(card: HTMLElement) {
  await expect(
    within(card).findByRole('button', { name: /^Joindre/ }, { timeout: 300 }),
  ).rejects.toThrow();
}

async function chooseOrder(form: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(within(form).getByLabelText('Fournisseur de la facture'), SUPPLIER);
  const orderSelect = await within(form).findByLabelText('Bon de commande');
  await waitFor(() =>
    expect(
      within(orderSelect).getByRole('option', { name: 'BC-2026-000003 (Reçu)' }),
    ).toBeInTheDocument(),
  );
  await user.selectOptions(orderSelect, ORDER);
}

describe('Factures fournisseurs (ECR-FIN-03, P8E-05)', () => {
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
    await db.attachmentFiles.clear();
    await db.attachmentBlobs.clear();
  });

  it('dettes et factures à décider : écarts en clair, facture lisible, approbation motivée (jamais la sienne), relecture', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const debts = await screen.findByRole('region', { name: 'Dettes fournisseurs' });
    expect(await within(debts).findByText(/Dette totale : 2\s150\s000 F CFA/)).toBeInTheDocument();
    const supplierDebt = within(debts).getByRole('listitem', { name: 'Provenderie du Centre' });
    expect(within(supplierDebt).getByText(/échu 650\s000 F CFA/)).toBeInTheDocument();
    expect(
      within(supplierDebt).getByText(
        /^Par retard : non échu ou jusqu’à 30 j : 1\s500\s000 F CFA · 31 à 60 j : 650\s000 F CFA/,
      ),
    ).toBeInTheDocument();

    const list = screen.getByRole('region', { name: 'Factures' });
    const card = await within(list).findByRole('listitem', { name: 'FF-2026-000007' });
    expect(within(card).getByText('Provenderie du Centre')).toBeInTheDocument();
    expect(
      within(card).getByText(
        'Quantité facturée au-delà de l’accepté pour une ligne du bon : 98 facturés au total pour 95 acceptés.',
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(/^Ligne 1 : prix 15\s500 F CFA au lieu de 15\s000 F CFA\.$/),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Voir la facture FF-2026-000007' }),
    ).toBeInTheDocument();
    // La facture d'un autre : aucune photo à joindre.
    expect(within(card).queryByRole('button', { name: /^Joindre la photo/ })).toBeNull();
    // Écarts aussi décidés dans la file des validations (ADR-047 §5).
    expect(
      within(list).getByRole('link', { name: 'Décider les écarts dans la file des validations' }),
    ).toHaveAttribute('href', '/validations?types=INVOICE_MISMATCH');
    // Sa propre facture : ni approbation ni bouton, une explication.
    const mine = within(list).getByRole('listitem', { name: 'FF-2026-000008' });
    expect(within(mine).queryByRole('button', { name: /^Approuver/ })).toBeNull();
    expect(within(mine).getByText(/un autre approbateur décide/)).toBeInTheDocument();

    const payablesBefore = readsOf('/api/v1/payables');
    const listBefore = readsOf('/api/v1/supplier-invoices?status=MISMATCH&limit=200');
    await user.click(within(card).getByRole('button', { name: 'Approuver FF-2026-000007' }));
    const reason = within(card).getByLabelText('Motif de l’approbation de l’écart');
    expect(reason).toHaveFocus();
    await user.type(reason, '  Trois sacs livrés hors bon ');
    await user.click(within(card).getByRole('button', { name: 'Approuver la facture' }));
    const announced = await screen.findByText('Approbation en cours d’envoi…');
    // Le focus va au résultat, les actions de la liste se bloquent.
    await waitFor(() => expect(announced.closest('[tabindex="-1"]')).toHaveFocus());
    expect(within(card).getByRole('button', { name: 'Contester FF-2026-000007' })).toBeDisabled();
    const [approval] = await outbox();
    expect(approval).toMatchObject({
      command_type: 'finance.supplier_invoice.approve',
      aggregate_type: 'SUPPLIER_INVOICE',
      aggregate_id: INVOICE,
      captured_offline: false,
      payload: { reason: 'Trois sacs livrés hors bon' },
    });
    // Toute opération sur les factures relit la liste et les dettes.
    await waitFor(() => expect(readsOf('/api/v1/payables')).toBeGreaterThan(payablesBefore));
    expect(readsOf('/api/v1/supplier-invoices?status=MISMATCH&limit=200')).toBeGreaterThan(
      listBefore,
    );
  });

  it('contester : motif exigé ; facture payée en partie : lignes, paiements et produit de l’écart à la demande', async () => {
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'FF-2026-000007' });
    await user.click(within(card).getByRole('button', { name: 'Contester FF-2026-000007' }));
    const submit = within(card).getByRole('button', { name: 'Contester la facture' });
    expect(submit).toBeDisabled();
    await user.type(within(card).getByLabelText('Motif de la contestation'), 'Prix non convenu');
    await user.click(submit);
    await screen.findByText('Contestation en cours d’envoi…');
    const [dispute] = await outbox();
    expect(dispute).toMatchObject({
      command_type: 'finance.supplier_invoice.dispute',
      payload: { reason: 'Prix non convenu' },
    });
    // Direction : aucune saisie de facture (Finance seule).
    expect(screen.queryByRole('region', { name: 'Nouvelle facture fournisseur' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('Factures à afficher'), 'TO_PAY');
    const paid = await screen.findByRole('listitem', { name: 'FF-2026-000005' });
    // Hors du groupe « à décider » : pas de lien vers la file.
    expect(screen.queryByRole('link', { name: /file des validations/ })).toBeNull();
    expect(within(paid).getByText(/payé 500\s000 F CFA, reste 970\s000 F CFA/)).toBeInTheDocument();
    // Payée en partie : plus d'annulation possible (INVOICE_HAS_PAYMENTS).
    expect(within(paid).queryByRole('button', { name: /^Annuler/ })).toBeNull();
    await user.click(
      within(paid).getByRole('button', { name: 'Voir les lignes de FF-2026-000005' }),
    );
    expect(
      await within(paid).findByText(/^Poulet de chair : 98 × 15\s000 F CFA = 1\s470\s000 F CFA$/),
    ).toBeInTheDocument();
    expect(within(paid).getByText(/Paiement de 500\s000 F CFA \(décaissé\)/)).toBeInTheDocument();
    // Lignes lues : l'écart de cumul nomme le produit de la ligne du bon.
    expect(
      await within(paid).findByText(
        'Quantité facturée au-delà de l’accepté pour Poulet de chair : 98 facturés au total pour 95 acceptés.',
      ),
    ).toBeInTheDocument();
  });

  it('annuler (avoir) une facture approuvée sans paiement : motif, commande, attente bloquante', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      '/api/v1/supplier-invoices?status=APPROVED&limit=200': {
        supplier_invoices: [
          invoice({
            id: APPROVED,
            docNumber: 'FF-2026-000009',
            status: 'APPROVED',
            mismatchDetails: [],
            balanceXaf: 1_470_000,
            approvalReason: 'Écart accepté par la Direction',
          }),
        ],
        next_cursor: null,
      },
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('listitem', { name: 'FF-2026-000007' });
    await user.selectOptions(screen.getByLabelText('Factures à afficher'), 'TO_PAY');
    const card = await screen.findByRole('listitem', { name: 'FF-2026-000009' });
    expect(
      within(card).getByText('Motif de l’approbation : Écart accepté par la Direction'),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^(Approuver|Contester)/ })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Annuler FF-2026-000009' }));
    const submit = within(card).getByRole('button', { name: 'Annuler la facture' });
    expect(submit).toBeDisabled();
    await user.type(within(card).getByLabelText('Motif de l’annulation (avoir)'), 'Avoir reçu');
    await user.click(submit);
    expect(await screen.findByText('Annulation en cours d’envoi…')).toBeInTheDocument();
    const [cancel] = await outbox();
    expect(cancel).toMatchObject({
      command_type: 'finance.supplier_invoice.cancel',
      aggregate_id: APPROVED,
      payload: { reason: 'Avoir reçu' },
    });
    // Annulation sans réponse : une seconde décision attend.
    expect(within(card).getByRole('button', { name: 'Annuler FF-2026-000009' })).toBeDisabled();
  });

  it('motifs et photos : absente, en cours d’envoi, refusée, jamais reçue ; l’auteur joint la sienne', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      '/api/v1/supplier-invoices?status=MISMATCH&limit=200': {
        supplier_invoices: [
          invoice({ id: 'a', docNumber: 'FF-2026-000010', attachments: [] }),
          invoice({
            id: MINE,
            docNumber: 'FF-2026-000008',
            createdBy: IDS.user,
            attachments: [{ id: 's1', kind: 'INVOICE', uploadStatus: 'QUARANTINED' }],
          }),
          invoice({
            id: 'c',
            docNumber: 'FF-2026-000011',
            createdBy: IDS.user,
            attachments: [{ id: 's2', kind: 'INVOICE', uploadStatus: 'PENDING_UPLOAD' }],
          }),
          invoice({
            id: 'd',
            docNumber: 'FF-2026-000012',
            purchaseOrderId: null,
            mismatchDetails: [
              {
                reason: 'NO_PURCHASE_ORDER',
                lineIndex: null,
                poLineId: null,
                expected: null,
                actual: null,
              },
            ],
            attachments: [{ id: 's3', kind: 'INVOICE', uploadStatus: 'MISSING' }],
          }),
        ],
        next_cursor: null,
      },
      '/api/v1/supplier-invoices?status=DISPUTED&limit=200': {
        supplier_invoices: [
          invoice({
            id: 'e',
            docNumber: 'FF-2026-000013',
            status: 'DISPUTED',
            disputeReason: 'Prix non convenu',
          }),
        ],
        next_cursor: null,
      },
      '/api/v1/supplier-invoices?status=CANCELLED&limit=200': {
        supplier_invoices: [
          invoice({
            id: 'f',
            docNumber: 'FF-2026-000014',
            status: 'CANCELLED',
            createdBy: IDS.user,
            cancelReason: 'Facture en double',
            attachments: [],
          }),
        ],
        next_cursor: null,
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const none = await screen.findByRole('listitem', { name: 'FF-2026-000010' });
    expect(within(none).getByText('Aucune photo de la facture.')).toBeInTheDocument();
    // La facture d'un autre, sans photo : pas à lui de la joindre.
    await expectNoAttach(none);
    const uploading = screen.getByRole('listitem', { name: 'FF-2026-000011' });
    expect(
      within(uploading).getByText('Photo de la facture en cours d’envoi.'),
    ).toBeInTheDocument();
    // Sa facture dont la photo est en route : rien à joindre.
    await expectNoAttach(uploading);
    const missing = screen.getByRole('listitem', { name: 'FF-2026-000012' });
    expect(
      within(missing).getByText('Photo de la facture jamais reçue par le serveur.'),
    ).toBeInTheDocument();
    expect(within(missing).getByText(/^Saisie par .* · sans bon de commande$/)).toBeInTheDocument();
    expect(
      within(missing).getByText('Facture sans bon de commande : à examiner.'),
    ).toBeInTheDocument();
    const disputed = screen.getByRole('listitem', { name: 'FF-2026-000013' });
    expect(within(disputed).getByText('Contestée')).toBeInTheDocument();
    expect(
      within(disputed).getByText('Motif de la contestation : Prix non convenu'),
    ).toBeInTheDocument();

    // Sa facture, photo refusée : il en joint une nouvelle (AV-290), non citée.
    const mine = screen.getByRole('listitem', { name: 'FF-2026-000008' });
    expect(
      within(mine).getByText('Photo de la facture refusée par le serveur.'),
    ).toBeInTheDocument();
    await user.click(
      await within(mine).findByRole('button', {
        name: 'Joindre la photo de la facture FF-2026-000008',
      }),
    );
    await user.upload(
      within(mine).getByLabelText('Prendre une photo'),
      new File(['photo'], 'facture.jpg', { type: 'image/jpeg' }),
    );
    await within(mine).findByText(/Photo prête/);
    await user.click(within(mine).getByRole('button', { name: 'Envoyer la photo' }));
    await waitFor(async () =>
      expect(await outbox()).toEqual([
        expect.objectContaining({
          command_type: 'attachments.attachment.register',
          payload: expect.objectContaining({
            ownerType: 'SUPPLIER_INVOICE',
            ownerId: MINE,
            kind: 'INVOICE',
          }),
        }),
      ]),
    );

    // Facture annulée : motif, et plus de photo à joindre.
    await user.selectOptions(screen.getByLabelText('Factures à afficher'), 'CANCELLED');
    const cancelled = await screen.findByRole('listitem', { name: 'FF-2026-000014' });
    expect(
      within(cancelled).getByText('Motif de l’annulation : Facture en double'),
    ).toBeInTheDocument();
    await expectNoAttach(cancelled);
  });

  it('dettes : tri par dette, avance et net, tranches ; vides, en panne (relance) ou refusées', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      '/api/v1/payables': {
        ...payables,
        suppliers: [
          {
            supplierId: OTHER_SUPPLIER,
            balanceXaf: 80_000,
            overdueXaf: 0,
            advanceXaf: 100_000,
            netXaf: -20_000,
            buckets: { '0-30': 0, '31-60': 0, '61-90': 30_000, '>90': 50_000 },
            invoices: [],
          },
          ...payables.suppliers,
        ],
      },
    });
    const { unmount } = renderScreen();
    const debts = await screen.findByRole('region', { name: 'Dettes fournisseurs' });
    const rows = await within(debts).findAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Provenderie du Centre',
      'Vétérinaires associés',
    ]);
    expect(
      within(rows[1]!).getByText(/^échu 0 F CFA · avance 100\s000 F CFA · net \S?20\s000 F CFA$/),
    ).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText(/61 à 90 j : 30\s000 F CFA · plus de 90 j : 50\s000 F CFA$/),
    ).toBeInTheDocument();
    unmount();

    serve({ ...baseRoutes(), '/api/v1/payables': { ...payables, suppliers: [] } });
    const second = renderScreen();
    expect(await screen.findByText('Aucune dette fournisseur.')).toBeInTheDocument();
    second.unmount();

    serve({ ...baseRoutes(), '/api/v1/payables': BROKEN });
    const user = userEvent.setup();
    const third = renderScreen();
    expect(
      await screen.findByText(/Dettes indisponibles : le serveur n’a pas répondu\./),
    ).toBeInTheDocument();
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Relire les dettes' }));
    expect(await screen.findByText(/Dette totale : 2\s150\s000 F CFA/)).toBeInTheDocument();
    third.unmount();

    serve({ ...baseRoutes(), '/api/v1/payables': DENIED });
    renderScreen();
    const region = await screen.findByRole('region', { name: 'Dettes fournisseurs' });
    expect(
      await within(region).findByText(/Factures fournisseurs non accessibles avec vos droits\./),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Relire les dettes' })).toBeNull();
  });

  it('liste périmée (relecture en échec) ou décision en attente : actions bloquées ; liste refusée sans relance', async () => {
    await rememberRoles(['FINANCE']);
    const { unmount } = renderScreen();
    const card = await screen.findByRole('listitem', { name: 'FF-2026-000007' });
    expect(within(card).getByRole('button', { name: 'Approuver FF-2026-000007' })).toBeEnabled();
    // Relecture au retour sur l'onglet, en échec : la liste reste, périmée, et bloquée.
    serve({ ...baseRoutes(), '/api/v1/supplier-invoices?status=MISMATCH&limit=200': BROKEN });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(
      await screen.findByText(/Actualisation impossible : le serveur n’a pas répondu/),
    ).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Approuver FF-2026-000007' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Relire les factures' })).toBeInTheDocument();
    unmount();

    // Décision encore sans réponse au retour sur l'écran : annoncée, actions bloquées.
    serve(baseRoutes());
    await submitCommand({
      authorUserId: IDS.user,
      commandType: 'finance.supplier_invoice.approve',
      aggregateType: 'SUPPLIER_INVOICE',
      aggregateId: INVOICE,
      payload: { reason: 'Accord' },
    });
    const second = renderScreen();
    expect(await screen.findByText('Approbation en cours d’envoi…')).toBeInTheDocument();
    const again = await screen.findByRole('listitem', { name: 'FF-2026-000007' });
    expect(within(again).getByRole('button', { name: 'Contester FF-2026-000007' })).toBeDisabled();
    second.unmount();

    serve({ ...baseRoutes(), '/api/v1/supplier-invoices?status=MISMATCH&limit=200': DENIED });
    renderScreen();
    expect(
      await screen.findByText('Factures fournisseurs non accessibles avec vos droits.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Relire les factures' })).toBeNull();
  });

  it('Resp. achats : lecture seule ; filtre par fournisseur', async () => {
    await rememberRoles(['RESP_ACHATS']);
    serve({
      ...baseRoutes(),
      [`/api/v1/supplier-invoices?status=MISMATCH&limit=200&supplier_id=${OTHER_SUPPLIER}`]: empty,
      [`/api/v1/supplier-invoices?status=DISPUTED&limit=200&supplier_id=${OTHER_SUPPLIER}`]: empty,
    });
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'FF-2026-000007' });
    expect(
      within(card).queryByRole('button', { name: /^(Approuver|Contester|Annuler)/ }),
    ).toBeNull();
    expect(screen.queryByRole('link', { name: /file des validations/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Nouvelle facture fournisseur' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Filtrer par fournisseur'), OTHER_SUPPLIER);
    expect(await screen.findByText('Aucune facture dans ce groupe.')).toBeInTheDocument();
  });

  it('saisie rapprochée du bon : lignes proposées, aperçu conforme, photo citée, statut renvoyé, nouvelle facture relue', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouvelle facture fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur de la facture'), SUPPLIER);
    // Bons facturables seulement (pas un brouillon).
    const orderSelect = await within(form).findByLabelText('Bon de commande');
    await waitFor(() =>
      expect(
        within(orderSelect).getByRole('option', { name: 'BC-2026-000003 (Reçu)' }),
      ).toBeInTheDocument(),
    );
    expect(within(orderSelect).queryByRole('option', { name: /BC-2026-000009/ })).toBeNull();
    await user.selectOptions(orderSelect, ORDER);
    expect(await within(form).findByLabelText('Ligne 1 : désignation')).toHaveValue(
      'Poulet de chair',
    );
    expect(within(form).getByLabelText(/^Ligne 1 : quantité/)).toHaveValue('95');
    expect(within(form).getByLabelText(/^Ligne 1 : prix/)).toHaveValue('15000');
    await user.type(
      within(form).getByLabelText('Référence de la facture (fournisseur)'),
      'FA-0013',
    );
    expect(
      within(form).getByText(
        'Par défaut : 9 novembre 2026 (date de la facture + 30 jours, délai du fournisseur).',
      ),
    ).toBeInTheDocument();
    expect(
      await within(form).findByText(
        /Aperçu indicatif : rapprochement conforme \(1\s425\s000 F CFA\)/,
      ),
    ).toBeInTheDocument();
    await user.upload(
      within(form).getByLabelText('Prendre une photo'),
      new File(['photo'], 'facture.jpg', { type: 'image/jpeg' }),
    );
    expect(await within(form).findByText(/Photo prête/)).toBeInTheDocument();
    const payablesBefore = readsOf('/api/v1/payables');
    await user.click(within(form).getByRole('button', { name: 'Enregistrer la facture' }));
    expect(await screen.findByText('Facture en cours d’envoi…')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Nouvelle facture fournisseur' })).toHaveFocus(),
    );
    const [register, record] = await outbox();
    expect(record).toMatchObject({
      command_type: 'finance.supplier_invoice.record',
      aggregate_type: 'SUPPLIER_INVOICE',
      captured_offline: false,
      attachment_ids: [register!.aggregate_id],
      payload: {
        supplierId: SUPPLIER,
        supplierInvoiceRef: 'FA-0013',
        invoiceDate: '2026-10-10',
        purchaseOrderId: ORDER,
        lines: [
          {
            poLineId: PO_LINE,
            productId: IDS.chicken,
            description: 'Poulet de chair',
            quantity: 95,
            unitPriceXaf: 15_000,
            lineTotalXaf: 1_425_000,
          },
        ],
      },
    });
    expect(supplierInvoiceRecordPayloadSchema.safeParse(record!.payload).success).toBe(true);
    expect(register).toMatchObject({
      command_type: 'attachments.attachment.register',
      payload: { ownerType: 'SUPPLIER_INVOICE', ownerId: record!.aggregate_id, kind: 'INVOICE' },
    });
    // L'enregistrement relit les dettes et la liste.
    await waitFor(() => expect(readsOf('/api/v1/payables')).toBeGreaterThan(payablesBefore));

    // Réponse du serveur : écart à décider.
    serve({
      ...baseRoutes(),
      [`/api/v1/purchase-orders/${ORDER}/matching`]: {
        matching: {
          ...matching,
          lines: [{ ...matching.lines[0]!, invoicedQtyBase: 95 }],
        },
      },
    });
    await getDb().outbox.update(record!.command_id, {
      status: 'SYNCED',
      server_refs: { status: 'MISMATCH', docNumber: 'FF-2026-000015' },
    });
    expect(await screen.findByText('Facture FF-2026-000015 enregistrée.')).toBeInTheDocument();
    expect(
      screen.getByText(/Écart de rapprochement : la facture attend une décision/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Nouvelle facture' }));
    const supplierSelect = within(form).getByLabelText('Fournisseur de la facture');
    await waitFor(() => expect(supplierSelect).toHaveFocus());
    expect(supplierSelect).toHaveValue('');
    expect(within(form).queryByText(/Photo prête/)).toBeNull();
    // Même bon : le rapprochement relu propose le reliquat (tout est facturé).
    await chooseOrder(form, user);
    expect(await within(form).findByText('Ligne non facturée.')).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Ligne 1 : quantité/)).toHaveValue('');
  });

  it('unité de base du produit : jamais l’unité d’achat du bon', async () => {
    await rememberRoles(['FINANCE']);
    const db = getDb();
    const key = `product:PRODUCT:${IDS.chicken}`;
    const product = await db.projections.get(key);
    await db.projections.put({ ...product!, data: { ...product!.data, base_unit_code: 'KG' } });
    serve({
      ...baseRoutes(),
      [`/api/v1/purchase-orders/${ORDER}/matching`]: {
        matching: { ...matching, lines: [{ ...matching.lines[0]!, unitCode: 'SAC' }] },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouvelle facture fournisseur' });
    await chooseOrder(form, user);
    expect(await within(form).findByLabelText('Ligne 1 : quantité (kg)')).toHaveValue('95');
    expect(within(form).getByLabelText('Ligne 1 : prix par kg (F CFA)')).toHaveValue('15000');
    expect(within(form).queryByText(/sac/)).toBeNull();
  });

  it('saisie : écart annoncé au rang du formulaire, doublon bloquant, ligne hors bon, fournisseur sans délai', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [`/api/v1/purchase-orders/${ORDER}/matching`]: {
        matching: {
          ...matching,
          lines: [
            // Ligne 1 entièrement facturée : proposée vide, non envoyée.
            { ...matching.lines[0]!, invoicedQtyBase: 95 },
            {
              ...matching.lines[0]!,
              poLineId: PO_LINE_2,
              lineNo: 2,
              productId: IDS.eggs,
              acceptedQtyBase: 10,
              invoicedQtyBase: 0,
              unitPriceXaf: 1_000,
            },
          ],
        },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouvelle facture fournisseur' });
    await chooseOrder(form, user);
    const price = await within(form).findByLabelText(/^Ligne 2 : prix/);
    await user.clear(price);
    await user.type(price, '1100');
    expect(
      await within(form).findByText(/Aperçu indicatif : écart de rapprochement/),
    ).toBeInTheDocument();
    expect(
      within(form).getByText(/^Ligne 2 : prix 1\s100 F CFA au lieu de 1\s000 F CFA\.$/),
    ).toBeInTheDocument();
    // Cumul au-delà de l'accepté : produit nommé par le rapprochement.
    const quantity = within(form).getByLabelText(/^Ligne 2 : quantité/);
    await user.clear(quantity);
    await user.type(quantity, '12');
    expect(
      await within(form).findByText(
        'Quantité facturée au-delà de l’accepté pour Œufs de table : 12 facturés au total pour 10 acceptés.',
      ),
    ).toBeInTheDocument();
    // Référence déjà saisie pour ce fournisseur (normalisée) : envoi bloqué.
    await user.type(
      within(form).getByLabelText('Référence de la facture (fournisseur)'),
      'fa 0012',
    );
    expect(
      await within(form).findByText(
        'Référence déjà enregistrée pour ce fournisseur (FF-2026-000007).',
      ),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Enregistrer la facture' })).toBeDisabled();
    // Ligne hors bon : désignation et montant ; retirée, le focus revient à l'ajout.
    const add = within(form).getByRole('button', {
      name: 'Ajouter une ligne hors bon de commande',
    });
    await user.click(add);
    expect(within(form).getByLabelText('Ligne 3 : désignation')).toHaveValue('');
    await user.type(
      within(form).getByLabelText('Ligne 3 : montant de la facture (F CFA)'),
      '20000',
    );
    expect(within(form).getByText('Chaque ligne porte une désignation.')).toBeInTheDocument();
    expect(
      within(form).getByText(/Ligne 3 hors du bon de commande \(20\s000 F CFA\)/),
    ).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Retirer la ligne 3' }));
    expect(within(form).queryByLabelText('Ligne 3 : désignation')).toBeNull();
    await waitFor(() => expect(add).toHaveFocus());

    // Fournisseur sans délai de paiement : échéance = date de la facture.
    await user.selectOptions(
      within(form).getByLabelText('Fournisseur de la facture'),
      OTHER_SUPPLIER,
    );
    expect(
      await within(form).findByText(
        'Par défaut : 10 octobre 2026, la date de la facture (ce fournisseur n’a pas de délai de paiement).',
      ),
    ).toBeInTheDocument();
  });

  it('saisie : factures du fournisseur ou rapprochement illisibles, annoncés avec leur relance', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [`/api/v1/supplier-invoices?supplier_id=${SUPPLIER}&limit=200`]: BROKEN,
      [`/api/v1/purchase-orders/${ORDER}/matching`]: BROKEN,
    });
    const user = userEvent.setup();
    renderScreen();
    const form = await screen.findByRole('region', { name: 'Nouvelle facture fournisseur' });
    await chooseOrder(form, user);
    expect(
      await within(form).findByText(/Factures du fournisseur indisponibles/),
    ).toBeInTheDocument();
    expect(await within(form).findByText(/Rapprochement du bon indisponible/)).toBeInTheDocument();
    // Plus de « Chargement… » sans fin : aucune ligne, la relance est proposée.
    expect(within(form).getByText(/^Aucune ligne :/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Enregistrer la facture' })).toBeDisabled();
    serve(baseRoutes());
    await user.click(
      within(form).getByRole('button', { name: 'Relire les factures du fournisseur' }),
    );
    await user.click(within(form).getByRole('button', { name: 'Relire le rapprochement du bon' }));
    await waitFor(() =>
      expect(within(form).queryByText(/Factures du fournisseur indisponibles/)).toBeNull(),
    );
    expect(await within(form).findByLabelText('Ligne 1 : désignation')).toHaveValue(
      'Poulet de chair',
    );
  });

  it('saisie : lecture refusée sans relance ; lecture en cours annoncée, envoi en attente', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [`/api/v1/supplier-invoices?supplier_id=${SUPPLIER}&limit=200`]: DENIED,
    });
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    let form = await screen.findByRole('region', { name: 'Nouvelle facture fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur de la facture'), SUPPLIER);
    expect(
      await within(form).findByText('Lecture non accessible avec vos droits.'),
    ).toBeInTheDocument();
    expect(
      within(form).queryByRole('button', { name: 'Relire les factures du fournisseur' }),
    ).toBeNull();
    unmount();

    serve({
      ...baseRoutes(),
      [`/api/v1/purchase-orders?supplier_id=${SUPPLIER}&limit=200`]: NEVER,
    });
    renderScreen();
    form = await screen.findByRole('region', { name: 'Nouvelle facture fournisseur' });
    await user.selectOptions(within(form).getByLabelText('Fournisseur de la facture'), SUPPLIER);
    expect(
      await within(form).findByText('Lecture des bons et des factures du fournisseur en cours…'),
    ).toBeInTheDocument();
  });

  it('décision retenue derrière une opération plus ancienne en échec répété : l’écran ne se bloque pas', async () => {
    await rememberRoles(['FINANCE']);
    const held = await submitCommand({
      authorUserId: IDS.user,
      commandType: 'sales.sale.record',
      aggregateType: 'SALE',
      aggregateId: '01900000-0000-7000-8000-0000000004ff',
      payload: {},
    });
    await getDb().outbox.update(held.command_id, { busy_retries: REPEATED_FAILURE_ATTEMPTS });
    await submitCommand({
      authorUserId: IDS.user,
      commandType: 'finance.supplier_invoice.dispute',
      aggregateType: 'SUPPLIER_INVOICE',
      aggregateId: MINE,
      payload: { reason: 'Prix' },
    });
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'FF-2026-000007' });
    expect(
      await screen.findByText(/^Cette opération attend une opération précédente/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'Approuver FF-2026-000007' })).toBeEnabled(),
    );
  });

  it('hors ligne : la liste reste (périmée, bloquée) et le brouillon de la facture est gardé', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: 'FF-2026-000007' });
    const form = screen.getByRole('region', { name: 'Nouvelle facture fournisseur' });
    await chooseOrder(form, user);
    await within(form).findByLabelText('Ligne 1 : désignation');
    await user.type(
      within(form).getByLabelText('Référence de la facture (fournisseur)'),
      'FA-0099',
    );
    act(() => reportSyncOutcome('OFFLINE'));
    expect(await screen.findByText(/^Hors ligne : les factures et les dettes/)).toBeInTheDocument();
    expect(
      within(form).getByText(/^Hors ligne : la facture sera enregistrable/),
    ).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Approuver FF-2026-000007' })).toBeDisabled();
    expect(within(form).getByLabelText('Référence de la facture (fournisseur)')).toHaveValue(
      'FA-0099',
    );
    expect(within(form).getByRole('button', { name: 'Enregistrer la facture' })).toBeDisabled();
    act(() => reportSyncOutcome('SYNCED'));
    await waitFor(() =>
      expect(within(form).getByRole('button', { name: 'Enregistrer la facture' })).toBeEnabled(),
    );
    expect(within(form).getByLabelText('Ligne 1 : désignation')).toHaveValue('Poulet de chair');
  });
});

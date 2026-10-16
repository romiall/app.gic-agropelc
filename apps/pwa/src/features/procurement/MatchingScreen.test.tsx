import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { reportSyncOutcome, resetConnectivityForTests } from '../../platform/connectivity.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import type { SupplierInvoiceItem } from '../finance/supplier-invoice.js';
import type { MatchingDetail, MatchingOrder, MatchingOrderLine, ReceiptItem } from './matching.js';
import { MatchingScreen } from './MatchingScreen.js';

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
const SUPPLIER = '01900000-0000-7000-8000-0000000006a1';
const OTHER_SUPPLIER = '01900000-0000-7000-8000-0000000006a2';
const PO_LATE = '01900000-0000-7000-8000-0000000006b1';
const PO_ON_TIME = '01900000-0000-7000-8000-0000000006b2';
const PO_RECEIVED = '01900000-0000-7000-8000-0000000006b3';
const UNKNOWN_PRODUCT = '01900000-0000-7000-8000-0000000006c9';

const DENIED = { __status: 403 } as const;
const BROKEN = { __status: 500 } as const;

type Routes = Record<string, unknown>;

const line = (overrides: Partial<MatchingOrderLine> = {}): MatchingOrderLine => ({
  id: 'l1',
  lineNo: 1,
  productId: IDS.chicken,
  unitCode: 'SAC',
  orderedQtyBase: 100,
  deliveredQtyBase: 98,
  rejectedQtyBase: 3,
  quarantinedQtyBase: 0,
  acceptedQtyBase: 95,
  closedQtyBase: 0,
  excessQtyBase: 0,
  invoicedQtyBase: 98,
  remainingQtyBase: 5,
  unitPriceXaf: 15_000,
  lineTotalXaf: 1_500_000,
  status: 'OPEN',
  ...overrides,
});

const order = (overrides: Partial<MatchingOrder> = {}): MatchingOrder => ({
  id: PO_LATE,
  docNumber: 'BC-2026-000003',
  siteId: IDS.site,
  supplierId: SUPPLIER,
  expectedDeliveryDate: '2026-10-05',
  status: 'PARTIALLY_RECEIVED',
  totalXaf: 1_500_000,
  sentAt: '2026-10-01T08:00:00.000Z',
  closedReason: null,
  occurredAt: '2026-10-01T23:30:00.000Z',
  // Ligne annulée : jamais montrée ni comptée.
  lines: [line(), line({ id: 'lc', productId: IDS.eggs, status: 'CANCELLED', rejectedQtyBase: 9 })],
  ...overrides,
});

const detail: MatchingDetail = {
  orderId: PO_LATE,
  docNumber: 'BC-2026-000003',
  siteId: IDS.site,
  supplierId: SUPPLIER,
  status: 'PARTIALLY_RECEIVED',
  lines: [
    {
      poLineId: 'l1',
      lineNo: 1,
      productId: IDS.chicken,
      unitCode: 'SAC',
      status: 'OPEN',
      orderedQtyBase: 100,
      deliveredQtyBase: 98,
      rejectedQtyBase: 3,
      acceptedQtyBase: 95,
      quarantinedQtyBase: 0,
      closedQtyBase: 0,
      excessQtyBase: 0,
      remainingQtyBase: 5,
      invoicedQtyBase: 98,
      unitPriceXaf: 15_000,
      orderedValueXaf: 1_500_000,
      acceptedValueXaf: 1_425_000,
      invoicedValueXaf: 1_470_000,
    },
    {
      poLineId: 'lc',
      lineNo: 2,
      productId: IDS.eggs,
      unitCode: 'PLATEAU',
      status: 'CANCELLED',
      orderedQtyBase: 10,
      deliveredQtyBase: 0,
      rejectedQtyBase: 0,
      acceptedQtyBase: 0,
      quarantinedQtyBase: 0,
      closedQtyBase: 0,
      excessQtyBase: 0,
      remainingQtyBase: 0,
      invoicedQtyBase: 0,
      unitPriceXaf: 100,
      orderedValueXaf: 1_000,
      acceptedValueXaf: 0,
      invoicedValueXaf: 0,
    },
  ],
  totals: {
    orderedValueXaf: 1_500_000,
    acceptedValueXaf: 1_425_000,
    invoicedValueXaf: 1_470_000,
    paidXaf: 500_000,
  },
};

const receipt: ReceiptItem = {
  id: 'r1',
  docNumber: 'BR-2026-000004',
  status: 'POSTED',
  supplierDeliveryNoteRef: 'BL-778',
  occurredAt: '2026-10-06T09:00:00.000Z',
  cancelComment: null,
  lines: [
    {
      id: 'rl1',
      poLineId: 'l1',
      productId: IDS.chicken,
      qtyDeliveredBase: 98,
      qtyRejectedBase: 3,
      qtyAcceptedBase: 95,
    },
  ],
};

const invoice = {
  id: 'i1',
  docNumber: 'FF-2026-000007',
  supplierInvoiceRef: 'FA-0012',
  status: 'PARTIALLY_PAID',
  totalXaf: 1_470_000,
  paidXaf: 500_000,
} as SupplierInvoiceItem;

const page = (field: string, items: readonly unknown[]) => ({ [field]: items, next_cursor: null });

function baseRoutes(): Routes {
  return {
    '/api/v1/suppliers': {
      suppliers: [
        { id: SUPPLIER, code: 'PROV', name: 'Provenderie du Centre', status: 'ACTIVE' },
        { id: OTHER_SUPPLIER, code: 'VETO', name: 'Vétérinaires associés', status: 'ACTIVE' },
      ],
    },
    '/api/v1/purchase-orders?status=SENT&limit=200': page('purchase_orders', [
      order({
        id: PO_ON_TIME,
        docNumber: 'BC-2026-000004',
        status: 'SENT',
        expectedDeliveryDate: '2026-10-20',
        occurredAt: '2026-09-30T08:00:00.000Z',
        lines: [
          line({
            id: 'l2',
            productId: UNKNOWN_PRODUCT,
            orderedQtyBase: 30,
            deliveredQtyBase: 0,
            rejectedQtyBase: 0,
            acceptedQtyBase: 0,
            invoicedQtyBase: 0,
            remainingQtyBase: 30,
          }),
        ],
      }),
    ]),
    '/api/v1/purchase-orders?status=PARTIALLY_RECEIVED&limit=200': page('purchase_orders', [
      order(),
    ]),
    '/api/v1/purchase-orders?status=RECEIVED&limit=200': page('purchase_orders', [
      order({
        id: PO_RECEIVED,
        docNumber: 'BC-2026-000002',
        status: 'RECEIVED',
        lines: [
          line({
            id: 'l3',
            remainingQtyBase: 0,
            rejectedQtyBase: 0,
            quarantinedQtyBase: 4,
            excessQtyBase: 2,
            invoicedQtyBase: 0,
          }),
        ],
      }),
    ]),
    [`/api/v1/purchase-orders/${PO_LATE}/matching`]: { matching: detail },
    [`/api/v1/receipts?purchase_order_id=${PO_LATE}&limit=200`]: page('receipts', [
      receipt,
      {
        ...receipt,
        id: 'r2',
        docNumber: 'BR-2026-000005',
        status: 'CANCELLED',
        occurredAt: '2026-10-07T23:30:00.000Z',
        cancelComment: 'Bon de livraison erroné',
      },
    ]),
    // Bon reçu : quarantaine et excédent au détail ; ni réception ni facture lues.
    [`/api/v1/purchase-orders/${PO_RECEIVED}/matching`]: {
      matching: {
        ...detail,
        orderId: PO_RECEIVED,
        docNumber: 'BC-2026-000002',
        status: 'RECEIVED',
        lines: [
          {
            ...detail.lines[0]!,
            poLineId: 'l3',
            remainingQtyBase: 0,
            rejectedQtyBase: 0,
            quarantinedQtyBase: 4,
            excessQtyBase: 2,
            invoicedQtyBase: 0,
          },
        ],
      },
    },
    [`/api/v1/receipts?purchase_order_id=${PO_RECEIVED}&limit=200`]: page('receipts', []),
    [`/api/v1/supplier-invoices?purchase_order_id=${PO_RECEIVED}&limit=200`]: page(
      'supplier_invoices',
      [],
    ),
    [`/api/v1/supplier-invoices?purchase_order_id=${PO_LATE}&limit=200`]: page(
      'supplier_invoices',
      [invoice],
    ),
    [`/api/v1/purchase-orders?status=SENT&limit=200&supplier_id=${OTHER_SUPPLIER}`]: page(
      'purchase_orders',
      [],
    ),
    [`/api/v1/purchase-orders?status=PARTIALLY_RECEIVED&limit=200&supplier_id=${OTHER_SUPPLIER}`]:
      page('purchase_orders', []),
  };
}

function serve(routes: Routes) {
  request.mockImplementation((_db, path) => {
    const data = routes[path];
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
      <MatchingScreen />
    </MemoryRouter>,
  );
}

describe('Rapprochement des achats (ECR-APP-05, P8E-07)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    request.mockReset();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
    // Poulet compté au kilo : les quantités s'affichent dans l'unité de base, jamais en sacs.
    const key = `product:PRODUCT:${IDS.chicken}`;
    const product = await db.projections.get(key);
    await db.projections.put({ ...product!, data: { ...product!.data, base_unit_code: 'KG' } });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    resetConnectivityForTests();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.navigation.clear();
  });

  it('bons attendus : écarts par bon, date prévue dépassée, filtre des écarts et du fournisseur', async () => {
    await rememberRoles(['RESP_ACHATS']);
    const user = userEvent.setup();
    renderScreen();
    const late = await screen.findByRole('listitem', { name: 'BC-2026-000003' });
    expect(within(late).getByText(/^· Reçu en partie$/)).toBeInTheDocument();
    expect(within(late).getByText('Provenderie du Centre')).toBeInTheDocument();
    expect(
      within(late).getByText('Date de livraison prévue dépassée de 5 jours, reliquat attendu.'),
    ).toBeInTheDocument();
    expect(within(late).getByText('Reliquat sur 1 ligne.')).toBeInTheDocument();
    expect(within(late).getByText('Quantités rejetées à la réception.')).toBeInTheDocument();
    expect(within(late).getByText('Facturé au-delà de l’accepté.')).toBeInTheDocument();
    expect(within(late).queryByText(/quarantaine/)).toBeNull();
    expect(
      await within(late).findByText('Poulet de chair : commandé 100 kg, accepté 95 kg, reste 5 kg'),
    ).toBeInTheDocument();
    // Commandé à 23:30 UTC le 1er : le 2 octobre à Douala.
    expect(
      within(late).getByText(
        /^commandé le 2 octobre 2026 · livraison prévue le 5 octobre 2026 · total 1\s500\s000 F CFA$/,
      ),
    ).toBeInTheDocument();
    // Ligne annulée : ni résumé ni écart (son rejet ne compte pas).
    expect(within(late).queryByText(/^Œufs de table/)).toBeNull();
    // Le plus récent d'abord ; produit inconnu de l'appareil : nom abrégé, nombre sans unité.
    const onTime = screen.getByRole('listitem', { name: 'BC-2026-000004' });
    expect(
      screen
        .getAllByRole('listitem', { name: /^BC-2026/ })
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['BC-2026-000003', 'BC-2026-000004']);
    expect(
      within(onTime).getByText('…06c9 : commandé 30, accepté 0, reste 30'),
    ).toBeInTheDocument();
    expect(within(onTime).queryByText(/dépassée/)).toBeNull();
    // Aucun écart : pas de liste d'indicateurs vide, seulement le reliquat.
    expect(within(onTime).getByText('Reliquat sur 1 ligne.')).toBeInTheDocument();

    // Écarts seulement : le bon dans les temps, sans rejet, disparaît.
    await user.click(screen.getByLabelText('Seulement les bons avec un écart'));
    expect(screen.queryByRole('listitem', { name: 'BC-2026-000004' })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'BC-2026-000003' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Bons à afficher'), 'RECEIVED');
    const received = await screen.findByRole('listitem', { name: 'BC-2026-000002' });
    expect(within(received).getByText('Réception en quarantaine, à trancher.')).toBeInTheDocument();
    expect(within(received).getByText('Excédent reçu au-delà du commandé.')).toBeInTheDocument();
    // Reçu : plus rien n'est attendu, la date prévue ne compte plus.
    expect(within(received).queryByText(/dépassée/)).toBeNull();

    // Détail d'un bon reçu : quarantaine et excédent, ni réception ni facture.
    await user.click(
      within(received).getByRole('button', { name: 'Voir le rapprochement de BC-2026-000002' }),
    );
    const receivedLine = await within(received).findByRole('listitem', {
      name: 'Ligne Poulet de chair',
    });
    expect(
      within(receivedLine).getByText(
        'En quarantaine : 4 kg, sans effet sur le stock tant que non tranché.',
      ),
    ).toBeInTheDocument();
    expect(within(receivedLine).getByText('Excédent reçu : 2 kg.')).toBeInTheDocument();
    expect(within(receivedLine).queryByText(/^Facturé .* acceptés/)).toBeNull();
    expect(await within(received).findByText('Aucune réception pour ce bon.')).toBeInTheDocument();
    expect(await within(received).findByText('Aucune facture pour ce bon.')).toBeInTheDocument();

    // Groupe sans écart, filtre coché : un message propre.
    serve({
      ...baseRoutes(),
      '/api/v1/purchase-orders?status=CLOSED&limit=200': page('purchase_orders', [
        order({
          id: 'closed',
          docNumber: 'BC-2026-000001',
          status: 'CLOSED',
          lines: [line({ rejectedQtyBase: 0, invoicedQtyBase: 95, remainingQtyBase: 0 })],
        }),
      ]),
    });
    await user.selectOptions(screen.getByLabelText('Bons à afficher'), 'CLOSED');
    expect(
      await screen.findByText('Aucun bon de ce groupe ne présente d’écart.'),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText('Seulement les bons avec un écart'));
    await user.selectOptions(screen.getByLabelText('Bons à afficher'), 'OPEN');
    await user.selectOptions(screen.getByLabelText('Filtrer par fournisseur'), OTHER_SUPPLIER);
    expect(await screen.findByText('Aucun bon dans ce groupe.')).toBeInTheDocument();
  });

  it('détail : rapprochement par ligne en unité de base, valeurs et payé, réceptions, factures du bon', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const late = await screen.findByRole('listitem', { name: 'BC-2026-000003' });
    await user.click(
      within(late).getByRole('button', { name: 'Voir le rapprochement de BC-2026-000003' }),
    );
    const lineCard = await within(late).findByRole('listitem', { name: 'Ligne Poulet de chair' });
    expect(
      within(lineCard).getByText('Commandé 100 kg · livré 98 kg · rejeté 3 kg · accepté 95 kg'),
    ).toBeInTheDocument();
    expect(
      within(lineCard).getByText('Reste 5 kg · clôturé 0 kg · facturé 98 kg'),
    ).toBeInTheDocument();
    expect(
      within(lineCard).getByText(
        'Facturé 98 kg pour 95 kg acceptés : écart à régler par un avoir.',
      ),
    ).toBeInTheDocument();
    expect(
      within(lineCard).getByText(
        /^Valeurs au prix du bon : commandé 1\s500\s000 F CFA · accepté 1\s425\s000 F CFA · facturé 1\s470\s000 F CFA$/,
      ),
    ).toBeInTheDocument();
    expect(
      within(late).getByText(
        /^Total du bon : commandé 1\s500\s000 F CFA · accepté 1\s425\s000 F CFA · facturé 1\s470\s000 F CFA au prix du bon · payé 500\s000 F CFA$/,
      ),
    ).toBeInTheDocument();
    expect(within(late).queryByRole('listitem', { name: 'Ligne Œufs de table' })).toBeNull();
    const receiptCard = await within(late).findByRole('listitem', { name: 'BR-2026-000004' });
    // La plus récente d'abord ; une réception annulée garde son motif.
    expect(
      within(late)
        .getAllByRole('listitem', { name: /^BR-2026/ })
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['BR-2026-000005', 'BR-2026-000004']);
    const cancelled = within(late).getByRole('listitem', { name: 'BR-2026-000005' });
    expect(within(cancelled).getByText(/^· Annulée$/)).toBeInTheDocument();
    expect(
      within(cancelled).getByText('Motif de l’annulation : Bon de livraison erroné'),
    ).toBeInTheDocument();
    // Saisie à 23:30 UTC le 7 : le 8 octobre à Douala.
    expect(
      within(cancelled).getByText(/^8 octobre 2026 · bon de livraison BL-778$/),
    ).toBeInTheDocument();
    expect(within(receiptCard).getByText(/^· Comptabilisée$/)).toBeInTheDocument();
    expect(within(receiptCard).getByText(/bon de livraison BL-778/)).toBeInTheDocument();
    expect(
      within(receiptCard).getByText('Poulet de chair : livré 98 kg, rejeté 3 kg, accepté 95 kg'),
    ).toBeInTheDocument();
    const invoiceCard = await within(late).findByRole('listitem', { name: 'FF-2026-000007' });
    expect(within(invoiceCard).getByText(/^· Payée en partie$/)).toBeInTheDocument();
    expect(
      within(invoiceCard).getByText(
        /^Réf\. fournisseur FA-0012 · 1\s470\s000 F CFA · payé 500\s000 F CFA$/,
      ),
    ).toBeInTheDocument();
    expect(
      within(late).getByRole('link', { name: 'Ouvrir les factures fournisseurs' }),
    ).toHaveAttribute('href', '/finance/factures');
    await user.click(
      within(late).getByRole('button', { name: 'Masquer le rapprochement de BC-2026-000003' }),
    );
    expect(within(late).queryByText('Rapprochement par ligne')).toBeNull();
  });

  it('sans droit sur les dettes ni les valeurs : factures jamais lues, valeurs et payé non disponibles', async () => {
    await rememberRoles(['RESP_PRODUCTION']);
    serve({
      ...baseRoutes(),
      // Liste lue sans valorisation : total et prix masqués (RC-05).
      '/api/v1/purchase-orders?status=PARTIALLY_RECEIVED&limit=200': page('purchase_orders', [
        order({
          totalXaf: null,
          lines: [line({ unitPriceXaf: null, lineTotalXaf: null })],
        }),
      ]),
      [`/api/v1/purchase-orders/${PO_LATE}/matching`]: {
        matching: {
          ...detail,
          lines: detail.lines.map((entry) => ({
            ...entry,
            unitPriceXaf: null,
            orderedValueXaf: null,
            acceptedValueXaf: null,
            invoicedValueXaf: null,
          })),
          totals: {
            orderedValueXaf: null,
            acceptedValueXaf: null,
            invoicedValueXaf: null,
            paidXaf: null,
          },
        },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const late = await screen.findByRole('listitem', { name: 'BC-2026-000003' });
    expect(within(late).queryByText(/· total /)).toBeNull();
    await user.click(
      within(late).getByRole('button', { name: 'Voir le rapprochement de BC-2026-000003' }),
    );
    expect(
      await within(late).findByText(
        'Total du bon : commandé non disponible · accepté non disponible · facturé non disponible au prix du bon · payé non disponible',
      ),
    ).toBeInTheDocument();
    expect(within(late).queryByText(/^Valeurs au prix du bon/)).toBeNull();
    expect(within(late).queryByText('Factures du bon')).toBeNull();
    expect(readsOf(`/api/v1/supplier-invoices?purchase_order_id=${PO_LATE}&limit=200`)).toBe(0);
  });

  it('pannes et refus : liste relue, sections du détail indépendantes, chacune avec sa relance', async () => {
    await rememberRoles(['RESP_ACHATS']);
    serve({ ...baseRoutes(), '/api/v1/purchase-orders?status=SENT&limit=200': BROKEN });
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    expect(
      await screen.findByText('Bons de commande indisponibles : le serveur n’a pas répondu.'),
    ).toBeInTheDocument();
    serve({
      ...baseRoutes(),
      [`/api/v1/purchase-orders/${PO_LATE}/matching`]: BROKEN,
      [`/api/v1/receipts?purchase_order_id=${PO_LATE}&limit=200`]: DENIED,
      [`/api/v1/supplier-invoices?purchase_order_id=${PO_LATE}&limit=200`]: BROKEN,
    });
    await user.click(screen.getByRole('button', { name: 'Relire les bons' }));
    const late = await screen.findByRole('listitem', { name: 'BC-2026-000003' });
    await user.click(
      within(late).getByRole('button', { name: 'Voir le rapprochement de BC-2026-000003' }),
    );
    expect(await within(late).findByText(/^Rapprochement indisponible/)).toBeInTheDocument();
    expect(await within(late).findByText(/^Factures indisponibles/)).toBeInTheDocument();
    // Réceptions refusées : pas de relance.
    expect(within(late).getByText(/^Non accessible avec vos droits\./)).toBeInTheDocument();
    expect(
      within(late).queryByRole('button', { name: 'Relire les réceptions de BC-2026-000003' }),
    ).toBeNull();
    serve(baseRoutes());
    await user.click(
      within(late).getByRole('button', { name: 'Relire le rapprochement de BC-2026-000003' }),
    );
    expect(
      await within(late).findByRole('listitem', { name: 'Ligne Poulet de chair' }),
    ).toBeInTheDocument();
    await user.click(
      within(late).getByRole('button', { name: 'Relire les factures de BC-2026-000003' }),
    );
    expect(
      await within(late).findByRole('listitem', { name: 'FF-2026-000007' }),
    ).toBeInTheDocument();
    unmount();

    serve({
      ...baseRoutes(),
      '/api/v1/purchase-orders?status=SENT&limit=200': DENIED,
    });
    renderScreen();
    expect(
      await screen.findByText('Bons de commande non accessibles avec vos droits.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Relire les bons' })).toBeNull();
  });

  it('liste périmée annoncée ; hors ligne, la dernière lecture reste sans « actualisation »', async () => {
    await rememberRoles(['RESP_ACHATS']);
    const { unmount } = renderScreen();
    await screen.findByRole('listitem', { name: 'BC-2026-000003' });
    act(() => reportSyncOutcome('OFFLINE'));
    expect(
      await screen.findByText('Hors ligne : les bons affichés peuvent être périmés.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Actualisation en cours…')).toBeNull();
    const reads = readsOf('/api/v1/purchase-orders?status=SENT&limit=200');
    expect(screen.getByRole('listitem', { name: 'BC-2026-000003' })).toBeInTheDocument();
    // Aucune lecture hors ligne ; un détail ouvert hors ligne le dit, sans chargement sans fin.
    expect(readsOf('/api/v1/purchase-orders?status=SENT&limit=200')).toBe(reads);
    const offlineCard = screen.getByRole('listitem', { name: 'BC-2026-000003' });
    await userEvent.setup().click(
      within(offlineCard).getByRole('button', {
        name: 'Voir le rapprochement de BC-2026-000003',
      }),
    );
    expect(
      within(offlineCard).getAllByText(
        'Rapprochement en ligne seulement : reconnectez-vous pour le lire.',
      ),
    ).toHaveLength(3);
    expect(within(offlineCard).queryByText(/^Chargement/)).toBeNull();
    act(() => reportSyncOutcome('SYNCED'));
    serve({ ...baseRoutes(), '/api/v1/purchase-orders?status=SENT&limit=200': BROKEN });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(
      await screen.findByText(/^Actualisation impossible : le serveur n’a pas répondu/),
    ).toBeInTheDocument();
    unmount();

    // Écran ouvert hors ligne, rien de lu : en ligne seulement, pas de chargement sans fin.
    serve(baseRoutes());
    act(() => reportSyncOutcome('OFFLINE'));
    renderScreen();
    expect(
      await screen.findByText('Rapprochement en ligne seulement : reconnectez-vous pour le lire.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Chargement/)).toBeNull();
  });

  it('retour sur l’onglet : le détail ouvert se relit avec la liste', async () => {
    await rememberRoles(['RESP_ACHATS']);
    const user = userEvent.setup();
    renderScreen();
    const late = await screen.findByRole('listitem', { name: 'BC-2026-000003' });
    await user.click(
      within(late).getByRole('button', { name: 'Voir le rapprochement de BC-2026-000003' }),
    );
    await within(late).findByText('Reste 5 kg · clôturé 0 kg · facturé 98 kg');
    // Une réception de plus a été comptabilisée pendant que l'onglet était caché.
    serve({
      ...baseRoutes(),
      [`/api/v1/purchase-orders/${PO_LATE}/matching`]: {
        matching: {
          ...detail,
          lines: [{ ...detail.lines[0]!, acceptedQtyBase: 100, remainingQtyBase: 0 }],
        },
      },
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(
      await within(late).findByText('Reste 0 kg · clôturé 0 kg · facturé 98 kg'),
    ).toBeInTheDocument();
  });

  it('bon lu dans deux statuts (changement entre deux lectures) : une seule carte', async () => {
    await rememberRoles(['RESP_ACHATS']);
    serve({
      ...baseRoutes(),
      '/api/v1/purchase-orders?status=SENT&limit=200': page('purchase_orders', [
        order({ status: 'SENT' }),
      ]),
    });
    renderScreen();
    await screen.findByRole('listitem', { name: 'BC-2026-000003' });
    expect(screen.getAllByRole('listitem', { name: 'BC-2026-000003' })).toHaveLength(1);
    expect(screen.getByText(/^· Reçu en partie$/)).toBeInTheDocument();
  });
});

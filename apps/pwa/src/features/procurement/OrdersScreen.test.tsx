import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { OrdersScreen } from './OrdersScreen.js';
import { draftUpdate, orderActions, type OrderView, type RequestView } from './orders.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const FEED = '01900000-0000-7000-8000-0000000007b1';
const SACK = '01900000-0000-7000-8000-0000000007b2';
const SUPPLIER = '01900000-0000-7000-8000-0000000007b3';
const REQUEST_LINE = '01900000-0000-7000-8000-0000000007b4';

const line = (overrides: Partial<OrderView['lines'][number]>): OrderView['lines'][number] => ({
  id: 'l1',
  lineNo: 1,
  productId: FEED,
  unitCode: 'KG',
  orderedQtyBase: 500,
  acceptedQtyBase: 0,
  remainingQtyBase: 500,
  unitPriceXaf: 400,
  lineTotalXaf: 200_000,
  status: 'OPEN',
  requestLineId: null,
  ...overrides,
});

const order = (overrides: Partial<OrderView>): OrderView => ({
  id: 'bc-draft',
  docNumber: 'BC-YDE-2026-000010',
  siteId: IDS.site,
  supplierId: SUPPLIER,
  deliveryLocationId: IDS.pos,
  expectedDeliveryDate: '2026-10-20',
  status: 'DRAFT',
  totalXaf: 240_000,
  sentAt: null,
  closedReason: null,
  occurredAt: '2026-10-09T09:00:00.000Z',
  lines: [line({}), line({ id: 'l2', lineNo: 2, orderedQtyBase: 100, lineTotalXaf: 40_000 })],
  ...overrides,
});

const ORDERS = [
  order({}),
  order({ id: 'bc-approved', docNumber: 'BC-YDE-2026-000011', status: 'APPROVED' }),
  order({
    id: 'bc-partial',
    docNumber: 'BC-YDE-2026-000012',
    status: 'PARTIALLY_RECEIVED',
    lines: [line({ acceptedQtyBase: 300, remainingQtyBase: 200 })],
  }),
];

const REQUESTS: RequestView[] = [
  {
    id: 'da-1',
    docNumber: 'DA-YDE-2026-000003',
    siteId: IDS.site,
    status: 'APPROVED',
    lines: [
      {
        id: REQUEST_LINE,
        productId: FEED,
        unitCode: 'SAC',
        quantityBase: 100,
        remainingToOrderBase: 100,
        estimatedUnitPriceXaf: 380,
      },
    ],
  },
];

function answer(path: string) {
  if (path.startsWith('/api/v1/suppliers')) {
    return {
      ok: true,
      data: {
        suppliers: [
          {
            id: SUPPLIER,
            code: 'PROV',
            name: 'Provenderie du Centre',
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
    };
  }
  if (path.startsWith('/api/v1/purchase-requests')) {
    const status = new URL(path, 'http://local').searchParams.get('status');
    return {
      ok: true,
      data: {
        purchase_requests: REQUESTS.filter((request) => !status || request.status === status),
        next_cursor: null,
      },
    };
  }
  return { ok: true, data: { purchase_orders: ORDERS, next_cursor: null } };
}

function projection(dataset: string, type: string, id: string, data: object) {
  return {
    key: `${dataset}:${type}:${id}`,
    dataset,
    entity_type: type,
    entity_id: id,
    scope_type: 'GLOBAL',
    scope_id: null,
    row_version: 1,
    seq: 1,
    data: { id, ...data } as Record<string, unknown>,
  };
}

async function settleLast(expectedCount?: number) {
  if (expectedCount !== undefined) {
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(expectedCount));
  }
  const [command] = await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray();
  if (!command) throw new Error('aucune commande');
  await getDb().outbox.update(command.command_id, {
    status: 'SYNCED',
    synced_at: '2026-10-10T09:00:05.000Z',
  });
}

/** Bouton d'une carte, relu à chaque essai (les cartes se remontent après chaque relecture). */
async function enabledButton(card: string, name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = within(screen.getByRole('listitem', { name: card })).getByRole('button', { name });
    expect(found).toBeEnabled();
  });
  return found as HTMLElement;
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <OrdersScreen />
    </MemoryRouter>,
  );
}

describe('Bons de commande (ECR-APP-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      projection('product', 'PRODUCT', FEED, {
        code: 'ALIM',
        name: 'Aliment démarrage',
        category_id: IDS.zone,
        base_unit_code: 'KG',
        is_sellable: false,
        is_purchasable: true,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
        stock_family: 'INTRANT',
        lot_tracking: 'NONE',
      }),
      projection('product_unit', 'PRODUCT_UNIT', SACK, {
        product_id: FEED,
        unit_code: 'SAC',
        factor_to_base: '50.000000',
        is_sales_unit: false,
        is_purchase_unit: true,
        is_active: true,
      }),
    ]);
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => answer(path) as never);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    // Lectures encore en cours (pages suivantes) après le test : réseau coupé.
    vi.mocked(authorizedRequest).mockResolvedValue({ ok: false, reason: 'OFFLINE' } as never);
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('nouveau bon : ligne de demande bornée à son reste, ligne directe en sacs, total et validation', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Nouveau bon de commande' }));
    const form = within(screen.getByRole('region', { name: 'Nouveau bon de commande' }));
    await user.selectOptions(await form.findByLabelText('Fournisseur'), SUPPLIER);
    await user.selectOptions(form.getByLabelText('Livré sur'), IDS.pos);
    await user.selectOptions(
      await form.findByLabelText('Ligne d’une demande approuvée'),
      REQUEST_LINE,
    );
    await user.click(form.getByRole('button', { name: 'Ajouter la ligne de demande' }));
    const fromRequest = form.getByRole('listitem', { name: 'Aliment démarrage' });
    const quantity = within(fromRequest).getByLabelText('Quantité');
    expect(quantity).toHaveValue('100');
    await user.clear(quantity);
    await user.type(quantity, '120');
    expect(
      within(fromRequest).getByText('Plus que le reste à commander de la demande.'),
    ).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '80');

    await user.selectOptions(form.getByLabelText('Produit achetable'), FEED);
    await user.click(form.getByRole('button', { name: 'Ajouter le produit' }));
    const [, direct] = form.getAllByRole('listitem', { name: 'Aliment démarrage' });
    if (!direct) throw new Error('ligne directe absente');
    await user.type(within(direct).getByLabelText('Quantité'), '20');
    await user.selectOptions(within(direct).getByLabelText('Unité'), 'SAC');
    await user.type(within(direct).getByLabelText('Prix par KG (F)'), '400');
    // 80 kg × 380 F + 1 000 kg × 400 F = 430 400 F : au-delà du seuil par défaut (500 000 F) ? Non.
    expect(form.getByText(/Total : 430\s400\sF\sCFA/)).toBeInTheDocument();
    expect(form.queryByText(/validation auprès de la Direction/)).not.toBeInTheDocument();
    await user.clear(within(direct).getByLabelText('Quantité'));
    await user.type(within(direct).getByLabelText('Quantité'), '30');
    expect(form.getByText(/validation auprès de la Direction/)).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Créer le bon de commande' }));
    await screen.findByText(/Bon de commande (en cours d’envoi|enregistré)/);
    // La saisie reste jusqu'à la réponse du serveur (refusée, elle se corrigerait sans ressaisie).
    expect(form.getAllByRole('listitem', { name: 'Aliment démarrage' })).toHaveLength(2);

    const [created] = await getDb().outbox.toArray();
    expect(created).toMatchObject({
      command_type: 'procurement.order.create',
      aggregate_type: 'PURCHASE_ORDER',
      payload: {
        supplierId: SUPPLIER,
        deliveryLocationId: IDS.pos,
        lines: [
          {
            productId: FEED,
            unitCode: 'KG',
            orderedQtyBase: 80,
            unitPriceXaf: 380,
            requestLineId: REQUEST_LINE,
          },
          { productId: FEED, unitCode: 'SAC', orderedQtyBase: 1500, unitPriceXaf: 400 },
        ],
      },
    });
    // Accepté : numéro du bon annoncé, retour à la liste, saisie remise à zéro.
    await getDb().outbox.update(created?.command_id ?? '', {
      status: 'SYNCED',
      synced_at: '2026-10-10T09:00:05.000Z',
      server_refs: { docNumber: 'BC-YDE-2026-000012' },
    });
    expect(await screen.findByText('Bon de commande BC-YDE-2026-000012 créé.')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Bons de commande' });
    await user.click(screen.getByRole('radio', { name: 'Nouveau bon de commande' }));
    expect(
      within(screen.getByRole('region', { name: 'Nouveau bon de commande' })).queryAllByRole(
        'listitem',
      ),
    ).toHaveLength(0);
  });

  it('brouillon modifié puis soumis ; approuvé marqué envoyé ; reliquat clôturé avec motif', async () => {
    const user = userEvent.setup();
    renderScreen();
    const draftCard = await screen.findByRole('listitem', { name: 'BC-YDE-2026-000010' });
    await user.click(within(draftCard).getByRole('button', { name: 'Modifier' }));
    const first = within(draftCard).getByRole('group', { name: 'Aliment démarrage (ligne 1)' });
    await user.clear(within(first).getByLabelText('Quantité (KG)'));
    await user.type(within(first).getByLabelText('Quantité (KG)'), '450');
    const second = within(draftCard).getByRole('group', { name: 'Aliment démarrage (ligne 2)' });
    await user.click(within(second).getByLabelText('Annuler cette ligne'));
    await user.click(
      within(draftCard).getByRole('button', { name: 'Enregistrer les changements' }),
    );
    await settleLast(1);

    await user.click(await enabledButton('BC-YDE-2026-000010', 'Soumettre'));
    await settleLast(2);
    await user.click(await enabledButton('BC-YDE-2026-000011', 'Marquer envoyé'));
    await settleLast(3);
    const close = await enabledButton('BC-YDE-2026-000012', 'Clôturer le reliquat');
    const partial = screen.getByRole('listitem', { name: 'BC-YDE-2026-000012' });
    await user.click(close);
    const confirm = within(partial).getByRole('button', { name: 'Confirmer la clôture' });
    expect(confirm).toBeDisabled();
    await user.type(
      within(partial).getByLabelText('Motif de la clôture (obligatoire)'),
      'Rupture fournisseur',
    );
    await user.click(confirm);

    const commands = await getDb().outbox.orderBy('device_seq').toArray();
    expect(
      commands.map((command) => [command.command_type, command.aggregate_id, command.payload]),
    ).toEqual([
      [
        'procurement.order.update',
        'bc-draft',
        {
          lines: [
            { lineNo: 1, orderedQtyBase: 450 },
            { lineNo: 2, cancel: true },
          ],
        },
      ],
      ['procurement.order.submit', 'bc-draft', {}],
      ['procurement.order.mark_sent', 'bc-approved', {}],
      ['procurement.order.close_remaining', 'bc-partial', { reason: 'Rupture fournisseur' }],
    ]);
  });

  it('hors ligne : écran en ligne seulement, aucune lecture', async () => {
    // Lectures en chaîne du test précédent (pages suivantes) terminées avant de compter.
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.mocked(authorizedRequest).mockClear();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/en ligne seulement/);
    expect(authorizedRequest).not.toHaveBeenCalled();
  });
});

describe('Bons de commande : actions et brouillon', () => {
  it('actions selon le statut ; brouillon sans changement ou vidé refusé', () => {
    expect(orderActions('DRAFT')).toMatchObject({ edit: true, submit: true, cancel: true });
    expect(orderActions('SENT')).toMatchObject({ edit: false, markSent: false, cancel: true });
    expect(orderActions('RECEIVED')).toEqual({
      edit: false,
      submit: false,
      markSent: false,
      closeRemaining: false,
      cancel: false,
    });
    const draft = order({});
    expect(draftUpdate(draft, new Map(), '2026-10-20').issues).toEqual(['NOTHING']);
    const allCancelled = new Map([
      ['l1', { qtyText: '500', priceText: '400', cancel: true }],
      ['l2', { qtyText: '100', priceText: '400', cancel: true }],
    ]);
    expect(draftUpdate(draft, allCancelled, '2026-10-20').issues).toEqual(['ORDER_EMPTY']);
    expect(draftUpdate(draft, new Map(), '').payload).toEqual({ expectedDeliveryDate: null });
  });

  it('brouillon tiré d’une demande : hausse bornée au reste de la demande ; montant borné', () => {
    const fromRequest = order({
      lines: [line({ requestLineId: 'rl', orderedQtyBase: 100, unitPriceXaf: 400 })],
    });
    const raise = (qty: string) =>
      new Map([['l1', { qtyText: qty, priceText: '400', cancel: false }]]);
    // Reste de la demande : 20 ; la ligne peut monter jusqu'à 120.
    const remaining = new Map([['rl', 20]]);
    expect(draftUpdate(fromRequest, raise('120'), '2026-10-20', remaining).issues).toEqual([]);
    expect(draftUpdate(fromRequest, raise('121'), '2026-10-20', remaining).issues).toEqual([
      'OVER_REQUEST',
    ]);
    // Demande inconnue de la liste (entièrement commandée) : baisse seulement.
    expect(draftUpdate(fromRequest, raise('101'), '2026-10-20').issues).toEqual(['OVER_REQUEST']);
    expect(draftUpdate(fromRequest, raise('90'), '2026-10-20').issues).toEqual([]);
    // Montant hors des entiers sûrs : refusé avant l'envoi.
    const huge = new Map([
      ['l1', { qtyText: '99999999999', priceText: '999999999', cancel: false }],
    ]);
    expect(draftUpdate(order({}), huge, '2026-10-20').issues).toContain('AMOUNT_TOO_LARGE');
  });
});

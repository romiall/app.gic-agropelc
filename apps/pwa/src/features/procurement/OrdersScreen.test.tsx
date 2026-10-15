import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
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

/** Commande des bons retrouvée dans l'outbox (visite précédente). */
function pendingOrderCommand(overrides: Partial<OutboxCommand>): OutboxCommand {
  return {
    command_id: '01900000-0000-7000-8000-0000000007f1',
    device_seq: 1,
    command_type: 'procurement.order.create',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'PURCHASE_ORDER',
    aggregate_id: '01900000-0000-7000-8000-0000000007f2',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:00:00.000Z',
    client_created_at: '2026-10-10T08:00:00.000Z',
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload: { supplierId: SUPPLIER, deliveryLocationId: IDS.pos, lines: [] },
    status: 'PENDING_SYNC',
    attempts: 1,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

/** Bon direct d'une ligne saisi dans la rubrique « Nouveau bon de commande ». */
async function fillDirectOrder(user: ReturnType<typeof userEvent.setup>) {
  const form = within(screen.getByRole('region', { name: 'Nouveau bon de commande' }));
  await user.selectOptions(await form.findByLabelText('Fournisseur'), SUPPLIER);
  await user.selectOptions(form.getByLabelText('Livré sur'), IDS.pos);
  await user.selectOptions(form.getByLabelText('Produit achetable'), FEED);
  await user.click(form.getByRole('button', { name: 'Ajouter le produit' }));
  const direct = form.getByRole('listitem', { name: 'Aliment démarrage' });
  await user.type(within(direct).getByLabelText('Quantité'), '10');
  await user.type(within(direct).getByLabelText('Prix par kg (F)'), '400');
  return form;
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
    await user.type(within(direct).getByLabelText('Prix par kg (F)'), '400');
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

  it('nouveau bon en échec répété : saisie gardée, pas de renvoi à l’identique, annoncé ; refusé, elle se corrige', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Nouveau bon de commande' }));
    const form = await fillDirectOrder(user);
    await user.click(form.getByRole('button', { name: 'Créer le bon de commande' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [sent] = await getDb().outbox.toArray();
    // Le serveur la renvoie trois fois (exception en base) : elle reste réessayée.
    await getDb().outbox.update(sent?.command_id as string, {
      status: 'PENDING_SYNC',
      busy_retries: 3,
      last_error: { code: 'SERVER_BUSY', message_fr: 'Erreur transitoire, à réessayer.' },
    });
    expect(await form.findByText(/ne le renvoyez pas tel quel/)).toBeInTheDocument();
    // La saisie reste (pour la corriger s'il est refusé) ; renvoyée telle quelle, un second bon
    // serait créé : le bouton se bloque, motif relié.
    const line = form.getByRole('listitem', { name: 'Aliment démarrage' });
    expect(within(line).getByLabelText('Quantité')).toHaveValue('10');
    const create = form.getByRole('button', { name: 'Créer le bon de commande' });
    await waitFor(() => expect(create).toBeDisabled());
    expect(create).toHaveAccessibleDescription(/ne le renvoyez pas tel quel/);
    expect(await getDb().outbox.count()).toBe(1);
    // Le serveur finit par refuser : la saisie se corrige et se renvoie.
    await getDb().outbox.update(sent?.command_id as string, {
      status: 'REJECTED',
      busy_retries: 0,
      last_error: { code: 'SUPPLIER_INACTIVE', message_fr: 'Fournisseur désactivé.' },
    });
    await waitFor(() => expect(create).toBeEnabled());
    expect(within(line).getByLabelText('Quantité')).toHaveValue('10');
  });

  it('création en échec répété puis acceptée : la saisie d’un autre bon reste affichée', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Nouveau bon de commande' }));
    const form = await fillDirectOrder(user);
    await user.click(form.getByRole('button', { name: 'Créer le bon de commande' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [sent] = await getDb().outbox.toArray();
    await getDb().outbox.update(sent?.command_id as string, {
      status: 'PENDING_SYNC',
      busy_retries: 3,
      last_error: { code: 'SERVER_BUSY', message_fr: 'Erreur transitoire, à réessayer.' },
    });
    expect(await form.findByText(/ne le renvoyez pas tel quel/)).toBeInTheDocument();
    // L'utilisateur reprend la saisie pour un autre bon ; la première création est enfin acceptée.
    const line = form.getByRole('listitem', { name: 'Aliment démarrage' });
    await user.type(within(line).getByLabelText('Quantité'), '0');
    const calls = vi.mocked(authorizedRequest).mock.calls.length;
    await getDb().outbox.update(sent?.command_id as string, {
      status: 'SYNCED',
      busy_retries: 0,
      last_error: null,
    });
    await screen.findByText(/Bon de commande .*créé/);
    // L'écran a traité la réponse (relecture des listes) sans quitter la saisie.
    await waitFor(() =>
      expect(vi.mocked(authorizedRequest).mock.calls.length).toBeGreaterThan(calls),
    );
    expect(screen.getByRole('region', { name: 'Nouveau bon de commande' })).toBeVisible();
    // Saisie modifiée depuis l'envoi : elle reste.
    expect(form.getByLabelText('Fournisseur')).toHaveValue(SUPPLIER);
    expect(within(line).getByLabelText('Quantité')).toHaveValue('100');
  });

  it('relecture des demandes en échec après une création : annoncée dans « Nouveau bon », « Réessayer » sur place', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Nouveau bon de commande' }));
    const form = await fillDirectOrder(user);
    await form.findByLabelText('Ligne d’une demande approuvée');
    await user.click(form.getByRole('button', { name: 'Créer le bon de commande' }));
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) =>
        (String(path).startsWith('/api/v1/purchase-requests')
          ? { ok: false, reason: 'HTTP_ERROR', status: 500, body: null }
          : answer(path)) as never,
    );
    await settleLast(1);
    // Création acceptée : retour à la liste, puis retour à la saisie.
    await screen.findByText(/Bon de commande .*créé/);
    await user.click(screen.getByRole('radio', { name: 'Nouveau bon de commande' }));
    expect(await form.findByText(/Relecture des demandes d’achat en échec/)).toBeInTheDocument();
    // Les anciennes demandes restent listées, mais aucune ligne n'en est tirée avant la relecture.
    await user.selectOptions(form.getByLabelText('Ligne d’une demande approuvée'), REQUEST_LINE);
    expect(form.getByRole('button', { name: 'Ajouter la ligne de demande' })).toBeDisabled();
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => answer(path) as never);
    await user.click(form.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() =>
      expect(form.queryByText(/Relecture des demandes d’achat en échec/)).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(form.getByRole('button', { name: 'Ajouter la ligne de demande' })).toBeEnabled(),
    );
  });

  it('demandes indisponibles : un bon direct reste créable, « Réessayer » relit les demandes', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) =>
        (String(path).startsWith('/api/v1/purchase-requests')
          ? { ok: false, reason: 'HTTP_ERROR', status: 500, body: null }
          : answer(path)) as never,
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Nouveau bon de commande' }));
    const form = await fillDirectOrder(user);
    expect(form.getByText(/Demandes d’achat indisponibles/)).toBeInTheDocument();
    await waitFor(() =>
      expect(form.getByRole('button', { name: 'Créer le bon de commande' })).toBeEnabled(),
    );
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => answer(path) as never);
    await user.click(form.getByRole('button', { name: 'Réessayer' }));
    expect(await form.findByLabelText('Ligne d’une demande approuvée')).toBeInTheDocument();
  });

  it('commande retrouvée en échec répété : pas de relecture à chaque cycle, panneau ouvert gardé', async () => {
    await getDb().outbox.add(
      pendingOrderCommand({
        command_type: 'procurement.order.submit',
        aggregate_id: 'bc-approved',
        payload: {},
        busy_retries: 3,
        last_error: { code: 'SERVER_BUSY', message_fr: 'Erreur transitoire, à réessayer.' },
      }),
    );
    const user = userEvent.setup();
    renderScreen();
    const draftCard = await screen.findByRole('listitem', { name: 'BC-YDE-2026-000010' });
    const edit = await enabledButton('BC-YDE-2026-000010', 'Modifier');
    await user.click(edit);
    const first = within(draftCard).getByRole('group', { name: 'Aliment démarrage (ligne 1)' });
    await user.clear(within(first).getByLabelText('Quantité (kg)'));
    await user.type(within(first).getByLabelText('Quantité (kg)'), '480');
    const reads = vi.mocked(authorizedRequest).mock.calls.length;
    // Un cycle de synchronisation repousse la commande : SYNCING puis PENDING_SYNC.
    await getDb().outbox.update('01900000-0000-7000-8000-0000000007f1', { status: 'SYNCING' });
    await getDb().outbox.update('01900000-0000-7000-8000-0000000007f1', {
      status: 'PENDING_SYNC',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vi.mocked(authorizedRequest).mock.calls.length).toBe(reads);
    expect(
      within(screen.getByRole('listitem', { name: 'BC-YDE-2026-000010' })).getByRole('group', {
        name: 'Aliment démarrage (ligne 1)',
      }),
    ).toBeInTheDocument();
    expect(
      within(
        within(screen.getByRole('listitem', { name: 'BC-YDE-2026-000010' })).getByRole('group', {
          name: 'Aliment démarrage (ligne 1)',
        }),
      ).getByLabelText('Quantité (kg)'),
    ).toHaveValue('480');
  });

  it('création d’une visite précédente : sa réponse ne vide ni ne quitte la saisie en cours', async () => {
    await getDb().outbox.add(pendingOrderCommand({}));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('radio', { name: 'Nouveau bon de commande' }));
    const form = await fillDirectOrder(user);
    await getDb().outbox.update('01900000-0000-7000-8000-0000000007f1', {
      status: 'SYNCED',
      synced_at: '2026-10-10T09:00:05.000Z',
      server_refs: { docNumber: 'BC-YDE-2026-000020' },
    });
    expect(await screen.findByText('Bon de commande BC-YDE-2026-000020 créé.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Nouveau bon de commande' })).toBeChecked();
    expect(form.getByRole('listitem', { name: 'Aliment démarrage' })).toBeInTheDocument();
  });

  it('brouillon modifié puis soumis ; approuvé marqué envoyé ; reliquat clôturé avec motif', async () => {
    const user = userEvent.setup();
    renderScreen();
    const draftCard = await screen.findByRole('listitem', { name: 'BC-YDE-2026-000010' });
    await user.click(within(draftCard).getByRole('button', { name: 'Modifier' }));
    const first = within(draftCard).getByRole('group', { name: 'Aliment démarrage (ligne 1)' });
    await user.clear(within(first).getByLabelText('Quantité (kg)'));
    await user.type(within(first).getByLabelText('Quantité (kg)'), '450');
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
    // Demandes jamais lues : la hausse attend leur lecture (reste inconnu, pas « dépassé »).
    expect(draftUpdate(fromRequest, raise('101'), '2026-10-20', null).issues).toEqual([
      'REMAINING_UNKNOWN',
    ]);
    expect(draftUpdate(fromRequest, raise('90'), '2026-10-20', null).issues).toEqual([]);
    // Montant hors des entiers sûrs : refusé avant l'envoi.
    const huge = new Map([
      ['l1', { qtyText: '99999999999', priceText: '999999999', cancel: false }],
    ]);
    expect(draftUpdate(order({}), huge, '2026-10-20').issues).toContain('AMOUNT_TOO_LARGE');
  });
});

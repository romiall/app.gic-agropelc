import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { DeliverScreen } from './DeliverScreen.js';
import {
  IDS,
  meSettingRow,
  ORDER_ID,
  ORDER_LINE_ID,
  orderRow,
  posCashAccountRow,
  SALE_ID,
  saleRow,
  seedSalesFixtures,
} from './fixtures.js';
import { NewOrderScreen } from './NewOrderScreen.js';
import { OrderDetailScreen } from './OrderDetailScreen.js';
import { OrdersScreen } from './OrdersScreen.js';
import { FixedClock } from '@gic/domain';
import { rememberNavigation } from '../navigation/navigation-store.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({
  authorizedRequest: vi.fn(async () => ({ ok: true, data: { orders: [] } })),
}));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/commandes/nouvelle" element={<NewOrderScreen />} />
        <Route path="/commandes" element={<OrdersScreen />} />
        <Route path="/commandes/:orderId" element={<OrderDetailScreen />} />
        <Route path="/commandes/:orderId/livrer" element={<DeliverScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

const outboxOf = async (type: string) =>
  (await getDb().outbox.toArray()).filter((command) => command.command_type === type);

describe('Commandes (ECR-VEN-02, 03, 04)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put(orderRow());
  });

  afterEach(async () => {
    await getDb().navigation.clear();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('nouvelle commande : client exigé, préparation au site du client, acompte avec référence', async () => {
    await rememberNavigation(
      getDb(),
      new FixedClock(new Date('2026-10-10T08:00:00.000Z')),
      IDS.user,
      {
        user: { fullName: 'Paul', roles: ['COMMERCIAL_SEDENTAIRE'] },
        sections: [],
      },
    );
    const user = userEvent.setup();
    renderAt('/commandes/nouvelle');
    expect(await screen.findByText('Choisissez le client de la commande.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Passer la commande' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/Rechercher un client/), 'Mvog');
    await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    expect(screen.getByLabelText('Préparée à')).toHaveValue(IDS.pos);

    await user.click(screen.getByRole('button', { name: '+ Ajouter un article' }));
    await user.click(screen.getByRole('button', { name: /Poulet de chair/ }));
    const line = screen.getByRole('listitem', { name: 'Poulet de chair' });
    const quantity = within(line).getByLabelText('Quantité');
    await user.clear(quantity);
    await user.type(quantity, '4');
    expect(screen.getByTestId('order-total')).toHaveTextContent('14 000 F CFA');

    await user.type(screen.getByLabelText('Livraison souhaitée le'), '2026-10-15');
    await user.click(screen.getByLabelText('Encaisser un acompte'));
    await user.selectOptions(screen.getByLabelText('Moyen de paiement'), 'MOBILE_MONEY_ORANGE');
    await user.type(screen.getByLabelText('Montant de l’acompte (F CFA)'), '4000');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Référence de la transaction'), 'OM-77');
    await user.click(submit);
    expect(await screen.findByText(/Commande en cours d’envoi/)).toBeInTheDocument();

    const [command] = await outboxOf('sales.order.place');
    expect(command).toMatchObject({
      aggregate_type: 'SALES_ORDER',
      payload: {
        customerId: IDS.customer,
        fulfilmentLocationId: IDS.pos,
        channelCode: 'SEDENTAIRE',
        requestedDeliveryDate: '2026-10-15',
        lines: [
          {
            productId: IDS.chicken,
            quantity: 4,
            quantityBase: 4,
            unitPriceXaf: 3500,
            listUnitPriceXaf: 3500,
            priceRuleId: IDS.ruleChicken,
          },
        ],
        advancePayments: [
          { methodCode: 'MOBILE_MONEY_ORANGE', amountXaf: 4000, reference: 'OM-77' },
        ],
      },
    });
    // Saisie longue (une vingtaine d'interactions) : marge contre la lenteur d'une machine chargée.
  }, 20_000);

  it('AV-509 : commande servie au PDV, caisse fermée, exigence par défaut absente : acompte en espèces sans invite ni blocage', async () => {
    await getDb().projections.put(posCashAccountRow());
    const user = userEvent.setup();
    renderAt('/commandes/nouvelle');
    await user.type(await screen.findByPlaceholderText(/Rechercher un client/), 'Mvog');
    await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    await user.click(screen.getByRole('button', { name: '+ Ajouter un article' }));
    await user.click(screen.getByRole('button', { name: /Poulet de chair/ }));
    await user.click(screen.getByLabelText('Encaisser un acompte'));
    await user.type(screen.getByLabelText('Montant de l’acompte (F CFA)'), '1000');
    expect(screen.queryByText(/Caisse du point de vente fermée/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Encaissement en espèces impossible sans caisse ouverte/),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Passer la commande' })).toBeEnabled(),
    );
  }, 20_000);

  it('paramètre `finance.cash_session_required`, commande servie au PDV, caisse fermée : en ligne, acompte en espèces bloqué (BR-DIS-005)', async () => {
    await getDb().projections.put(posCashAccountRow());
    await getDb().projections.put(
      meSettingRow('finance.cash_session_required', true, { type: 'SITE', id: IDS.site }),
    );
    const user = userEvent.setup();
    renderAt('/commandes/nouvelle');
    await user.type(await screen.findByPlaceholderText(/Rechercher un client/), 'Mvog');
    await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    await user.click(screen.getByRole('button', { name: '+ Ajouter un article' }));
    await user.click(screen.getByRole('button', { name: /Poulet de chair/ }));
    await user.click(screen.getByLabelText('Encaisser un acompte'));
    expect(
      screen.getByText('Caisse du point de vente fermée : ouvrez-la avant d’encaisser en espèces.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Montant de l’acompte (F CFA)'), '1000');
    expect(
      screen.getByText(/Encaissement en espèces impossible sans caisse ouverte/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Passer la commande' })).toBeDisabled();
  }, 20_000);

  it('paramètre `finance.cash_session_required`, commercial sans la caisse du PDV : acompte en espèces au PDV rappelé, sans blocage ni lien', async () => {
    await getDb().projections.put(
      meSettingRow('finance.cash_session_required', true, { type: 'SITE', id: IDS.site }),
    );
    await rememberNavigation(
      getDb(),
      new FixedClock(new Date('2026-10-10T08:00:00.000Z')),
      IDS.user,
      { user: { fullName: 'Paul', roles: ['COMMERCIAL_SEDENTAIRE'] }, sections: [] },
    );
    const user = userEvent.setup();
    renderAt('/commandes/nouvelle');
    await user.type(await screen.findByPlaceholderText(/Rechercher un client/), 'Mvog');
    await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    await user.click(screen.getByRole('button', { name: '+ Ajouter un article' }));
    await user.click(screen.getByRole('button', { name: /Poulet de chair/ }));
    await user.click(screen.getByLabelText('Encaisser un acompte'));
    await user.type(screen.getByLabelText('Montant de l’acompte (F CFA)'), '1000');
    // La caisse du PDV n'est pas servie à ce rôle : son état est inconnu de l'appareil.
    expect(
      screen.getByText(/la caisse du PDV doit être ouverte \(ce téléphone ne la voit pas\)/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ouvrir la caisse' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Passer la commande' })).toBeEnabled(),
    );
  }, 20_000);

  it('liste : badges « À livrer » et « Attend du stock », filtre', async () => {
    const user = userEvent.setup();
    renderAt('/commandes');
    const row = await screen.findByRole('link', { name: 'Ouvrir la commande CMD-2026-000045' });
    expect(row).toHaveTextContent('Livrée en partie');
    expect(row).toHaveTextContent('À livrer');
    expect(row).toHaveTextContent('Attend du stock');
    expect(row).toHaveTextContent('Boutique Mvog-Mbi');
    await user.selectOptions(screen.getByLabelText('Afficher'), 'waiting_stock');
    expect(screen.getByRole('link', { name: /CMD-2026-000045/ })).toBeInTheDocument();
  });

  it('détail : progression, vendre le disponible, clôturer le reste avec le sort de l’acompte', async () => {
    const user = userEvent.setup();
    renderAt(`/commandes/${ORDER_ID}`);
    expect(
      await screen.findByRole('heading', { name: 'Commande CMD-2026-000045' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Livrer' })).toHaveAttribute(
      'href',
      `/commandes/${ORDER_ID}/livrer`,
    );

    await user.click(screen.getByRole('button', { name: 'Clôturer le reste' }));
    await user.type(screen.getByLabelText('Commentaire'), 'Le client renonce au reste');
    const confirm = screen.getByRole('button', { name: 'Confirmer' });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByLabelText('Rembourser le client'));
    await user.click(confirm);
    await screen.findByText(/Envoi en cours/);
    const [close] = await outboxOf('sales.order.close_remaining');
    expect(close).toMatchObject({
      aggregate_type: 'SALES_ORDER',
      aggregate_id: ORDER_ID,
      payload: { comment: 'Le client renonce au reste', paymentTreatment: 'REFUND' },
    });
  });

  it('détail : une clôture déjà saisie sur l’appareil ferme les autres suites', async () => {
    await getDb().outbox.put({
      command_id: '01900000-0000-7000-8000-0000000000f1',
      device_seq: 1,
      command_type: 'sales.order.close_remaining',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'SALES_ORDER',
      aggregate_id: ORDER_ID,
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T09:00:00.000Z',
      client_created_at: '2026-10-10T09:00:00.000Z',
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: { comment: 'stop' },
      status: 'LOCAL_ONLY',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
    renderAt(`/commandes/${ORDER_ID}`);
    expect(
      await screen.findByText('Une opération sur cette commande attend d’être envoyée.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clôturer le reste' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Livrer' })).not.toBeInTheDocument();
  });

  it('détail : vendre le disponible (confirm_remaining) sur la même commande', async () => {
    const user = userEvent.setup();
    renderAt(`/commandes/${ORDER_ID}`);
    await user.click(
      await screen.findByRole('button', { name: 'Vendre le disponible (reste en attente)' }),
    );
    await screen.findByText(/Envoi en cours/);
    const [confirm] = await outboxOf('sales.order.confirm_remaining');
    expect(confirm).toMatchObject({ aggregate_id: ORDER_ID, payload: {} });
  });

  it('livraison : préremplie au reste à livrer, plafonnée, puis déduite des livraisons en attente', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt(`/commandes/${ORDER_ID}/livrer`);
    const quantity = await screen.findByLabelText('Quantité remise (U)');
    expect(quantity).toHaveValue('4');
    await user.clear(quantity);
    await user.type(quantity, '5');
    expect(
      screen.getByText(/Quantité invalide pour Poulet de chair : entre 0 et 4/),
    ).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '3');
    await user.type(screen.getByLabelText('Remis à (nom de la personne)'), 'Mme Ngo');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la livraison' }));
    await screen.findByText(/Livraison en cours d’envoi/);
    const [fulfil] = await outboxOf('sales.order.fulfil');
    expect(fulfil).toMatchObject({
      aggregate_type: 'DELIVERY_NOTE',
      payload: {
        orderId: ORDER_ID,
        recipientName: 'Mme Ngo',
        lines: [{ orderLineId: ORDER_LINE_ID, quantityBase: 3 }],
      },
    });
    unmount();

    renderAt(`/commandes/${ORDER_ID}`);
    expect(await screen.findByText('Livraison en attente d’envoi : 3')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Livrer' })).toBeInTheDocument());
  });

  it('AV-511 : une commande se passe sans payer — aucun avertissement de crédit, même sans droit au crédit, et elle part sans acompte', async () => {
    // Un client sans droit au crédit : avant la décision du porteur, l'écran avertissait que le serveur refuserait.
    const key = `customers:CUSTOMER:${IDS.customer}`;
    const customer = await getDb().projections.get(key);
    await getDb().projections.put({
      ...customer!,
      data: {
        ...(customer!.data as Record<string, unknown>),
        credit_allowed: false,
        credit_limit_xaf: null,
      },
    });
    const user = userEvent.setup();
    renderAt('/commandes/nouvelle');
    await user.type(await screen.findByPlaceholderText(/Rechercher un client/), 'Mvog');
    await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    await user.click(screen.getByRole('button', { name: '+ Ajouter un article' }));
    await user.click(screen.getByRole('button', { name: /Poulet de chair/ }));
    expect(screen.getByTestId('order-total')).toHaveTextContent('3 500 F CFA');
    // Rien n'est payé et le client n'a pas droit au crédit : ni avertissement ni refus, une mention seulement.
    expect(screen.queryByText(/droit au crédit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Plafond de crédit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/le serveur refusera/)).not.toBeInTheDocument();
    expect(screen.getByText(/Une commande peut se passer sans payer/)).toHaveTextContent(
      'entièrement payée avant d’être livrée',
    );
    const submit = screen.getByRole('button', { name: 'Passer la commande' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText(/Commande en cours d’envoi/)).toBeInTheDocument();
    const [command] = await outboxOf('sales.order.place');
    expect(command!.payload).toMatchObject({ customerId: IDS.customer });
    expect(command!.payload).not.toHaveProperty('advancePayments');
  }, 20_000);

  it('AV-512 : la mention de la commande dit ce qu’elle devra à la livraison — du crédit pour un client autorisé, le paiement sinon, rien si le site n’exige aucun paiement', async () => {
    const user = userEvent.setup();
    const note = () => screen.getByText(/Une commande peut se passer sans payer/);
    const chooseCustomer = async () => {
      await user.type(await screen.findByPlaceholderText(/Rechercher un client/), 'Mvog');
      await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    };

    // Client du jeu : autorisé au crédit (plafond de 50 000) ; sans client choisi, la mention est celle du paiement.
    const first = renderAt('/commandes/nouvelle');
    await screen.findByPlaceholderText(/Rechercher un client/);
    expect(note()).toHaveTextContent('entièrement payée avant d’être livrée');
    await chooseCustomer();
    expect(note()).toHaveTextContent('autorisé au crédit');
    expect(note()).toHaveTextContent('livré à crédit dans son plafond');
    first.unmount();

    // Crédit à la livraison interdit pour le site : le client autorisé paie d'abord, comme les autres.
    await getDb().projections.put(meSettingRow('sales.delivery_on_credit_allowed', false));
    const second = renderAt('/commandes/nouvelle');
    await chooseCustomer();
    expect(note()).toHaveTextContent('entièrement payée avant d’être livrée');
    expect(note()).not.toHaveTextContent('crédit');
    second.unmount();

    // Aucun paiement exigé à la livraison : une simple mention.
    await getDb().projections.put(meSettingRow('sales.delivery_requires_full_payment', false));
    renderAt('/commandes/nouvelle');
    await chooseCustomer();
    expect(note()).toHaveTextContent(/^Une commande peut se passer sans payer\.$/);
  }, 30_000);

  describe('livraison : paiement avant livraison, ou à crédit pour un client autorisé (AV-511, AV-512)', () => {
    const orderSale = (overrides: Record<string, unknown> = {}) =>
      saleRow({ sale_type: 'ORDER', order_id: ORDER_ID, ...overrides });
    /** Le client de la commande (compte servi par le jeu `customers`) : droit au crédit, plafond, encours. */
    const setCustomer = async (patch: Record<string, unknown>) => {
      const customer = await getDb().projections.get(`customers:CUSTOMER:${IDS.customer}`);
      await getDb().projections.put({
        ...customer!,
        data: { ...(customer!.data as Record<string, unknown>), ...patch },
      });
    };
    const noCredit = { credit_allowed: false, credit_limit_xaf: null };

    it('client sans crédit, vente à solde dû : avertit du reste dû et mène à l’encaissement ciblé, sans empêcher la saisie (le serveur refuse en ligne)', async () => {
      await setCustomer(noCredit);
      await getDb().projections.put(orderSale());
      renderAt(`/commandes/${ORDER_ID}/livrer`);
      const banner = await screen.findByText(/n’est pas entièrement payée/);
      expect(banner).toHaveTextContent('reste dû : 2 000 F CFA');
      expect(banner).toHaveTextContent('n’a pas droit au crédit');
      expect(banner).toHaveTextContent('le serveur refusera la livraison');
      expect(screen.getByRole('link', { name: 'Encaisser le reste dû' })).toHaveAttribute(
        'href',
        `/encaisser?client=${IDS.customer}&vente=${SALE_ID}`,
      );
      expect(screen.getByRole('button', { name: 'Enregistrer la livraison' })).toBeEnabled();
    });

    it('client sans crédit, hors ligne : la livraison sera enregistrée, mais signalée à la Finance', async () => {
      const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      try {
        await setCustomer(noCredit);
        await getDb().projections.put(orderSale());
        renderAt(`/commandes/${ORDER_ID}/livrer`);
        const banner = await screen.findByText(/n’est pas entièrement payée/);
        expect(banner).toHaveTextContent('reste dû : 2 000 F CFA');
        expect(banner).toHaveTextContent('signalée à la Finance');
        expect(banner).not.toHaveTextContent('le serveur refusera');
      } finally {
        offline.mockRestore();
      }
    });

    it('client autorisé au crédit, dans son plafond : livraison à crédit, une information et non un avertissement', async () => {
      // Le client du jeu : crédit autorisé, plafond de 50 000, encours de 12 000.
      await getDb().projections.put(orderSale());
      renderAt(`/commandes/${ORDER_ID}/livrer`);
      const banner = await screen.findByText(/Livraison à crédit/);
      expect(banner).toHaveTextContent('le reste dû (2 000 F CFA) reste à encaisser');
      expect(banner).toHaveTextContent('plafond de crédit du client (50 000 F CFA)');
      expect(screen.queryByText(/n’est pas entièrement payée/)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Encaisser le reste dû' })).toHaveAttribute(
        'href',
        `/encaisser?client=${IDS.customer}&vente=${SALE_ID}`,
      );
      expect(screen.getByRole('button', { name: 'Enregistrer la livraison' })).toBeEnabled();
    });

    it('client autorisé dont le plafond pourrait être dépassé : avertissement prudent (le serveur juge), en ligne puis hors ligne', async () => {
      await setCustomer({ credit_limit_xaf: 10_000 });
      await getDb().projections.put(orderSale());
      const online = renderAt(`/commandes/${ORDER_ID}/livrer`);
      const warning = await screen.findByText(/pourrait être dépassé/);
      expect(warning).toHaveTextContent('plafond de crédit de ce client (10 000 F CFA)');
      expect(warning).toHaveTextContent('reste dû : 2 000 F CFA, encours : 12 000 F CFA');
      expect(warning).toHaveTextContent('le serveur peut refuser la livraison');
      expect(screen.queryByText(/Livraison à crédit/)).not.toBeInTheDocument();
      online.unmount();

      const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      try {
        renderAt(`/commandes/${ORDER_ID}/livrer`);
        const offlineWarning = await screen.findByText(/pourrait être dépassé/);
        expect(offlineWarning).toHaveTextContent('signalée à la Finance');
      } finally {
        offline.mockRestore();
      }
    });

    it('crédit à la livraison interdit par `sales.delivery_on_credit_allowed` : le client autorisé paie d’abord, sans qu’on lui reproche un droit au crédit absent', async () => {
      await getDb().projections.put(orderSale());
      await getDb().projections.put(meSettingRow('sales.delivery_on_credit_allowed', false));
      renderAt(`/commandes/${ORDER_ID}/livrer`);
      const banner = await screen.findByText(/n’est pas entièrement payée/);
      expect(banner).toHaveTextContent('le serveur refusera la livraison');
      expect(banner).not.toHaveTextContent('droit au crédit');
      expect(screen.queryByText(/Livraison à crédit/)).not.toBeInTheDocument();
    });

    it('rien d’impayé de connu, ou paramètre `sales.delivery_requires_full_payment` faux : aucun avertissement', async () => {
      // Vente soldée.
      await getDb().projections.put(orderSale({ balance_due_xaf: 0, payment_status: 'PAID' }));
      const first = renderAt(`/commandes/${ORDER_ID}/livrer`);
      await screen.findByLabelText('Quantité remise (U)');
      expect(screen.queryByText(/entièrement payée/)).not.toBeInTheDocument();
      first.unmount();

      // Vente à solde dû, mais l'exigence est levée pour tous.
      await getDb().projections.put(orderSale());
      await getDb().projections.put(meSettingRow('sales.delivery_requires_full_payment', false));
      renderAt(`/commandes/${ORDER_ID}/livrer`);
      await screen.findByLabelText('Quantité remise (U)');
      expect(screen.queryByText(/entièrement payée/)).not.toBeInTheDocument();
    });

    it('l’encaissement ciblé saisi sur l’appareil retire l’avertissement', async () => {
      await getDb().projections.put(orderSale());
      await getDb().outbox.put({
        command_id: '01900000-0000-7000-8000-0000000009c1',
        device_seq: 1,
        author_user_id: IDS.user,
        command_type: 'sales.payment.record',
        command_version: 1,
        aggregate_type: 'CUSTOMER_PAYMENT',
        aggregate_id: '01900000-0000-7000-8000-0000000009c2',
        payload: {
          customerId: IDS.customer,
          methodCode: 'ESPECES',
          amountXaf: 2000,
          allocations: [{ saleId: SALE_ID, amountXaf: 2000 }],
        },
        occurred_at: '2026-10-14T08:00:00.000Z',
        client_created_at: '2026-10-14T08:00:00.000Z',
        captured_offline: false,
        depends_on: [],
        status: 'PENDING_SYNC',
        attempts: 0,
      } as never);
      renderAt(`/commandes/${ORDER_ID}/livrer`);
      await screen.findByLabelText('Quantité remise (U)');
      expect(screen.queryByText(/entièrement payée/)).not.toBeInTheDocument();
    });
  });
});

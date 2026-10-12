import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { DeliverScreen } from './DeliverScreen.js';
import {
  IDS,
  ORDER_ID,
  ORDER_LINE_ID,
  orderRow,
  posCashAccountRow,
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

  it('commande servie au PDV, caisse fermée : en ligne, acompte en espèces bloqué (BR-DIS-005)', async () => {
    await getDb().projections.put(posCashAccountRow());
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

  it('commercial sans la caisse du PDV : acompte en espèces au PDV rappelé, sans blocage ni lien', async () => {
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
});

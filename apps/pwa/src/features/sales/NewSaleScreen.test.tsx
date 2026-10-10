import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from './fixtures.js';
import { NewSaleScreen } from './NewSaleScreen.js';

// Le moteur de synchronisation n'est pas démarré dans les tests (module du service worker).
vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

function renderScreen() {
  return render(
    <MemoryRouter>
      <NewSaleScreen />
    </MemoryRouter>,
  );
}

async function addEggs(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '+ Ajouter un article' }));
  await user.click(screen.getByRole('button', { name: /Œufs de table/ }));
}

describe('NewSaleScreen (ECR-VEN-01)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('en ligne : emplacement prérempli, prix catalogue, encaissement au total, vente dans l’outbox', async () => {
    await seedSalesFixtures(getDb());
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText('Comptoir Yaoundé')).toBeInTheDocument();
    expect(screen.getByText('Client de passage')).toBeInTheDocument();

    await addEggs(user);
    const line = screen.getByRole('listitem', { name: 'Œufs de table' });
    expect(within(line).getByText(/Prix unitaire : 100 F CFA/)).toBeInTheDocument();
    const quantity = within(line).getByLabelText('Quantité');
    await user.clear(quantity);
    await user.type(quantity, '3');
    expect(screen.getByTestId('sale-total')).toHaveTextContent('300 F CFA');
    expect(screen.getByLabelText('Montant encaissé (F CFA)')).toHaveValue('300');

    await user.click(screen.getByRole('button', { name: 'Enregistrer la vente' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Vente en cours d’envoi');

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'sales.sale.record',
      aggregate_type: 'SALE',
      author_user_id: IDS.user,
      captured_offline: false,
      payload: {
        fromLocationId: IDS.pos,
        channelCode: 'POINT_DE_VENTE',
        lines: [
          {
            productId: IDS.eggs,
            quantity: 3,
            unitCode: 'U',
            quantityBase: 3,
            listUnitPriceXaf: 100,
            priceRuleId: IDS.ruleEggs,
            unitPriceXaf: 100,
          },
        ],
        payments: [{ methodCode: 'ESPECES', amountXaf: 300 }],
      },
    });
  });

  it('client de passage : paiement partiel refusé ; client identifié : reste dû affiché', async () => {
    await seedSalesFixtures(getDb());
    const user = userEvent.setup();
    renderScreen();
    await addEggs(user);
    const amount = screen.getByLabelText('Montant encaissé (F CFA)');
    await user.clear(amount);
    await user.type(amount, '50');
    expect(screen.getByText(/Un client de passage paie la totalité/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Changer' }));
    await user.type(screen.getByPlaceholderText(/Rechercher un client/), '699 11');
    await user.click(screen.getByRole('button', { name: /Boutique Mvog-Mbi/ }));
    expect(screen.getByText('Reste dû : 50 F CFA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeEnabled();
  });

  it('moyen de paiement à référence : référence exigée', async () => {
    await seedSalesFixtures(getDb());
    const user = userEvent.setup();
    renderScreen();
    await addEggs(user);
    await user.selectOptions(screen.getByLabelText('Moyen de paiement'), 'MOBILE_MONEY_ORANGE');
    expect(screen.getByText(/La référence de la transaction est obligatoire/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Référence de la transaction'), 'OM-123');
    expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeEnabled();
  });

  it('hors ligne sur un emplacement partagé sans quota : vente bloquée sur l’appareil (AV-025)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await seedSalesFixtures(getDb());
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Hors ligne : la vente sera enregistrée/)).toBeInTheDocument();
    await addEggs(user);
    expect(screen.getByText(/Aucune allocation pour cet appareil/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeDisabled();
  });

  it('hors ligne sur un stock à garde exclusive : vente enregistrée sur le téléphone', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await seedSalesFixtures(getDb(), { posCustody: 'EXCLUSIVE_USER' });
    const user = userEvent.setup();
    renderScreen();
    await addEggs(user);
    const quantity = within(screen.getByRole('listitem', { name: 'Œufs de table' })).getByLabelText(
      'Quantité',
    );
    await user.clear(quantity);
    await user.type(quantity, '301');
    expect(screen.getByText(/Stock insuffisant sur cet appareil/)).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '2');

    await user.click(screen.getByRole('button', { name: 'Enregistrer la vente' }));
    expect(
      await screen.findByText(
        'Vente enregistrée sur ce téléphone, elle sera envoyée dès le retour du réseau.',
      ),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect((await getDb().outbox.toArray())[0]).toMatchObject({
        captured_offline: true,
        status: 'LOCAL_ONLY',
      }),
    );
  });
});

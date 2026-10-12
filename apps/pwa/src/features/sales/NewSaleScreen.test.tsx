import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import {
  allocationRow,
  cashSessionRow,
  IDS,
  meSettingRow,
  posCashAccountRow,
  seedSalesFixtures,
} from './fixtures.js';
import { NewSaleScreen } from './NewSaleScreen.js';
import { FixedClock } from '@gic/domain';
import { rememberNavigation } from '../navigation/navigation-store.js';

// Le moteur de synchronisation n'est pas démarré dans les tests (module du service worker).
vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

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

  it('client choisi absent de l’appareil : vente bloquée tant qu’un client n’est pas choisi', async () => {
    await seedSalesFixtures(getDb());
    const user = userEvent.setup();
    render(
      <MemoryRouter
        initialEntries={['/ventes/nouvelle?client=01900000-0000-7000-8000-0000000000ee']}
      >
        <NewSaleScreen />
      </MemoryRouter>,
    );
    await addEggs(user);
    expect(screen.getByRole('alert')).toHaveTextContent(/n’est plus sur ce téléphone/);
    expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Vendre sans client' }));
    expect(screen.queryByText(/n’est plus sur ce téléphone/)).not.toBeInTheDocument();
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

  it('vendeur de PDV : pas de modification de prix (pas de `sales.price.override`)', async () => {
    await seedSalesFixtures(getDb());
    await rememberNavigation(
      getDb(),
      new FixedClock(new Date('2026-10-10T08:00:00.000Z')),
      IDS.user,
      {
        user: { fullName: 'Awa', roles: ['VENDEUR_PDV'] },
        sections: [],
      },
    );
    const user = userEvent.setup();
    renderScreen();
    await addEggs(user);
    const line = screen.getByRole('listitem', { name: 'Œufs de table' });
    expect(within(line).getByText(/Prix unitaire : 100 F CFA/)).toBeInTheDocument();
    expect(
      within(line).queryByRole('button', { name: 'Modifier le prix' }),
    ).not.toBeInTheDocument();
    await getDb().navigation.clear();
  });

  it('mobile money avec deux comptes connus : compte de réception à choisir (AV-218)', async () => {
    await seedSalesFixtures(getDb());
    for (const id of ['om', 'mtn']) {
      await getDb().projections.put({
        key: `cash:CASH_ACCOUNT:${id}`,
        dataset: 'cash',
        entity_type: 'CASH_ACCOUNT',
        entity_id: id,
        scope_type: 'USER',
        scope_id: IDS.user,
        row_version: 1,
        seq: 1,
        data: {
          id,
          code: id.toUpperCase(),
          name: `Compte ${id.toUpperCase()}`,
          account_type: 'MOBILE_MONEY',
          site_id: null,
          holder_user_id: null,
          responsible_user_id: IDS.user,
          status: 'ACTIVE',
        },
      });
    }
    const user = userEvent.setup();
    renderScreen();
    await addEggs(user);
    await user.selectOptions(screen.getByLabelText('Moyen de paiement'), 'MOBILE_MONEY_ORANGE');
    await user.type(screen.getByLabelText('Référence de la transaction'), 'OM-1');
    expect(screen.getByText('Choisissez le compte qui reçoit le paiement.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Compte de réception'), 'om');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la vente' }));
    const [command] = await getDb().outbox.toArray();
    expect((command?.payload as { payments: unknown[] }).payments).toEqual([
      { methodCode: 'MOBILE_MONEY_ORANGE', amountXaf: 100, reference: 'OM-1', cashAccountId: 'om' },
    ]);
  });

  it('caisse du PDV fermée : « Ouvrir la caisse » proposé d’abord ; en ligne, espèces bloquées (BR-DIS-005)', async () => {
    await seedSalesFixtures(getDb());
    await getDb().projections.put(posCashAccountRow());
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    const prompt = await screen.findByText(
      'Caisse du point de vente fermée : ouvrez-la avant d’encaisser en espèces.',
    );
    expect(prompt).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ouvrir la caisse' })).toHaveAttribute(
      'href',
      '/caisse',
    );
    await addEggs(user);
    expect(
      screen.getByText(/Encaissement en espèces impossible sans caisse ouverte/),
    ).toBeInTheDocument();
    const record = screen.getByRole('button', { name: 'Enregistrer la vente' });
    expect(record).toBeDisabled();
    // Autre moyen de paiement : la vente reste possible.
    await user.selectOptions(screen.getByLabelText('Moyen de paiement'), 'MOBILE_MONEY_ORANGE');
    await user.type(screen.getByLabelText('Référence de la transaction'), 'OM-9');
    await waitFor(() => expect(record).toBeEnabled());
    unmount();

    // Caisse ouverte : ni invite ni blocage.
    await getDb().projections.put(cashSessionRow());
    renderScreen();
    await addEggs(user);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeEnabled(),
    );
    expect(screen.queryByText(/Caisse du point de vente fermée/)).not.toBeInTheDocument();
  });

  it('hors ligne, caisse fermée : la vente en espèces est enregistrée, l’invite l’annonce signalée (AV-305)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await seedSalesFixtures(getDb(), { posCustody: 'EXCLUSIVE_USER' });
    await getDb().projections.put(posCashAccountRow());
    const user = userEvent.setup();
    renderScreen();
    expect(
      await screen.findByText(
        /Aucune caisse ouverte sur ce téléphone : un encaissement en espèces/,
      ),
    ).toBeInTheDocument();
    await addEggs(user);
    const record = screen.getByRole('button', { name: 'Enregistrer la vente' });
    await waitFor(() => expect(record).toBeEnabled());
    await user.click(record);
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
  });

  it('hors ligne sur un emplacement partagé sans quota : vente bloquée sur l’appareil (AV-025)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await seedSalesFixtures(getDb());
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Hors ligne : la vente sera enregistrée/)).toBeInTheDocument();
    await addEggs(user);
    expect(
      screen.getByText(
        /Œufs de table : aucun quota pour ce téléphone sur cet emplacement ; la vente hors ligne n’est pas possible\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeDisabled();
  });

  it('AT-003 : hors ligne, quota du téléphone affiché ; au-delà bloqué, dans le reste enregistré, puis épuisé', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await seedSalesFixtures(getDb());
    await getDb().projections.put(
      allocationRow({ quantity_remaining: '30.000', valid_until: '2099-12-31T22:59:59.999Z' }),
    );
    const user = userEvent.setup();
    renderScreen();
    await addEggs(user);
    const quantity = within(screen.getByRole('listitem', { name: 'Œufs de table' })).getByLabelText(
      'Quantité',
    );
    await user.clear(quantity);
    await user.type(quantity, '31');
    expect(
      screen.getByText('Œufs de table : quota dépassé, il vous reste 30 U, 31 demandé(s).'),
    ).toBeInTheDocument();
    const record = screen.getByRole('button', { name: 'Enregistrer la vente' });
    expect(record).toBeDisabled();
    const quotaBlock = screen.getByRole('region', { name: 'Quota de ce téléphone' });
    expect(quotaBlock).toHaveTextContent(
      /Œufs de table : 30 U restant\(s\) sur votre quota, jusqu’au/,
    );
    await user.clear(quantity);
    await user.type(quantity, '30');
    await waitFor(() => expect(record).toBeEnabled());
    await user.click(record);
    await waitFor(async () =>
      expect((await getDb().outbox.toArray())[0]).toMatchObject({
        command_type: 'sales.sale.record',
        payload: { lines: [expect.objectContaining({ quantityBase: 30 })] },
      }),
    );

    // La vente en attente réduit le reste : une unité de plus est refusée.
    await user.click(await screen.findByRole('button', { name: 'Nouvelle vente' }));
    await addEggs(user);
    expect(
      await screen.findByText('Œufs de table : quota dépassé, il vous reste 0 U, 1 demandé(s).'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeDisabled();
  });

  it('AT-003 : dépassement du quota autorisé par le site : vente possible, signalée', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await seedSalesFixtures(getDb());
    await getDb().projections.bulkPut([
      allocationRow({ quantity_remaining: '30.000', valid_until: null }),
      meSettingRow('sales.offline_over_allocation_allowed', true, { type: 'SITE', id: IDS.site }),
    ]);
    const user = userEvent.setup();
    renderScreen();
    await addEggs(user);
    const quantity = within(screen.getByRole('listitem', { name: 'Œufs de table' })).getByLabelText(
      'Quantité',
    );
    await user.clear(quantity);
    await user.type(quantity, '31');
    expect(
      screen.getByText(/vente au-delà du quota autorisée sur ce site \(quota dépassé\)/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Enregistrer la vente' })).toBeEnabled(),
    );
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
    expect(
      screen.getByText(
        'Œufs de table : stock insuffisant sur cet appareil, 300 U disponible(s), 301 demandé(s).',
      ),
    ).toBeInTheDocument();
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

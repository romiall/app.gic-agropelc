import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import {
  ALLOCATION_ID,
  allocationRow,
  cashSessionRow,
  IDS,
  pointOfSaleRow,
  posCashAccountRow,
  saleRow,
  seedSalesFixtures,
} from '../sales/fixtures.js';
import { PosHomeScreen } from './PosHomeScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
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

function renderScreen() {
  return render(
    <MemoryRouter>
      <PosHomeScreen />
    </MemoryRouter>,
  );
}

describe('Accueil du PDV (ECR-DIS-01)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([pointOfSaleRow(), posCashAccountRow(), saleRow()]);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : caisse fermée, ventes du jour, stock, quota libéré après confirmation', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().projections.put(
      allocationRow({ quantity_remaining: '30.000', valid_until: null }),
    );
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText('Comptoir Yaoundé')).toBeInTheDocument();
    const cash = screen.getByRole('region', { name: 'Caisse' });
    expect(
      within(cash).getByText('Caisse fermée : ouvrez-la avant d’encaisser en espèces.'),
    ).toBeInTheDocument();
    expect(within(cash).getByRole('link', { name: 'Ouvrir la caisse' })).toHaveAttribute(
      'href',
      '/caisse',
    );
    // Jamais d'attendu de caisse sur l'accueil (comptage à l'aveugle).
    expect(screen.queryByText(/Attendu/)).not.toBeInTheDocument();
    const sales = screen.getByRole('region', { name: 'Ventes du jour' });
    expect(
      within(sales).getByText(/1 vente, 7\s000 F CFA ; encaissé avec ces ventes : 5\s000 F CFA/),
    ).toBeInTheDocument();
    const stock = screen.getByRole('region', { name: 'Stock du point de vente' });
    expect(
      within(within(stock).getByRole('listitem', { name: 'Œufs de table' })).getByText(
        /Stock physique : 300 U \(hors ligne, la vente se fait dans vos quotas\)/,
      ),
    ).toBeInTheDocument();
    // Le tableau en ligne n'est pas proposé hors ligne.
    expect(screen.queryByRole('link', { name: 'Distribution par point de vente' })).toBeNull();

    const quotas = screen.getByRole('region', { name: 'Mes quotas sur ce téléphone' });
    const card = within(quotas).getByRole('listitem', { name: 'Œufs de table' });
    expect(within(card).getByText('Reste : 30 U.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Libérer le quota Œufs de table' }));
    expect(await getDb().outbox.count()).toBe(0);
    await user.click(
      within(card).getByRole('button', { name: 'Confirmer : rendre 30 U au stock commun' }),
    );
    expect(
      await screen.findByText(
        'Libération enregistrée sur ce téléphone ; elle sera envoyée au retour du réseau.',
      ),
    ).toBeInTheDocument();
    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.allocation.release',
      aggregate_type: 'STOCK_ALLOCATION',
      aggregate_id: ALLOCATION_ID,
      payload: { remainingBase: 30 },
    });
    expect(
      await within(quotas).findByText('Libération enregistrée, en attente d’envoi.'),
    ).toBeInTheDocument();
    expect(within(quotas).queryByRole('button', { name: /Libérer/ })).not.toBeInTheDocument();
  });

  it('caisse ouverte et quota échu ; en ligne, accès au tableau', async () => {
    await getDb().projections.bulkPut([
      cashSessionRow(),
      allocationRow({ quantity_remaining: '12.000', valid_until: '2026-10-09T22:59:59.999Z' }),
    ]);
    renderScreen();
    const cash = await screen.findByRole('region', { name: 'Caisse' });
    expect(within(cash).getByText(/Caisse ouverte depuis le .* par vous\./)).toBeInTheDocument();
    expect(within(cash).getByRole('link', { name: 'Clôturer la caisse' })).toBeInTheDocument();
    expect(
      screen.getByText('Quota échu : libérez-le pour rendre le reste au stock commun.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Distribution par point de vente' })).toHaveAttribute(
      'href',
      '/pdv/distribution',
    );
  });

  it('emplacement de vente exclusif : disponible sur ce téléphone', async () => {
    await seedSalesFixtures(getDb(), { posCustody: 'EXCLUSIVE_USER' });
    renderScreen();
    const stock = await screen.findByRole('region', { name: 'Stock du point de vente' });
    expect(
      within(within(stock).getByRole('listitem', { name: 'Œufs de table' })).getByText(
        'Disponible sur ce téléphone : 300 U',
      ),
    ).toBeInTheDocument();
  });

  it('appareil signalé : quota non libérable, révocation annoncée ; aucun PDV servi', async () => {
    await getDb().projections.put(allocationRow({ revocation_pending: true }));
    const { unmount } = renderScreen();
    expect(await screen.findByText(/Ce téléphone est signalé/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Libérer/ })).not.toBeInTheDocument();
    unmount();

    await getDb().projections.delete(`org:POINT_OF_SALE:${IDS.site}`);
    renderScreen();
    expect(await screen.findByText(/Aucun point de vente sur ce téléphone/)).toBeInTheDocument();
  });
});

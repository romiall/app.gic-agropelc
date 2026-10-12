import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import type { OutboxCommand } from '../../storage/db.js';
import {
  ALLOCATION_ID,
  allocationRow,
  CASH_SESSION_ID,
  cashSessionRow,
  IDS,
  pointOfSaleRow,
  posCashAccountRow,
  saleRow,
  seedSalesFixtures,
  stockRow,
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

const DEVICE = '01900000-0000-7000-8000-0000000000d0';
const OTHER_USER = '01900000-0000-7000-8000-000000000002';

function outboxCommand(overrides: Partial<OutboxCommand>): OutboxCommand {
  return {
    command_id: '01900000-0000-7000-8000-0000000000f1',
    device_seq: 1,
    command_type: 'inventory.loss.declare',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'LOSS',
    aggregate_id: '01900000-0000-7000-8000-0000000000f2',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:00:00.000Z',
    client_created_at: '2026-10-10T08:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {},
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
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
    await getDb().navigation.clear();
  });

  it('hors ligne : caisse fermée, ventes du jour, stock, quota libéré après confirmation', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await rememberRoles(['VENDEUR_PDV']);
    await getDb().projections.put(
      allocationRow({ quantity_remaining: '30.000', valid_until: null }),
    );
    // Perte de 8 saisie sur ce téléphone, pas encore envoyée : elle réduit le quota.
    await getDb().outbox.put(
      outboxCommand({
        payload: { locationId: IDS.pos, productId: IDS.eggs, quantityBase: 8 },
      }),
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
    const sales = screen.getByRole('region', { name: 'Ventes du jour' });
    expect(
      within(sales).getByText(
        /1 vente, 7\s000 F CFA ; encaissé affecté à cette vente : 5\s000 F CFA/,
      ),
    ).toBeInTheDocument();
    const stock = screen.getByRole('region', { name: 'Stock du point de vente' });
    expect(
      within(within(stock).getByRole('listitem', { name: 'Œufs de table' })).getByText(
        /Stock physique : 292 U \(hors ligne, la vente se fait dans vos quotas\)/,
      ),
    ).toBeInTheDocument();
    // Le tableau en ligne n'est pas proposé hors ligne.
    expect(screen.queryByRole('link', { name: 'Distribution par point de vente' })).toBeNull();

    const quotas = screen.getByRole('region', { name: 'Mes quotas sur ce téléphone' });
    const card = within(quotas).getByRole('listitem', { name: 'Œufs de table' });
    expect(within(card).getByText('Reste : 22 U.')).toBeInTheDocument();
    const arm = within(card).getByRole('button', { name: 'Libérer le quota Œufs de table' });
    // Un double toucher arme la confirmation sans la donner ; « Annuler » la retire.
    await user.dblClick(arm);
    expect(await getDb().outbox.count()).toBe(1);
    expect(arm).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Annuler' }));
    expect(within(card).queryByRole('button', { name: /^Confirmer/ })).not.toBeInTheDocument();
    await user.click(arm);
    await user.click(
      within(card).getByRole('button', { name: 'Confirmer : rendre 22 U au stock commun' }),
    );
    expect(
      await screen.findByText(
        'Libération enregistrée sur ce téléphone ; elle sera envoyée au retour du réseau.',
      ),
    ).toBeInTheDocument();
    const [command] = await getDb()
      .outbox.filter((candidate) => candidate.command_type === 'inventory.allocation.release')
      .toArray();
    expect(command).toMatchObject({
      aggregate_type: 'STOCK_ALLOCATION',
      aggregate_id: ALLOCATION_ID,
      payload: { remainingBase: 22 },
    });
    expect(
      await within(quotas).findByText('Libération enregistrée, en attente d’envoi.'),
    ).toBeInTheDocument();
    // Le reste montré reste celui que la libération déclare, pas le reste servi.
    expect(within(card).getByText('Reste : 22 U.')).toBeInTheDocument();
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
    // Jamais d'attendu de caisse sur l'accueil, même caisse ouverte (comptage à l'aveugle, AV-304).
    expect(within(cash).queryByText(/Attendu|F CFA/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Quota échu : libérez-le pour rendre le reste au stock commun.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Distribution par point de vente' })).toHaveAttribute(
      'href',
      '/pdv/distribution',
    );
  });

  it('PDV par défaut : celui dont ce téléphone est l’appareil désigné ; emplacement confié à un autre', async () => {
    const AKWA_SITE = '01900000-0000-7000-8000-0000000000a1';
    const AKWA = '01900000-0000-7000-8000-0000000000a2';
    const db = getDb();
    const own = await db.projections.get(`location:LOCATION:${IDS.pos}`);
    await db.projections.bulkPut([
      {
        ...own!,
        data: {
          ...(own!.data as object),
          custody_mode: 'EXCLUSIVE_DEVICE',
          designated_device_id: DEVICE,
        },
      },
      {
        ...own!,
        key: `location:LOCATION:${AKWA}`,
        entity_id: AKWA,
        data: {
          ...(own!.data as object),
          id: AKWA,
          site_id: AKWA_SITE,
          code: 'PDV-AKW-POS',
          // Premier par ordre alphabétique, confié à un autre téléphone.
          name: 'Akwa',
          custody_mode: 'EXCLUSIVE_DEVICE',
          designated_device_id: '01900000-0000-7000-8000-0000000000d9',
        },
      },
      pointOfSaleRow({ site_id: AKWA_SITE, sales_location_id: AKWA }),
      stockRow(AKWA, IDS.eggs, '50.000'),
    ]);
    const user = userEvent.setup();
    renderScreen();
    const select = await screen.findByLabelText('Point de vente');
    expect(select).toHaveValue(IDS.site);
    const stock = screen.getByRole('region', { name: 'Stock du point de vente' });
    expect(
      within(within(stock).getByRole('listitem', { name: 'Œufs de table' })).getByText(
        'Disponible sur ce téléphone : 300 U',
      ),
    ).toBeInTheDocument();
    await user.selectOptions(select, AKWA_SITE);
    expect(
      await screen.findByText(
        'Stock physique : 50 U (confié à un autre téléphone : pas de vente hors ligne depuis celui-ci)',
      ),
    ).toBeInTheDocument();
  });

  it('tablette partagée : clôture d’un autre utilisateur pas encore envoyée, pas d’ouverture proposée', async () => {
    await getDb().projections.put(cashSessionRow({ opened_by: OTHER_USER }));
    await getDb().outbox.put(
      outboxCommand({
        command_type: 'finance.cash_session.close',
        aggregate_type: 'CASH_SESSION',
        aggregate_id: CASH_SESSION_ID,
        author_user_id: OTHER_USER,
        payload: { countedXaf: 18_000 },
      }),
    );
    renderScreen();
    const cash = await screen.findByRole('region', { name: 'Caisse' });
    expect(
      within(cash).getByText(/Clôture saisie sur cette tablette par un autre utilisateur/),
    ).toBeInTheDocument();
    expect(within(cash).queryByRole('link')).not.toBeInTheDocument();
  });

  it('libération réservée aux rôles qui la détiennent (CTE, VEN)', async () => {
    await rememberRoles(['MAGASINIER']);
    await getDb().projections.put(allocationRow());
    renderScreen();
    const quotas = await screen.findByRole('region', { name: 'Mes quotas sur ce téléphone' });
    expect(await within(quotas).findByText(/Reste :/)).toBeInTheDocument();
    expect(within(quotas).queryByRole('button', { name: /Libérer/ })).not.toBeInTheDocument();
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

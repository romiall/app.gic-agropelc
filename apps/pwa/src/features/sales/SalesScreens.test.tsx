import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { IDS, SALE_ID, saleRow, seedSalesFixtures } from './fixtures.js';
import { SaleDetailScreen } from './SaleDetailScreen.js';
import { SalesListScreen } from './SalesListScreen.js';

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
  }),
}));

const PENDING_SALE = '01900000-0000-7000-8000-0000000000c1';

function pendingSaleCommand(): OutboxCommand {
  return {
    command_id: '01900000-0000-7000-8000-0000000000d1',
    device_seq: 1,
    command_type: 'sales.sale.record',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'SALE',
    aggregate_id: PENDING_SALE,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:58:00.000Z',
    client_created_at: '2026-10-10T08:58:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {
      fromLocationId: IDS.pos,
      lines: [
        {
          productId: IDS.eggs,
          quantity: 1,
          unitCode: 'PLATEAU',
          quantityBase: 30,
          unitPriceXaf: 100,
        },
      ],
      payments: [{ methodCode: 'ESPECES', amountXaf: 3000 }],
    },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
  };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/ventes" element={<SalesListScreen />} />
        <Route path="/ventes/:saleId" element={<SaleDetailScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Ventes récentes et détail (ECR-VEN-05)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put(saleRow());
    await db.outbox.put(pendingSaleCommand());
  });

  afterEach(async () => {
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('liste : vente du serveur et vente de l’appareil en attente, la plus récente d’abord', async () => {
    renderAt('/ventes');
    const rows = await screen.findAllByRole('link', { name: /Ouvrir la vente/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('En attente du numéro');
    expect(rows[0]).toHaveTextContent('Client de passage');
    expect(rows[0]).toHaveTextContent('3 000 F CFA');
    expect(rows[0]).toHaveTextContent('En attente d’envoi');
    expect(rows[1]).toHaveTextContent('VTE-2026-000123');
    expect(rows[1]).toHaveTextContent('Boutique Mvog-Mbi');
    expect(rows[1]).toHaveTextContent('Payée en partie');
    expect(rows[1]).toHaveAttribute('href', `/ventes/${SALE_ID}`);
  });

  it('reçu : lignes, totaux, client, vendeur', async () => {
    renderAt(`/ventes/${SALE_ID}`);
    const receipt = await screen.findByRole('article', { name: /Reçu VTE-2026-000123/ });
    expect(within(receipt).getByText('Poulet de chair')).toBeInTheDocument();
    expect(within(receipt).getByText('2 U × 3 500 F CFA')).toBeInTheDocument();
    expect(within(receipt).getByText('Reste dû')).toBeInTheDocument();
    expect(within(receipt).getByText('2 000 F CFA')).toBeInTheDocument();
    expect(within(receipt).getByText(/Boutique Mvog-Mbi · Vendeur : vous/)).toBeInTheDocument();
  });

  it('annulation directe d’une vente payée en partie : sort de la somme exigé, puis commande envoyée', async () => {
    const user = userEvent.setup();
    renderAt(`/ventes/${SALE_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Annuler la vente' }));
    expect(screen.getByText(/l’annulation est immédiate/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Confirmer l’annulation' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Commentaire'), 'Erreur de saisie');
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('Garder en avoir du client'));
    await user.click(submit);
    expect(await screen.findByText(/Annulation en cours d’envoi/)).toBeInTheDocument();
    const cancel = (await getDb().outbox.toArray()).find(
      (command) => command.command_type === 'sales.sale.cancel',
    );
    expect(cancel).toMatchObject({
      aggregate_type: 'SALE_CANCELLATION',
      depends_on: [],
      payload: {
        saleId: SALE_ID,
        comment: 'Erreur de saisie',
        paymentTreatment: 'CUSTOMER_CREDIT',
      },
    });
  });

  it('annulation d’une vente encore sur l’appareil : elle attend la vente (depends_on)', async () => {
    const user = userEvent.setup();
    renderAt(`/ventes/${PENDING_SALE}`);
    expect(
      await screen.findByRole('article', { name: /En attente du numéro/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Annuler la vente' }));
    await user.type(screen.getByLabelText('Commentaire'), 'Client parti');
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
    await screen.findByText(/Annulation en cours d’envoi|Annulation enregistrée sur ce téléphone/);
    const cancel = (await getDb().outbox.toArray()).find(
      (command) => command.command_type === 'sales.sale.cancel',
    );
    expect(cancel?.depends_on).toEqual(['01900000-0000-7000-8000-0000000000d1']);
    expect(cancel?.payload).toEqual({ saleId: PENDING_SALE, comment: 'Client parti' });
  });

  it('vente inconnue de l’appareil : message explicite', async () => {
    renderAt('/ventes/01900000-0000-7000-8000-0000000000ff');
    expect(await screen.findByText(/Vente introuvable sur cet appareil/)).toBeInTheDocument();
  });
});

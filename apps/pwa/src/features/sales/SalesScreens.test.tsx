import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

/** Appareil en lecture seule le temps de `run` : dernière synchronisation complète ancienne (AV-009). */
async function whileReadOnly(run: () => Promise<void>) {
  const db = getDb();
  const saved = await db.syncMeta.get('device');
  await db.syncMeta.put({
    key: 'device',
    device_id: saved?.device_id ?? '01900000-0000-7000-8000-0000000000d0',
    clock_skew_ms: null,
    last_sync_at: '2026-09-01T00:00:00.000Z',
  });
  try {
    await run();
  } finally {
    if (saved) await db.syncMeta.put(saved);
    else await db.syncMeta.delete('device');
  }
}

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

  it('depuis le signal (?anomalies=1) : les seules ventes du jour signalées, puis toutes (AV-255)', async () => {
    const other = (id: string, data: Record<string, unknown>) => {
      const base = saleRow({ id, ...data });
      return { ...base, key: base.key.replace(SALE_ID, id), entity_id: id };
    };
    const db = getDb();
    await db.projections.put(saleRow({ flags: ['STOCK_NEGATIVE', 'OUT_OF_SESSION'] }));
    // Signalée la veille, et signalée puis annulée : hors du signal du jour.
    await db.projections.put(
      other('01900000-0000-7000-8000-0000000000c7', {
        doc_number: 'VTE-2026-000120',
        occurred_at: '2026-10-09T10:00:00.000Z',
        flags: ['PRICE_MISMATCH'],
      }),
    );
    await db.projections.put(
      other('01900000-0000-7000-8000-0000000000c8', {
        doc_number: 'VTE-2026-000121',
        status: 'CANCELLED',
        flags: ['PRICE_MISMATCH'],
      }),
    );
    const user = userEvent.setup();
    renderAt('/ventes?anomalies=1');
    expect(
      await screen.findByText(/Ventes du jour signalées par le serveur \(1 sur cet appareil/),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole('link', { name: /Ouvrir la vente/ });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('VTE-2026-000123');
    expect(rows[0]).toHaveTextContent(
      'Signalé : Stock devenu négatif, Vente hors prise de service',
    );
    await user.click(screen.getByRole('button', { name: 'Toutes les ventes' }));
    expect(screen.getAllByRole('link', { name: /Ouvrir la vente/ })).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Ouvrir la vente VTE-2026-000120' })).toHaveTextContent(
      'Signalé : Prix différent du catalogue',
    );
  });

  it('depuis le signal, aucune vente signalée sur l’appareil : message explicite', async () => {
    renderAt('/ventes?anomalies=1');
    expect(
      await screen.findByText('Aucune vente du jour signalée sur cet appareil.'),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('link', { name: /Ouvrir la vente/ })).toHaveLength(0);
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
      // Annulation jugée directe : la vente ne réduit plus le quota en attendant la réponse.
      local_flags: ['EXPECTED_DIRECT_CANCEL'],
      payload: {
        saleId: SALE_ID,
        comment: 'Erreur de saisie',
        paymentTreatment: 'CUSTOMER_CREDIT',
      },
    });
  });

  it('lecture seule (AV-009) : annulation refusée et annoncée, rien n’est enregistré', async () => {
    await whileReadOnly(async () => {
      const user = userEvent.setup();
      renderAt(`/ventes/${SALE_ID}`);
      await user.click(await screen.findByRole('button', { name: 'Annuler la vente' }));
      await user.type(screen.getByLabelText('Commentaire'), 'Erreur de saisie');
      await user.click(screen.getByLabelText('Garder en avoir du client'));
      await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Lecture seule : aucune synchronisation depuis plus longtemps que l’autonomie permise\. Rien n’a été enregistré/,
      );
      expect(
        (await getDb().outbox.toArray()).some(
          (command) => command.command_type === 'sales.sale.cancel',
        ),
      ).toBe(false);
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

  it('tablette partagée : vente d’un autre utilisateur pas encore envoyée, annulation refusée jusqu’à son envoi', async () => {
    await getDb().outbox.put({
      ...pendingSaleCommand(),
      author_user_id: '01900000-0000-7000-8000-0000000000e8',
    });
    renderAt(`/ventes/${PENDING_SALE}`);
    const cancel = await screen.findByRole('button', { name: 'Annuler la vente' });
    expect(cancel).toBeDisabled();
    const hint = screen.getByText(/Opération saisie sur cette tablette par un autre utilisateur/);
    expect(cancel).toHaveAttribute('aria-describedby', hint.id);
    // Envoyée (même sans retour du tirage) : l'annulation redevient possible.
    await getDb().outbox.update('01900000-0000-7000-8000-0000000000d1', { status: 'SYNCED' });
    await waitFor(() => expect(cancel).toBeEnabled());
  });

  it('vente d’un compte absorbé depuis : au nom du compte conservé, encaissement sur lui', async () => {
    const ABSORBED = '01900000-0000-7000-8000-0000000000e9';
    const db = getDb();
    const kept = await db.projections.get(`customers:CUSTOMER:${IDS.customer}`);
    if (!kept) throw new Error('client de la fixture absent');
    await db.projections.put({
      ...kept,
      key: `customers:CUSTOMER:${ABSORBED}`,
      entity_id: ABSORBED,
      data: {
        ...kept.data,
        id: ABSORBED,
        stage: 'MERGED',
        display_name: 'Doublon',
        merged_into_id: IDS.customer,
      },
    });
    await db.projections.put(saleRow({ customer_id: ABSORBED }));
    renderAt(`/ventes/${SALE_ID}`);
    const receipt = await screen.findByRole('article', { name: /Reçu VTE-2026-000123/ });
    expect(within(receipt).getByText(/Boutique Mvog-Mbi · Vendeur : vous/)).toBeInTheDocument();
  });

  it('reçu : points signalés en français (code inconnu tel quel), « Encaisser le reste dû » ciblé sur la vente (MP-09)', async () => {
    await getDb().projections.put(
      saleRow({ flags: ['OUT_OF_SESSION', 'PRICE_MISMATCH', 'FUTUR'] }),
    );
    renderAt(`/ventes/${SALE_ID}`);
    expect(
      await screen.findByText(
        'Points signalés par le serveur : Vente hors prise de service, Prix différent du catalogue, FUTUR',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Encaisser le reste dû' })).toHaveAttribute(
      'href',
      `/encaisser?client=${IDS.customer}&vente=${SALE_ID}`,
    );
  });

  it('vente inconnue de l’appareil : message explicite', async () => {
    renderAt('/ventes/01900000-0000-7000-8000-0000000000ff');
    expect(await screen.findByText(/Vente introuvable sur cet appareil/)).toBeInTheDocument();
  });
});

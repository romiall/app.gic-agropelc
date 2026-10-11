import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { loadSalesReferences } from '../sales/references.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { checkLoss } from './loss.js';
import { LossScreen } from './LossScreen.js';
import { parseReceived } from './receive.js';

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

describe('Déclarer une perte (ECR-STK-04)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put({
      key: 'reason_code:REASON_CODE:r-casse',
      dataset: 'reason_code',
      entity_type: 'REASON_CODE',
      entity_id: 'r-casse',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: {
        id: 'r-casse',
        category: 'LOSS',
        code: 'CHUTE',
        label: 'Chute en manutention',
        loss_category: 'CASSE',
        requires_comment: false,
        is_active: true,
      },
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : perte en conditionnement convertie en unité de base, retirée du disponible local', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '2');
    await user.selectOptions(screen.getByLabelText('Unité'), 'PLATEAU');
    await user.click(screen.getByLabelText('Casse'));
    await user.selectOptions(screen.getByLabelText('Motif'), 'r-casse');
    await user.click(screen.getByRole('button', { name: 'Déclarer la perte' }));
    expect(await screen.findByText(/Perte enregistrée sur ce téléphone/)).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.loss.declare',
      aggregate_type: 'STOCK_LOSS',
      captured_offline: true,
      payload: {
        locationId: IDS.pos,
        productId: IDS.eggs,
        quantityBase: 60,
        unitCode: 'PLATEAU',
        quantity: 2,
        category: 'CASSE',
        reasonCodeId: 'r-casse',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(60);
  });

  it('au-delà du disponible : bloquée en ligne (BR-STK-017), signalée hors ligne (BR-STK-018)', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    // 4 poulets en stock.
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '5');
    await user.click(screen.getByLabelText('Casse'));
    expect(screen.getByRole('alert')).toHaveTextContent(/le serveur refuserait la perte/);
    expect(screen.getByRole('button', { name: 'Déclarer la perte' })).toBeDisabled();
    unmount();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '5');
    await user.click(screen.getByLabelText('Casse'));
    expect(screen.getByText(/sera tout de même enregistrée et signalée/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déclarer la perte' })).toBeEnabled();
  });

  it('en ligne, emplacement partagé entièrement alloué : la perte reste possible sur le physique', async () => {
    const db = getDb();
    const key = `stock:STOCK_BALANCE:${IDS.pos}:${IDS.eggs}`;
    const balance = await db.projections.get(key);
    if (!balance) throw new Error('solde de la fixture absent');
    await db.projections.put({
      ...balance,
      data: { ...balance.data, qty_allocated: '300.000' },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '5');
    await user.click(screen.getByLabelText('Casse'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déclarer la perte' })).toBeEnabled();
  });

  it('quantité hors de la borne numeric(14,3) : refusée sur l’appareil', () => {
    const draft = {
      productId: IDS.eggs,
      unitCode: 'PLATEAU',
      quantityText: '9999999999',
      category: 'CASSE' as const,
      reasonCodeId: '',
      lotId: '',
      comment: '',
    };
    expect(checkLoss(draft, { unitCode: 'PLATEAU', factorToBase: '30' }, []).issues).toEqual([
      'QUANTITY_INVALID',
    ]);
    expect(parseReceived('100000000000')).toBeNull();
    expect(parseReceived('99999999999.999')).toBe(99_999_999_999.999);
  });

  it('perte inexpliquée : commentaire obligatoire', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LossScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '1');
    await user.click(screen.getByLabelText('Perte inexpliquée'));
    expect(
      screen.getByText('Un commentaire est obligatoire pour cette perte.'),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Déclarer la perte' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Commentaire'), 'Constaté à l’ouverture');
    expect(submit).toBeEnabled();
  });
});

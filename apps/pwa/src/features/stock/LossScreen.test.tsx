import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { loadSalesReferences } from '../sales/references.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { LossScreen } from './LossScreen.js';

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

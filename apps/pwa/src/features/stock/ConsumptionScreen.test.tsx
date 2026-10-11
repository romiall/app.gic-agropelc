import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { ConsumptionScreen } from './ConsumptionScreen.js';

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
      <ConsumptionScreen />
    </MemoryRouter>,
  );
}

describe('Consommer un intrant (ECR-STK-08)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('hors ligne : consommation en conditionnement imputée au site, retirée du disponible', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Intrant'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité'), '1');
    await user.selectOptions(screen.getByLabelText('Unité'), 'PLATEAU');
    const submit = screen.getByRole('button', { name: 'Enregistrer la consommation' });
    expect(submit).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Nature du coût'), 'AUTRE_INTRANT');
    await user.click(submit);
    expect(
      await screen.findByText(/Consommation enregistrée sur ce téléphone/),
    ).toBeInTheDocument();

    const [command] = await getDb().outbox.toArray();
    expect(command).toMatchObject({
      command_type: 'inventory.consumption.record',
      aggregate_type: 'STOCK_CONSUMPTION',
      captured_offline: true,
      payload: {
        locationId: IDS.pos,
        productId: IDS.eggs,
        quantityBase: 30,
        unitCode: 'PLATEAU',
        quantity: 1,
        costObjectType: 'SITE',
        costObjectId: IDS.site,
        costType: 'AUTRE_INTRANT',
      },
    });
    const refs = await loadSalesReferences(getDb());
    expect(refs.pending.get(`${IDS.pos}:${IDS.eggs}`)).toBe(30);
  });

  it('en ligne : au-delà du stock, consommation bloquée', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Intrant'), IDS.chicken);
    await user.type(screen.getByLabelText('Quantité'), '5');
    await user.selectOptions(screen.getByLabelText('Nature du coût'), 'ALIMENT');
    expect(screen.getByRole('alert')).toHaveTextContent(/le serveur refuserait/);
    expect(screen.getByRole('button', { name: 'Enregistrer la consommation' })).toBeDisabled();
  });
});

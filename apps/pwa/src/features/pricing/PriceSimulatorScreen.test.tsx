import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { PriceSimulatorScreen } from './PriceSimulatorScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});

const SITE_RULE = '01900000-0000-7000-8000-0000000000f8';

describe('Simulateur de prix (ECR-PRX-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await seedSalesFixtures(db);
    const general = await db.projections.get(`price_rule:PRICE_RULE:${IDS.ruleEggs}`);
    if (!general) throw new Error('règle de la fixture absente');
    await db.projections.put({
      ...general,
      key: `price_rule:PRICE_RULE:${SITE_RULE}`,
      entity_id: SITE_RULE,
      data: { ...general.data, id: SITE_RULE, unit_price_xaf: 95, site_id: IDS.site },
    });
  });

  afterEach(async () => {
    cleanup();
    await getDb().projections.clear();
  });

  it('règle générale, puis règle du site plus précise avec la générale en explication', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PriceSimulatorScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.clear(screen.getByLabelText('Quantité (U)'));
    await user.type(screen.getByLabelText('Quantité (U)'), '30');
    const result = () => within(screen.getByRole('status'));
    expect(result().getByText(/100\sF\sCFA par U/)).toBeInTheDocument();
    expect(result().getByText(/Pour 30 U : 3\s000\sF\sCFA/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Site'), IDS.site);
    expect(result().getByText(/95\sF\sCFA par U/)).toBeInTheDocument();
    expect(result().getByText(/Règle retenue : site PDV/)).toBeInTheDocument();
    expect(
      result().getByText('Autres règles applicables (ordre du départage)'),
    ).toBeInTheDocument();
  });

  it('aucune règle applicable : le dire, la vente demanderait une dérogation', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PriceSimulatorScreen />
      </MemoryRouter>,
    );
    // Le poulet n'a qu'une règle propre au site.
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.chicken);
    expect(screen.getByText(/Aucune règle ne s’applique/)).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
const PROMO = '01900000-0000-7000-8000-0000000000f9';

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
    const result = () => within(screen.getByRole('status', { name: 'Prix appliqué' }));
    expect(result().getByText(/100\sF\sCFA par U/)).toBeInTheDocument();
    expect(result().getByText(/Pour 30 U : 3\s000\sF\sCFA/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Site'), IDS.site);
    expect(result().getByText(/95\sF\sCFA par U/)).toBeInTheDocument();
    expect(result().getByText(/Règle retenue : site PDV/)).toBeInTheDocument();
    expect(
      result().getByText('Autres règles applicables (ordre du départage)'),
    ).toBeInTheDocument();
    // La règle sans dimension est décrite comme générale.
    expect(result().getByText('règle générale')).toBeInTheDocument();
  });

  it('jour courant : prix à l’instant ; autre jour : à midi ; bandeau de prix anciens', async () => {
    const db = getDb();
    const general = await db.projections.get(`price_rule:PRICE_RULE:${IDS.ruleEggs}`);
    if (!general) throw new Error('règle de la fixture absente');
    // Promotion prioritaire qui s'arrête à 11 h (Douala) : en vigueur à 10 h, plus à midi.
    await db.projections.put({
      ...general,
      key: `price_rule:PRICE_RULE:${PROMO}`,
      entity_id: PROMO,
      data: {
        ...general.data,
        id: PROMO,
        unit_price_xaf: 80,
        priority: 2,
        valid_to: '2026-10-10T10:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PriceSimulatorScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Prix peut-être non à jour/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    const result = () => within(screen.getByRole('status', { name: 'Prix appliqué' }));
    expect(result().getByText(/80\sF\sCFA par U/)).toBeInTheDocument();
    expect(result().getByText(/Prix à l’instant/)).toBeInTheDocument();
    expect(result().getByText(/règle générale · priorité 2/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-11' } });
    expect(result().getByText(/100\sF\sCFA par U/)).toBeInTheDocument();
    expect(result().getByText(/Prix à 12 h/)).toBeInTheDocument();
  });

  it('quantité démesurée : refusée, ou total non calculable sans planter', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PriceSimulatorScreen />
      </MemoryRouter>,
    );
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const quantity = screen.getByLabelText('Quantité (U)');
    await user.clear(quantity);
    await user.type(quantity, '999999999999');
    expect(
      screen.getByText(/Quantité trop grande : 99\s999\s999\s999,999 au plus\./),
    ).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '99999999999');
    expect(screen.getByText(/Montant trop grand/)).toBeInTheDocument();
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

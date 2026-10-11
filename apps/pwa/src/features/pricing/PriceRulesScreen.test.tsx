import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { PriceRulesScreen } from './PriceRulesScreen.js';
import type { RuleView } from './rules.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
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

const rule = (overrides: Partial<RuleView>): RuleView => ({
  id: 'r-actif',
  code: 'OEUF-GEN',
  version: 1,
  productId: IDS.eggs,
  unitPriceXaf: 100,
  pricingUnitCode: 'U',
  zoneId: null,
  siteId: null,
  customerCategoryId: null,
  channelCode: null,
  minQuantity: null,
  commercialCampaignId: null,
  priority: 0,
  specificity: 0,
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
  status: 'ACTIVE',
  ...overrides,
});

const RULES = [
  rule({}),
  // Brouillon général : même priorité, même précision, période qui chevauche → conflit.
  rule({
    id: 'd-conflit',
    code: 'OEUF-GEN2',
    status: 'DRAFT',
    validFrom: '2026-10-11T00:00:00.000Z',
  }),
  // Brouillon du site : plus précis, pas de conflit.
  rule({
    id: 'd-site',
    code: 'OEUF-PDV',
    status: 'DRAFT',
    siteId: IDS.site,
    unitPriceXaf: 95,
    validFrom: '2026-10-11T00:00:00.000Z',
  }),
];

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
      <PriceRulesScreen />
    </MemoryRouter>,
  );
}

describe('Règles tarifaires (ECR-PRX-02)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
    vi.mocked(authorizedRequest).mockResolvedValue({ ok: true, data: { price_rules: RULES } });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
    await getDb().navigation.clear();
  });

  it('responsable commercial : règles lues en ligne, brouillon rédigé, nouvelle version sans code', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const active = within(await screen.findByRole('region', { name: 'En vigueur ou à venir' }));
    expect(active.getByText(/100\sF\sCFA par U/)).toBeInTheDocument();
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/price-rules?product_id=${IDS.eggs}`,
      { method: 'GET' },
    );
    expect(screen.getAllByText('Activation par la Direction.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Terminer' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nouvelle règle' }));
    await user.type(screen.getByLabelText('Code de la règle'), 'OEUF-GROS');
    await user.type(screen.getByLabelText('Prix par U (F)'), '110');
    await user.type(screen.getByLabelText('À partir de (en U, facultatif)'), '300');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    await screen.findByText(/Opération (en cours d’envoi|enregistrée)/);

    const newVersion = await screen.findByRole('button', { name: 'Nouvelle version' });
    await waitFor(() => expect(newVersion).toBeEnabled());
    await user.click(newVersion);
    const price = screen.getByLabelText('Prix par U (F)');
    expect(price).toHaveValue('100');
    await user.clear(price);
    await user.type(price, '105');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la nouvelle version' }));
    await screen.findByRole('button', { name: 'Nouvelle règle' });

    const [draft, supersede] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(draft).toMatchObject({
      command_type: 'pricing.rule.draft',
      aggregate_type: 'PRICE_RULE',
      payload: {
        productId: IDS.eggs,
        unitPriceXaf: 110,
        pricingUnitCode: 'U',
        minQuantity: 300,
        priority: 0,
        validFrom: '2026-10-10T09:10:00.000Z',
        code: 'OEUF-GROS',
      },
    });
    expect(supersede).toMatchObject({
      command_type: 'pricing.rule.supersede',
      payload: { unitPriceXaf: 105, supersedesRuleId: 'r-actif' },
    });
    expect((supersede?.payload as { code?: string }).code).toBeUndefined();
  });

  it('Direction : brouillon en conflit non activable, brouillon du site activé, fin avancée', async () => {
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const conflicting = await screen.findByRole('listitem', { name: 'OEUF-GEN2 v1' });
    expect(within(conflicting).getByText(/En conflit avec 1 règle active/)).toBeInTheDocument();
    expect(within(conflicting).getByRole('button', { name: 'Activer' })).toBeDisabled();
    const site = screen.getByRole('listitem', { name: 'OEUF-PDV v1' });
    await user.click(within(site).getByRole('button', { name: 'Activer' }));
    await screen.findByText(/Opération (en cours d’envoi|enregistrée)/);

    const active = screen.getByRole('listitem', { name: 'OEUF-GEN v1' });
    const end = await within(active).findByRole('button', { name: 'Terminer' });
    await waitFor(() => expect(end).toBeEnabled());
    await user.click(end);
    await user.click(within(active).getByRole('button', { name: 'Avancer la fin' }));
    await screen.findByRole('button', { name: 'Nouvelle règle' });

    const [activation, ending] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(activation).toMatchObject({
      command_type: 'pricing.rule.activate',
      aggregate_id: 'd-site',
      payload: {},
    });
    expect(ending).toMatchObject({
      command_type: 'pricing.rule.end',
      aggregate_id: 'r-actif',
      payload: { validTo: '2026-10-10T09:00:00.000Z' },
    });
  });

  it('hors ligne : écran en ligne seulement, aucune lecture', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/en ligne seulement/);
    expect(authorizedRequest).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { PriceRulesScreen } from './PriceRulesScreen.js';
import {
  checkRule,
  defaultValidFrom,
  endAllowed,
  isLatestVersion,
  predecessorOf,
  supersedeValidFrom,
  type RuleForm,
  type RuleView,
} from './rules.js';

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

const NOW = new Date('2026-10-10T09:00:00.000Z');
/** Lendemain 0 h à Douala. */
const TOMORROW = '2026-10-10T23:00:00.000Z';

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

const BASE_RULES = [
  rule({}),
  // Brouillon général d'une autre lignée : même priorité, même précision → conflit.
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
/** Règle d'un autre produit : son code est pris aussi. */
const OTHER_PRODUCT = rule({ id: 'r-poulet', code: 'POULET-GEN', productId: IDS.chicken });

let rules: RuleView[] = BASE_RULES;

function answer(path: string) {
  const url = new URL(path, 'http://local');
  const productId = url.searchParams.get('product_id');
  const all = [...rules, OTHER_PRODUCT];
  return {
    ok: true,
    data: { price_rules: productId ? all.filter((r) => r.productId === productId) : all },
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

/** Réponse définitive du serveur à la dernière commande de l'outbox. */
async function settleLast(status: 'SYNCED' | 'REJECTED' = 'SYNCED') {
  const [command] = await getDb().outbox.orderBy('device_seq').reverse().limit(1).toArray();
  if (!command) throw new Error('aucune commande');
  await getDb().outbox.update(command.command_id, {
    status,
    ...(status === 'SYNCED'
      ? { synced_at: '2026-10-10T09:00:05.000Z' }
      : { last_error: { code: 'PRICE_RULE_INVALID', message_fr: 'Canal inconnu.' } }),
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
    rules = BASE_RULES;
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => answer(path) as never);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
    await getDb().navigation.clear();
  });

  it('responsable commercial : code déjà pris refusé, brouillon pour demain, nouvelle version sans code', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const active = within(await screen.findByRole('region', { name: 'En vigueur ou à venir' }));
    expect(active.getByText(/100\sF\sCFA par U/)).toBeInTheDocument();
    expect(active.getByText(/Depuis le 1 sept\. 2026/)).toBeInTheDocument();
    expect(screen.getAllByText('Activation par la Direction.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Terminer' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nouvelle règle' }));
    await user.type(screen.getByLabelText('Code de la règle'), 'POULET-GEN');
    expect(
      await screen.findByText('Ce code est déjà celui d’une autre règle.'),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Code de la règle'));
    await user.type(screen.getByLabelText('Code de la règle'), 'OEUF-GROS');
    await user.type(screen.getByLabelText('Prix par U (F)'), '110');
    await user.type(screen.getByLabelText('À partir de (en U, facultatif)'), '300');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    await screen.findByText(/Opération (en cours d’envoi|enregistrée)/);
    // Rien d'autre tant que le serveur n'a pas répondu.
    const newVersion = await screen.findByRole('button', { name: 'Nouvelle version' });
    expect(newVersion).toBeDisabled();
    await settleLast();
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
        validFrom: TOMORROW,
        code: 'OEUF-GROS',
      },
    });
    expect(supersede).toMatchObject({
      command_type: 'pricing.rule.supersede',
      payload: { unitPriceXaf: 105, supersedesRuleId: 'r-actif', validFrom: TOMORROW },
    });
    expect((supersede?.payload as { code?: string }).code).toBeUndefined();
  });

  it('Direction : conflit bloquant, brouillon du site activé, fin avancée', async () => {
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
    await settleLast();

    const active = screen.getByRole('listitem', { name: 'OEUF-GEN v1' });
    const end = await within(active).findByRole('button', { name: 'Terminer' });
    await waitFor(() => expect(end).toBeEnabled());
    await user.click(end);
    // Une fin passée est refusée (SM-PRICE-RULE : nouvelle fin ≥ maintenant).
    const endInput = within(active).getByLabelText('Fin de validité (heure de Douala)');
    fireEvent.change(endInput, { target: { value: '2026-10-09T08:00' } });
    expect(within(active).getByRole('button', { name: 'Avancer la fin' })).toBeDisabled();
    fireEvent.change(endInput, { target: { value: '2026-10-10T10:00' } });
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

  it('nouvelle version en brouillon : pas de faux conflit avec la règle remplacée, pas de seconde version', async () => {
    rules = [
      rule({}),
      rule({ id: 'v2', version: 2, status: 'DRAFT', unitPriceXaf: 105, validFrom: TOMORROW }),
    ];
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const draft = await screen.findByRole('listitem', { name: 'OEUF-GEN v2' });
    expect(within(draft).queryByText(/En conflit/)).not.toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: 'Activer' })).toBeEnabled();
    const active = screen.getByRole('listitem', { name: 'OEUF-GEN v1' });
    expect(
      within(active).queryByRole('button', { name: 'Nouvelle version' }),
    ).not.toBeInTheDocument();
    expect(
      within(active).getByText('Une version plus récente existe déjà (brouillon compris).'),
    ).toBeInTheDocument();
  });

  it('règle de campagne : la nouvelle version garde la campagne ; refus du serveur : saisie reprise', async () => {
    rules = [rule({ commercialCampaignId: 'campagne-noel', priority: 100 })];
    await rememberRoles(['RESP_COMMERCIAL']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.click(await screen.findByRole('button', { name: 'Nouvelle version' }));
    expect(screen.getByText(/reste rattachée à la même campagne/)).toBeInTheDocument();
    const price = screen.getByLabelText('Prix par U (F)');
    await user.clear(price);
    await user.type(price, '85');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la nouvelle version' }));
    await screen.findByText(/Opération (en cours d’envoi|enregistrée)/);
    const [supersede] = await getDb().outbox.toArray();
    expect(supersede?.payload).toMatchObject({
      commercialCampaignId: 'campagne-noel',
      priority: 100,
      unitPriceXaf: 85,
    });

    await settleLast('REJECTED');
    await user.click(await screen.findByRole('button', { name: 'Reprendre la saisie' }));
    expect(screen.getByLabelText('Prix par U (F)')).toHaveValue('85');
  });

  it('rôles inconnus : aucune action de la Direction proposée', async () => {
    renderScreen();
    await userEvent.setup().selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await screen.findByRole('region', { name: 'Brouillons' });
    expect(screen.queryByRole('button', { name: 'Activer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Terminer' })).not.toBeInTheDocument();
  });

  it('hors ligne : écran en ligne seulement, aucune lecture', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/en ligne seulement/);
    expect(authorizedRequest).not.toHaveBeenCalled();
  });
});

describe('Règles tarifaires : gardes', () => {
  const form = (overrides: Partial<RuleForm>): RuleForm => ({
    code: 'X',
    unitPriceText: '100',
    pricingUnitCode: 'U',
    siteId: '',
    zoneId: '',
    customerCategoryId: '',
    channelCode: '',
    minQuantityText: '',
    priorityText: '0',
    commercialCampaignId: '',
    validFrom: '2026-10-11T00:00',
    validTo: '',
    notes: '',
    ...overrides,
  });

  it('bornes du prix, de la priorité et du seuil ; code pris', () => {
    const issues = (f: RuleForm) =>
      checkRule(f, { needsCode: true, takenCodes: new Set(['X']) }).issues;
    expect(issues(form({}))).toEqual(['CODE_TAKEN']);
    expect(issues(form({ code: 'Y', unitPriceText: '9007199254740993' }))).toEqual([
      'PRICE_INVALID',
    ]);
    expect(issues(form({ code: 'Y', priorityText: '3000000000' }))).toEqual(['PRIORITY_INVALID']);
    expect(issues(form({ code: 'Y', minQuantityText: '123456789012' }))).toEqual([
      'MIN_QUANTITY_INVALID',
    ]);
  });

  it('nouvelle version dans la période de la règle remplacée ; site dans la zone', () => {
    const superseded = {
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: '2026-12-31T23:00:00.000Z',
    };
    const check = (validFrom: string) =>
      checkRule(form({ validFrom }), { needsCode: false, superseded }).issues;
    expect(check('2026-10-11T00:00')).toEqual([]);
    // Fin de la règle remplacée comprise (31/12 à minuit, heure de Douala), au-delà refusé.
    expect(check('2027-01-01T00:00')).toEqual([]);
    expect(check('2027-01-01T00:01')).toEqual(['OUTSIDE_SUPERSEDED']);
    expect(check('2026-09-01T01:00')).toEqual(['OUTSIDE_SUPERSEDED']);
    const zones = new Map([
      ['pays', { id: 'pays', parent_id: null, name: 'Cameroun', depth: 1 }],
      ['ydé', { id: 'ydé', parent_id: 'pays', name: 'Yaoundé', depth: 2 }],
      ['dla', { id: 'dla', parent_id: 'pays', name: 'Douala', depth: 2 }],
    ]);
    const sites = new Map([
      [
        'pdv',
        { id: 'pdv', code: 'P', name: 'PDV', site_type: 'POS', zone_id: 'ydé', status: 'ACTIVE' },
      ],
    ]);
    const zoneCheck = (zoneId: string) =>
      checkRule(form({ siteId: 'pdv', zoneId }), { needsCode: false, sites, zones }).issues;
    expect(zoneCheck('pays')).toEqual([]);
    expect(zoneCheck('dla')).toEqual(['SITE_NOT_IN_ZONE']);
  });

  it('lignée, dates proposées et fin admise', () => {
    const v1 = rule({});
    const v2 = rule({ id: 'v2', version: 2, status: 'DRAFT' });
    expect(predecessorOf(v2, [v1, v2])).toBe(v1);
    expect(isLatestVersion(v1, [v1, v2])).toBe(false);
    expect(isLatestVersion(v2, [v1, v2])).toBe(true);
    expect(defaultValidFrom(NOW)).toBe('2026-10-11T00:00');
    // Règle à venir : la nouvelle version ne part pas avant son début.
    const future = rule({ validFrom: '2026-11-01T00:00:00.000Z' });
    expect(supersedeValidFrom(future, NOW).toISOString()).toBe('2026-11-01T00:01:00.000Z');
    // Règle qui finit ce soir : la nouvelle version ne part pas après sa fin.
    const bounded = rule({ validTo: '2026-10-10T20:00:00.000Z' });
    expect(supersedeValidFrom(bounded, NOW).toISOString()).toBe('2026-10-10T20:00:00.000Z');
    // Fin : ni passée, ni avant le début, plus tôt que la fin actuelle.
    expect(endAllowed('2026-10-10T10:00', v1, NOW)).toBe(true);
    // À 10 h 00 min 30 s (Douala), la fin la plus proche admise est 10 h 01.
    expect(endAllowed('2026-10-10T10:01', v1, new Date('2026-10-10T09:00:30.000Z'))).toBe(true);
    expect(endAllowed('2026-10-10T10:00', v1, new Date('2026-10-10T09:00:30.000Z'))).toBe(false);
    expect(endAllowed('2026-10-10T09:00', v1, new Date('2026-10-10T08:00:30.000Z'))).toBe(false);
    expect(endAllowed('2026-10-20T00:00', future, NOW)).toBe(false);
    expect(endAllowed('2026-10-11T00:00', bounded, NOW)).toBe(false);
  });
});

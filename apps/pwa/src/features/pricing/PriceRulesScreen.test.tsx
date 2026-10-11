import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { PriceRulesScreen } from './PriceRulesScreen.js';
import {
  checkRule,
  defaultValidFrom,
  endAllowed,
  formFrom,
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

  it('opération retrouvée en attente au retour sur l’écran : tout attend sa réponse et la relecture', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    // Nouvelle version envoyée lors d'une visite précédente, toujours sans réponse.
    const pending: OutboxCommand = {
      command_id: '01900000-0000-7000-8000-0000000000f1',
      device_seq: 1,
      command_type: 'pricing.rule.supersede',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'PRICE_RULE',
      aggregate_id: '01900000-0000-7000-8000-0000000000a1',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T08:59:00.000Z',
      client_created_at: '2026-10-10T08:59:00.000Z',
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: { supersedesRuleId: 'r-actif', unitPriceXaf: 105 },
      status: 'PENDING_SYNC',
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    };
    await getDb().outbox.add(pending);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const newVersion = await screen.findByRole('button', { name: 'Nouvelle version' });
    expect(newVersion).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nouvelle règle' })).toBeDisabled();
    expect(screen.getByText(/Opération (en cours d’envoi|enregistrée)/)).toBeInTheDocument();

    // Réponse reçue : la relecture montre la version 2 et retire « Nouvelle version » de la v1.
    rules = [
      rule({}),
      rule({ id: 'v2', version: 2, status: 'DRAFT', unitPriceXaf: 105, validFrom: TOMORROW }),
    ];
    const calls = vi.mocked(authorizedRequest).mock.calls.length;
    await settleLast();
    await screen.findByRole('listitem', { name: 'OEUF-GEN v2' });
    expect(vi.mocked(authorizedRequest).mock.calls.length).toBeGreaterThan(calls);
    expect(screen.queryByRole('button', { name: 'Nouvelle version' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Nouvelle règle' })).toBeEnabled(),
    );
  });

  it('relecture lente après une opération : liste gardée mais actions bloquées jusqu’à la réponse', async () => {
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const site = await screen.findByRole('listitem', { name: 'OEUF-PDV v1' });
    await user.click(within(site).getByRole('button', { name: 'Activer' }));
    await screen.findByText(/Opération (en cours d’envoi|enregistrée)/);

    // La relecture qui suit la réponse ne revient pas tout de suite (toutes les lectures retenues).
    const pendingReads: (() => void)[] = [];
    vi.mocked(authorizedRequest).mockImplementation(
      (_db, path) =>
        new Promise((resolve) => {
          pendingReads.push(() => resolve(answer(path) as never));
        }),
    );
    const before = vi.mocked(authorizedRequest).mock.calls.length;
    await settleLast();
    // Relecture partie après la réponse SYNCED.
    await waitFor(() =>
      expect(vi.mocked(authorizedRequest).mock.calls.length).toBeGreaterThan(before),
    );
    expect(
      await screen.findByText('Relecture des règles après la dernière opération…'),
    ).toBeInTheDocument();
    // La liste reste affichée, mais rien ne s'active sur elle (le brouillon y paraît encore).
    const stillDraft = screen.getByRole('listitem', { name: 'OEUF-PDV v1' });
    expect(within(stillDraft).getByRole('button', { name: 'Activer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nouvelle règle' })).toBeDisabled();

    rules = [rule({}), rule({ id: 'd-site', code: 'OEUF-PDV', siteId: IDS.site })];
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => answer(path) as never);
    for (const release of pendingReads.splice(0)) release();
    await waitFor(() =>
      expect(
        screen.queryByText('Relecture des règles après la dernière opération…'),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Nouvelle règle' })).toBeEnabled(),
    );
  });

  it('lecture en échec : annoncée, relue par « Réessayer » ; codes indisponibles relus aussi', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    vi.mocked(authorizedRequest).mockResolvedValueOnce({
      ok: false,
      reason: 'HTTP_ERROR',
      status: 503,
      body: null,
    } as never);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.click(await screen.findByRole('button', { name: 'Réessayer' }));
    const newRule = await screen.findByRole('button', { name: 'Nouvelle règle' });
    await waitFor(() => expect(newRule).toBeEnabled());

    // Lecture des codes de toutes les lignées en échec : annoncée, avec un nouvel essai.
    vi.mocked(authorizedRequest).mockResolvedValueOnce({
      ok: false,
      reason: 'OFFLINE',
    } as never);
    await user.click(newRule);
    expect(await screen.findByText(/Codes existants indisponibles/)).toBeInTheDocument();
    const code = screen.getByLabelText('Code de la règle');
    expect(code.getAttribute('aria-describedby')?.split(' ').length).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() =>
      expect(screen.queryByText(/Codes existants indisponibles/)).not.toBeInTheDocument(),
    );
  });

  it('opération d’une visite précédente refusée : le refus reste affiché', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    await getDb().outbox.add({
      command_id: '01900000-0000-7000-8000-0000000000f3',
      device_seq: 1,
      command_type: 'pricing.rule.supersede',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'PRICE_RULE',
      aggregate_id: '01900000-0000-7000-8000-0000000000a3',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T08:59:00.000Z',
      client_created_at: '2026-10-10T08:59:00.000Z',
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: { supersedesRuleId: 'r-actif', unitPriceXaf: 105 },
      status: 'PENDING_SYNC',
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
    renderScreen();
    expect(await screen.findByText(/Opération (en cours d’envoi|enregistrée)/)).toBeInTheDocument();
    await settleLast('REJECTED');
    expect(await screen.findByText(/Canal inconnu/)).toBeInTheDocument();
  });

  it('nouvelle version : catégorie de client inactive libellée par son nom', async () => {
    rules = [rule({ customerCategoryId: 'cat-ancienne' })];
    await getDb().projections.put({
      key: 'customer_category:CUSTOMER_CATEGORY:cat-ancienne',
      dataset: 'customer_category',
      entity_type: 'CUSTOMER_CATEGORY',
      entity_id: 'cat-ancienne',
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: { id: 'cat-ancienne', code: 'GROS', name: 'Grossistes', is_active: false },
    });
    await rememberRoles(['RESP_COMMERCIAL']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.click(await screen.findByRole('button', { name: 'Nouvelle version' }));
    const category = screen.getByLabelText('Catégorie de client');
    expect(category).toHaveValue('cat-ancienne');
    expect(
      within(category).getByRole('option', { name: 'Grossistes (inactive)' }),
    ).toBeInTheDocument();
  });

  it('fin avant la date d’effet du brouillon suivant : avertie et confirmée', async () => {
    rules = [
      rule({}),
      rule({
        id: 'v2',
        version: 2,
        status: 'DRAFT',
        unitPriceXaf: 105,
        validFrom: '2026-10-19T23:00:00.000Z',
      }),
    ];
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    const active = await screen.findByRole('listitem', { name: 'OEUF-GEN v1' });
    await user.click(within(active).getByRole('button', { name: 'Terminer' }));
    const endInput = within(active).getByLabelText('Fin de validité (heure de Douala)');
    fireEvent.change(endInput, { target: { value: '2026-10-15T00:00' } });
    expect(within(active).getByRole('alert')).toHaveTextContent(/brouillon v2/);
    const confirm = within(active).getByRole('checkbox', {
      name: 'Je confirme cette fin malgré le brouillon de la version suivante',
    });
    const submit = within(active).getByRole('button', { name: 'Avancer la fin' });
    expect(submit).toBeDisabled();
    await user.click(confirm);
    expect(submit).toBeEnabled();
    // Une fin au-delà de la date d'effet du brouillon ne demande rien.
    fireEvent.change(endInput, { target: { value: '2026-10-25T00:00' } });
    expect(within(active).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('date d’effet passée : refusée et signalée sur le champ', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Produit'), IDS.eggs);
    await user.click(await screen.findByRole('button', { name: 'Nouvelle règle' }));
    await user.type(screen.getByLabelText('Code de la règle'), 'OEUF-HIER');
    await user.type(screen.getByLabelText('Prix par U (F)'), '90');
    const from = screen.getByLabelText('Date d’effet (heure de Douala)');
    fireEvent.change(from, { target: { value: '2026-10-09T08:00' } });
    expect(await screen.findByText(/La date d’effet doit être à venir/)).toBeInTheDocument();
    expect(from).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Enregistrer le brouillon' })).toBeDisabled();
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

  it('date d’effet à venir exigée ; fin reprise seulement si elle suit la date d’effet', () => {
    const at = (validFrom: string) =>
      checkRule(form({ validFrom }), { needsCode: false, now: NOW }).issues;
    // 10 h à Douala = maintenant : admis (minute en cours arrondie au-dessus) ; 9 h 59 refusé.
    expect(at('2026-10-10T10:00')).toEqual([]);
    expect(at('2026-10-10T09:59')).toEqual(['VALID_FROM_PAST']);
    const ending = rule({ validTo: '2026-10-10T20:00:00.000Z' });
    expect(formFrom(ending, new Date('2026-10-10T10:00:00.000Z')).validTo).toBe('2026-10-10T21:00');
    // Fin jamais effacée en silence : à égalité avec la date d'effet, VALID_TO_INVALID le dira.
    expect(formFrom(ending, new Date('2026-10-10T20:00:00.000Z')).validTo).toBe('2026-10-10T21:00');
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
    // Règle qui finit ce soir : la nouvelle version part maintenant (minute supérieure), avant sa fin,
    // qui est reprise telle quelle.
    const bounded = rule({ validTo: '2026-10-10T20:00:00.000Z' });
    expect(supersedeValidFrom(bounded, NOW).toISOString()).toBe('2026-10-10T09:00:00.000Z');
    expect(formFrom(bounded, supersedeValidFrom(bounded, NOW)).validTo).toBe('2026-10-10T21:00');
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

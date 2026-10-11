import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { CatalogScreen } from './CatalogScreen.js';
import {
  checkPackaging,
  checkProduct,
  EMPTY_PRODUCT,
  pendingCatalogCodes,
  productPayload,
} from './catalog.js';
import type { ProductView, ReasonView, UnitView } from './catalog.js';

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

const CATEGORY = '01900000-0000-7000-8000-0000000000c1';

const UNITS: UnitView[] = [
  { code: 'U', name: 'Unité', isCount: true, isActive: true },
  { code: 'KG', name: 'Kilogramme', isCount: false, isActive: true },
  { code: 'PLATEAU', name: 'Plateau', isCount: true, isActive: true },
];

const product = (overrides: Partial<ProductView>): ProductView => ({
  id: IDS.eggs,
  code: 'OEUF',
  name: 'Œufs',
  categoryId: CATEGORY,
  stockFamily: 'PRODUCTION_COMMERCIALISABLE',
  baseUnitCode: 'U',
  lotTracking: 'OPTIONAL',
  isSellable: true,
  isPurchasable: false,
  isProducible: true,
  isConsumable: false,
  pricingMode: 'PER_UNIT',
  species: null,
  status: 'ACTIVE',
  ...overrides,
});

const PRODUCTS = [
  product({}),
  product({ id: IDS.chicken, code: 'POULET', name: 'Poulet', status: 'INACTIVE' }),
];

const REASONS: ReasonView[] = [
  {
    id: 'reason-1',
    category: 'VISIT_OUTCOME',
    code: 'ABSENT',
    label: 'Client absent',
    lossCategory: null,
    requiresComment: false,
    isActive: true,
  },
];

function answer(path: string) {
  if (path.startsWith('/api/v1/units')) return { ok: true, data: { units: UNITS } };
  if (path.startsWith('/api/v1/products')) return { ok: true, data: { products: PRODUCTS } };
  return { ok: true, data: { reason_codes: REASONS } };
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <CatalogScreen />
    </MemoryRouter>,
  );
}

/** Réponse définitive du serveur à la dernière commande (le moteur de synchronisation est simulé). */
async function settleLast(expectedCount: number) {
  await waitFor(async () => expect(await getDb().outbox.count()).toBe(expectedCount));
  const command = await nextCommand();
  await getDb().outbox.update(command?.command_id as string, {
    status: 'SYNCED',
    synced_at: '2026-10-10T09:00:05.000Z',
  });
}

async function nextCommand() {
  const commands = await getDb().outbox.orderBy('device_seq').toArray();
  return commands[commands.length - 1];
}

describe('Catalogue (ECR-PRX-01)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.put({
      key: `product_category:PRODUCT_CATEGORY:${CATEGORY}`,
      dataset: 'product_category',
      entity_type: 'PRODUCT_CATEGORY',
      entity_id: CATEGORY,
      scope_type: 'GLOBAL',
      scope_id: null,
      row_version: 1,
      seq: 1,
      data: { id: CATEGORY, code: 'PRODUITS', name: 'Produits de la ferme', parent_id: null },
    });
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => answer(path) as never);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
  });

  it('produits lus en ligne, création d’un produit biologique, désactivation, réactivation', async () => {
    const user = userEvent.setup();
    renderScreen();
    const list = within(await screen.findByRole('region', { name: 'Produits' }));
    expect(await list.findByText('Œufs')).toBeInTheDocument();
    expect(authorizedRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/products', {
      method: 'GET',
    });

    await user.click(list.getByRole('button', { name: 'Désactiver Œufs' }));
    await screen.findByText(/Opération (en cours d’envoi|enregistrée)/);
    expect(await nextCommand()).toMatchObject({
      command_type: 'catalog.product.deactivate',
      aggregate_type: 'PRODUCT',
      aggregate_id: IDS.eggs,
      payload: {},
    });
    await settleLast(1);
    const reactivate = list.getByRole('button', { name: 'Réactiver Poulet' });
    await waitFor(() => expect(reactivate).toBeEnabled());
    await user.click(reactivate);
    await waitFor(async () =>
      expect(await nextCommand()).toMatchObject({
        command_type: 'catalog.product.reactivate',
        aggregate_id: IDS.chicken,
      }),
    );
    await settleLast(2);

    const newProduct = list.getByRole('button', { name: 'Nouveau produit' });
    await user.click(newProduct);
    await user.type(list.getByLabelText('Code'), 'porc-eng');
    await user.type(list.getByLabelText('Libellé'), 'Porc à l’engraissement');
    await user.selectOptions(list.getByLabelText('Catégorie'), CATEGORY);
    await user.selectOptions(list.getByLabelText('Famille de stock'), 'BIOLOGIQUE');
    await user.selectOptions(list.getByLabelText('Unité de base'), 'U');
    expect(list.getByText('Un produit biologique exige une espèce.')).toBeInTheDocument();
    const create = list.getByRole('button', { name: 'Créer le produit' });
    expect(create).toBeDisabled();
    await user.selectOptions(list.getByLabelText('Espèce'), 'PORC');
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(async () =>
      expect(await nextCommand()).toMatchObject({
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        payload: {
          code: 'PORC-ENG',
          name: 'Porc à l’engraissement',
          categoryId: CATEGORY,
          stockFamily: 'BIOLOGIQUE',
          baseUnitCode: 'U',
          // Un produit biologique se suit par lot (réglé avec la famille).
          lotTracking: 'REQUIRED',
          species: 'PORC',
          isSellable: true,
        },
      }),
    );
    expect(await list.findByRole('button', { name: 'Nouveau produit' })).toBeInTheDocument();
  });

  it('unité, catégorie, conditionnement et motif', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('region', { name: 'Produits' });

    await user.click(screen.getByRole('radio', { name: 'Unités' }));
    const units = within(screen.getByRole('region', { name: 'Unités' }));
    await user.type(units.getByLabelText('Code'), 'kg');
    expect(units.getByText('Ce code existe déjà.')).toBeInTheDocument();
    await user.clear(units.getByLabelText('Code'));
    await user.type(units.getByLabelText('Code'), 'sac50');
    await user.type(units.getByLabelText('Libellé'), 'Sac de 50 kg');
    await user.click(units.getByLabelText(/Unité de comptage/));
    await user.click(units.getByRole('button', { name: 'Créer l’unité' }));
    await waitFor(async () =>
      expect(await nextCommand()).toMatchObject({
        command_type: 'catalog.unit.create',
        aggregate_type: 'UNIT',
        payload: { code: 'SAC50', name: 'Sac de 50 kg', isCount: false },
      }),
    );
    await settleLast(1);

    await user.click(screen.getByRole('radio', { name: 'Catégories' }));
    const categories = within(screen.getByRole('region', { name: 'Catégories' }));
    expect(
      within(categories.getByRole('list')).getByText('Produits de la ferme'),
    ).toBeInTheDocument();
    await user.type(categories.getByLabelText('Code'), 'OEUFS');
    await user.type(categories.getByLabelText('Libellé'), 'Œufs');
    await user.selectOptions(categories.getByLabelText('Catégorie parente'), CATEGORY);
    const createCategory = categories.getByRole('button', { name: 'Créer la catégorie' });
    await waitFor(() => expect(createCategory).toBeEnabled());
    await user.click(createCategory);
    await waitFor(async () =>
      expect(await nextCommand()).toMatchObject({
        command_type: 'catalog.product_category.create',
        aggregate_type: 'PRODUCT_CATEGORY',
        payload: { code: 'OEUFS', name: 'Œufs', parentId: CATEGORY },
      }),
    );
    // Créée, pas encore tirée : affichée en attente.
    expect(await within(categories.getByRole('list')).findByText('OEUFS')).toBeInTheDocument();
    expect(
      within(categories.getByRole('list')).getByText('En attente d’envoi'),
    ).toBeInTheDocument();
    await settleLast(2);
    // Acceptée, pas encore tirée : annoncée comme créée.
    expect(
      await within(categories.getByRole('list')).findByText(
        'Créée, arrive à la prochaine synchronisation',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Conditionnements' }));
    const packaging = within(screen.getByRole('region', { name: 'Conditionnements' }));
    await user.selectOptions(packaging.getByLabelText('Produit'), IDS.eggs);
    expect(packaging.getByText('PLATEAU')).toBeInTheDocument();
    await user.selectOptions(packaging.getByLabelText('Unité'), 'PLATEAU');
    expect(
      packaging.getByText('Ce conditionnement existe déjà pour ce produit.'),
    ).toBeInTheDocument();
    await user.selectOptions(packaging.getByLabelText('Unité'), 'KG');
    await user.type(packaging.getByLabelText('Équivaut à (en U)'), '16,5');
    // L'unité de base U se compte : facteur entier exigé (BR-CAT-003).
    expect(
      packaging.getByText('L’unité de base se compte : le facteur est un nombre entier.'),
    ).toBeInTheDocument();
    await user.clear(packaging.getByLabelText('Équivaut à (en U)'));
    await user.type(packaging.getByLabelText('Équivaut à (en U)'), '15');
    await user.click(packaging.getByLabelText('L’achat'));
    const createPackaging = packaging.getByRole('button', { name: 'Ajouter le conditionnement' });
    await waitFor(() => expect(createPackaging).toBeEnabled());
    await user.click(createPackaging);
    await waitFor(async () =>
      expect(await nextCommand()).toMatchObject({
        command_type: 'catalog.product_unit.set',
        aggregate_type: 'PRODUCT_UNIT',
        payload: {
          productId: IDS.eggs,
          unitCode: 'KG',
          factorToBase: 15,
          isSalesUnit: true,
          isPurchaseUnit: true,
          isCountUnit: false,
        },
      }),
    );
    await settleLast(3);

    await user.click(screen.getByRole('radio', { name: 'Motifs' }));
    const reasons = within(screen.getByRole('region', { name: 'Motifs' }));
    expect(reasons.getByText('Client absent')).toBeInTheDocument();
    await user.selectOptions(reasons.getByLabelText('Catégorie de motif'), 'LOSS');
    expect(reasons.getByText('Aucun élément.')).toBeInTheDocument();
    await user.type(reasons.getByLabelText('Code'), 'CHALEUR');
    await user.type(reasons.getByLabelText('Libellé'), 'Coup de chaleur');
    await user.selectOptions(reasons.getByLabelText('Catégorie de perte'), 'MORTALITE');
    expect(reasons.getByLabelText('Catégorie de perte')).toHaveDisplayValue('Mortalité');
    await user.click(reasons.getByLabelText('Commentaire obligatoire'));
    const createReason = reasons.getByRole('button', { name: 'Enregistrer le motif' });
    await waitFor(() => expect(createReason).toBeEnabled());
    await user.click(createReason);
    await waitFor(async () =>
      expect(await nextCommand()).toMatchObject({
        command_type: 'catalog.reason_code.set',
        aggregate_type: 'REASON_CODE',
        payload: {
          category: 'LOSS',
          code: 'CHALEUR',
          label: 'Coup de chaleur',
          lossCategory: 'MORTALITE',
          requiresComment: true,
        },
      }),
    );
  });

  it('retour sur l’écran : opération en attente annoncée, listes relues à sa réponse', async () => {
    await getDb().outbox.add({
      command_id: '01900000-0000-7000-8000-0000000000f4',
      device_seq: 1,
      command_type: 'catalog.unit.create',
      command_version: 1,
      author_user_id: IDS.user,
      aggregate_type: 'UNIT',
      aggregate_id: 'SAC',
      base_version: null,
      depends_on: [],
      occurred_at: '2026-10-10T08:59:00.000Z',
      client_created_at: '2026-10-10T08:59:00.000Z',
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: { code: 'SAC', name: 'Sac', isCount: true },
      status: 'PENDING_SYNC',
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
    });
    renderScreen();
    expect(await screen.findByText('Opération en cours d’envoi…')).toBeInTheDocument();
    const unitReads = () =>
      vi.mocked(authorizedRequest).mock.calls.filter(([, path]) => String(path) === '/api/v1/units')
        .length;
    await waitFor(() => expect(unitReads()).toBeGreaterThan(0));
    const before = unitReads();
    await settleLast(1);
    await waitFor(() => expect(unitReads()).toBeGreaterThan(before));
  });

  it('lecture en échec : annoncée, relue par « Réessayer »', async () => {
    vi.mocked(authorizedRequest).mockImplementation(
      async (_db, path) =>
        (String(path) === '/api/v1/units'
          ? { ok: false, reason: 'HTTP_ERROR', status: 503, body: null }
          : answer(path)) as never,
    );
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/Catalogue indisponible/)).toBeInTheDocument();
    vi.mocked(authorizedRequest).mockImplementation(async (_db, path) => answer(path) as never);
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('region', { name: 'Produits' })).toBeInTheDocument();
  });

  it('hors ligne : écran en ligne seulement, aucune lecture', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/en ligne seulement/);
    expect(authorizedRequest).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Produits' })).not.toBeInTheDocument();
  });

  it('serveur indisponible : message, aucune saisie', async () => {
    vi.mocked(authorizedRequest).mockResolvedValue({ ok: false } as never);
    renderScreen();
    expect(await screen.findByText(/Catalogue indisponible/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Produits' })).not.toBeInTheDocument();
  });
});

describe('Règles du catalogue', () => {
  it('service sans lot, code normalisé, espèce seulement pour le biologique', () => {
    const service = {
      ...EMPTY_PRODUCT,
      code: ' livraison ',
      name: 'Livraison',
      categoryId: CATEGORY,
      stockFamily: 'SERVICE' as const,
      baseUnitCode: 'U',
      lotTracking: 'REQUIRED' as const,
      species: 'PORC',
    };
    expect(checkProduct(service, [])).toEqual(['SERVICE_LOT']);
    expect(
      checkProduct(
        { ...service, stockFamily: 'BIOLOGIQUE', lotTracking: 'NONE', species: 'PORC' },
        [],
      ),
    ).toEqual(['BIO_LOT']);
    expect(productPayload(service)).toMatchObject({ code: 'LIVRAISON', lotTracking: 'NONE' });
    expect(productPayload(service)).not.toHaveProperty('species');
    expect(checkProduct({ ...service, code: 'OEUF', lotTracking: 'NONE' }, PRODUCTS)).toEqual([
      'CODE_TAKEN',
    ]);
    expect(checkProduct({ ...service, code: 'é t', lotTracking: 'NONE' }, [])).toEqual([
      'CODE_INVALID',
    ]);
  });

  it('conditionnement : facteur positif, unité différente de la base, couple unique', () => {
    const existing = [{ product_id: IDS.eggs, unit_code: 'PLATEAU' }];
    const base = { productId: IDS.eggs, unitCode: 'KG', factorText: '0' };
    expect(checkPackaging(base, PRODUCTS[0], existing).issues).toEqual(['FACTOR_INVALID']);
    expect(checkPackaging({ ...base, factorText: '1.1234567' }, PRODUCTS[0], existing)).toEqual({
      issues: ['FACTOR_INVALID'],
      factor: null,
    });
    expect(
      checkPackaging({ ...base, unitCode: 'U', factorText: '2' }, PRODUCTS[0], existing).issues,
    ).toEqual(['UNIT_REQUIRED']);
    expect(
      checkPackaging({ ...base, unitCode: 'PLATEAU', factorText: '30' }, PRODUCTS[0], existing),
    ).toEqual({ issues: ['PACKAGING_EXISTS'], factor: 30 });
    // DECIMAL(14,6) : 8 chiffres avant la virgule au plus.
    expect(
      checkPackaging({ ...base, factorText: '100000000' }, PRODUCTS[0], existing).issues,
    ).toEqual(['FACTOR_INVALID']);
    expect(
      checkPackaging({ ...base, factorText: '2,5' }, PRODUCTS[0], existing, true).issues,
    ).toEqual(['FACTOR_NOT_WHOLE']);
  });

  it('codes des créations en attente pris en compte (sauf refusées)', () => {
    const command = (type: string, payload: object, status = 'PENDING_SYNC') => ({
      command_type: type,
      status,
      payload,
    });
    expect(
      pendingCatalogCodes([
        command('catalog.unit.create', { code: 'sac' }),
        command('catalog.product_category.create', { code: 'oeufs' }),
        command('catalog.product.create', { code: 'PC' }, 'REJECTED'),
        command('catalog.reason_code.set', { category: 'LOSS', code: 'chaleur' }),
      ]),
    ).toEqual({
      units: ['SAC'],
      categories: ['OEUFS'],
      acceptedCategories: [],
      products: [],
      reasons: [{ category: 'LOSS', code: 'CHALEUR' }],
    });
  });
});

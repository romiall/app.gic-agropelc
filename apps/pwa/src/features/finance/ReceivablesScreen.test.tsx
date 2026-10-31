import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { reportSyncOutcome, resetConnectivityForTests } from '../../platform/connectivity.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import type { ReceivableItem, ReceivablesResponse } from './receivables.js';
import { ReceivablesScreen } from './ReceivablesScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../../platform/composition.js', async () => {
  const { FixedClock, Uuidv7Generator } = await import('@gic/domain');
  const clock = new FixedClock(new Date('2026-10-10T12:00:00.000Z'));
  return { clock, idGenerator: new Uuidv7Generator(clock) };
});
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
    deviceId: '01900000-0000-7000-8000-0000000000d0',
  }),
}));

const request = vi.mocked(authorizedRequest);
const REMOTE = '01900000-0000-7000-8000-0000000008a1';
const ABSORBED = '01900000-0000-7000-8000-0000000008a2';
const UNKNOWN = '01900000-0000-7000-8000-0000000008a3';
const COMMERCIAL = '01900000-0000-7000-8000-0000000008c1';
const OTHER_SITE = '01900000-0000-7000-8000-0000000008d1';
const ANOTHER = '01900000-0000-7000-8000-0000000008a4';
const TWIN = '01900000-0000-7000-8000-0000000008a5';
const S1 = '01900000-0000-7000-8000-0000000008e1';
const S2 = '01900000-0000-7000-8000-0000000008e2';
const S3 = '01900000-0000-7000-8000-0000000008e3';
const S4 = '01900000-0000-7000-8000-0000000008e4';
const S5 = '01900000-0000-7000-8000-0000000008e5';
const RECEIVABLES = '/api/v1/receivables';
const CUSTOMERS = '/api/v1/customers?limit=200';
const MERGED = '/api/v1/customers?stage=MERGED&limit=200';
const USERS = '/api/v1/users?limit=200';

const DENIED = { __status: 403 } as const;
const BROKEN = { __status: 500 } as const;
const NEVER = { __never: true } as const;

type Routes = Record<string, unknown>;

/** Ligne telle que le contrôleur la rend : `occurredAt` en ISO, `resource` ajouté. */
function line(over: Partial<ReceivableItem> & Pick<ReceivableItem, 'saleId'>): ReceivableItem {
  const base = {
    docNumber: 'VTE-2026-000000',
    customerId: IDS.customer,
    siteId: IDS.site,
    commercialUserId: null,
    sellerUserId: IDS.user,
    zoneId: IDS.zone,
    occurredAt: '2026-08-01T10:00:00.000Z',
    dueDate: '2026-08-31',
    netTotalXaf: 30_000,
    amountPaidXaf: 10_000,
    balanceDueXaf: 20_000,
    daysOverdue: 40,
    overdue: true,
    bucket: '31-60' as const,
    ...over,
  };
  return {
    ...base,
    resource: {
      ownerUserId: base.commercialUserId ?? base.sellerUserId,
      siteId: base.siteId,
      zoneId: base.zoneId,
    },
  };
}

// Jour métier : 10 octobre 2026.
const lines: ReceivableItem[] = [
  line({
    saleId: S4,
    docNumber: 'VTE-2026-000004',
    customerId: ABSORBED,
    dueDate: '2026-06-01',
    daysOverdue: 131,
    bucket: '>90',
    netTotalXaf: 8_000,
    amountPaidXaf: 0,
    balanceDueXaf: 8_000,
    occurredAt: '2026-05-02T09:00:00.000Z',
  }),
  line({ saleId: S1, docNumber: 'VTE-2026-000001' }),
  line({
    saleId: S3,
    docNumber: 'VTE-2026-000003',
    customerId: REMOTE,
    siteId: OTHER_SITE,
    commercialUserId: COMMERCIAL,
    dueDate: '2026-09-25',
    daysOverdue: 15,
    bucket: '0-30',
    netTotalXaf: 50_000,
    amountPaidXaf: 0,
    balanceDueXaf: 50_000,
    occurredAt: '2026-08-26T09:00:00.000Z',
  }),
  line({
    saleId: S5,
    docNumber: 'VTE-2026-000005',
    customerId: UNKNOWN,
    dueDate: '2026-10-05',
    daysOverdue: 5,
    bucket: '0-30',
    netTotalXaf: 1_000,
    amountPaidXaf: 0,
    balanceDueXaf: 1_000,
    occurredAt: '2026-09-05T09:00:00.000Z',
  }),
  // Vendue le 20 septembre à 23 h 30 UTC : le 21 à Douala.
  line({
    saleId: S2,
    docNumber: 'VTE-2026-000002',
    dueDate: '2026-10-20',
    daysOverdue: 0,
    overdue: false,
    bucket: '0-30',
    netTotalXaf: 5_000,
    amountPaidXaf: 0,
    balanceDueXaf: 5_000,
    occurredAt: '2026-09-20T23:30:00.000Z',
  }),
];

const response: ReceivablesResponse = {
  as_of: '2026-10-10',
  summary: {
    totalXaf: 84_000,
    overdueXaf: 79_000,
    count: 5,
    buckets: { '0-30': 51_000, '31-60': 20_000, '61-90': 0, '>90': 8_000 },
  },
  receivables: lines,
};

/** Résumé client de `GET /customers` (CustomerSummary), sur le modèle du contrôleur. */
function remoteCustomer(id: string, displayName: string, over: Record<string, unknown> = {}) {
  return {
    id,
    stage: 'CUSTOMER',
    pipelineStepId: null,
    customerType: 'RESTAURANT',
    displayName,
    contactName: null,
    businessActivity: null,
    categoryId: null,
    phonePrimary: null,
    phoneSecondary: null,
    email: null,
    addressText: null,
    zoneId: IDS.zone,
    position: null,
    sourceCode: 'TERRAIN',
    acquiredByUserId: COMMERCIAL,
    acquiredAt: '2026-01-10T08:00:00.000Z',
    ownerUserId: COMMERCIAL,
    homeSiteId: null,
    convertedAt: null,
    firstSaleId: null,
    conversionReverted: false,
    lostReasonCodeId: null,
    mergedIntoId: null,
    duplicateOfId: null,
    creditAllowed: true,
    creditLimitXaf: 100_000,
    paymentTermsDays: 30,
    lastSaleAt: null,
    version: 3,
    ...over,
  };
}

function baseRoutes(): Routes {
  return {
    [RECEIVABLES]: response,
    [CUSTOMERS]: {
      customers: [
        remoteCustomer(REMOTE, 'Restaurant Chez Mado', { phonePrimary: '+237 677 00 11 22' }),
      ],
      next_cursor: null,
    },
    [MERGED]: {
      customers: [
        remoteCustomer(ABSORBED, 'Chez Mado (ancien compte)', {
          stage: 'MERGED',
          mergedIntoId: REMOTE,
        }),
      ],
      next_cursor: null,
    },
    [USERS]: {
      users: [
        {
          id: COMMERCIAL,
          fullName: 'Alice Mballa',
          phone: '+237690000001',
          email: null,
          status: 'ACTIVE',
          statusChangedAt: null,
          mustChangePassword: false,
          lastLoginAt: null,
          createdAt: '2026-01-01T08:00:00.000Z',
          roles: [],
        },
      ],
      next_cursor: null,
    },
  };
}

function serve(routes: Routes) {
  request.mockImplementation((_db, path) => {
    const data = routes[path];
    if (data === NEVER) return new Promise(() => {}) as ReturnType<typeof authorizedRequest>;
    const status =
      data && typeof data === 'object' && '__status' in data
        ? (data as { __status: number }).__status
        : data
          ? null
          : 500;
    return Promise.resolve(
      status === null
        ? { ok: true, data }
        : { ok: false, reason: 'HTTP_ERROR', status, message: `route : ${path}` },
    ) as ReturnType<typeof authorizedRequest>;
  });
}

function readsOf(path: string): number {
  return request.mock.calls.filter(([, called]) => called === path).length;
}

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
      <ReceivablesScreen />
    </MemoryRouter>,
  );
}

const list = () => screen.getByRole('region', { name: 'Liste des créances' });
const groupNames = () =>
  within(list())
    .getAllByRole('listitem')
    .filter((item) => item.classList.contains('data-row'))
    .map((item) => item.getAttribute('aria-label'));

/** Tuile d'indicateur de l'encours, retrouvée par son libellé. */
const tileOf = (summary: HTMLElement, label: string) =>
  within(summary).getByText(label).closest('.tile') as HTMLElement;

describe('Créances (ECR-FIN-01, P8E-09)', () => {
  beforeEach(async () => {
    resetConnectivityForTests();
    request.mockReset();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    resetConnectivityForTests();
    serve(baseRoutes());
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
  });

  it('Finance : encours du jour, échu par retard, clients du plus en retard, noms lus en ligne, compte fusionné regroupé', async () => {
    await rememberRoles(['FINANCE']);
    renderScreen();
    const summary = await screen.findByRole('region', { name: 'Encours' });
    expect(await within(summary).findByText('Situation au 10 octobre 2026')).toBeInTheDocument();
    // Trois tuiles (libellé, valeur, précision) à la place des trois phrases d'avant.
    const total = tileOf(summary, 'Dû par les clients');
    expect(within(total).getByText(/^84\s000 F CFA$/)).toBeInTheDocument();
    expect(within(total).getByText('5 ventes')).toBeInTheDocument();
    const overdue = tileOf(summary, 'Échu');
    expect(overdue).toHaveClass('tile-bad');
    expect(within(overdue).getByText(/^79\s000 F CFA$/)).toBeInTheDocument();
    expect(within(overdue).getByText(/^94\s% de l’encours$/)).toBeInTheDocument();
    expect(within(tileOf(summary, 'À échoir')).getByText(/^5\s000 F CFA$/)).toBeInTheDocument();
    const buckets = within(summary).getByRole('list', { name: 'Échu par retard' });
    expect(
      within(buckets)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/^1 à 30 jours de retard : 51\s000 F CFA$/),
      expect.stringMatching(/^31 à 60 jours de retard : 20\s000 F CFA$/),
      expect.stringMatching(/^61 à 90 jours de retard : 0 F CFA$/),
      expect.stringMatching(/^Plus de 90 jours de retard : 8\s000 F CFA$/),
    ]);

    // Le compte absorbé est réuni au compte conservé ; le plus en retard d'abord.
    const mado = await within(list()).findByRole('listitem', { name: 'Restaurant Chez Mado' });
    expect(groupNames()).toEqual(['Restaurant Chez Mado', 'Boutique Mvog-Mbi', 'client …08a3']);
    expect(within(mado).getByText(/^58\s000 F CFA$/)).toBeInTheDocument();
    expect(
      within(mado).getByText(/^Échu 58\s000 F CFA · jusqu’à 131 jours de retard$/),
    ).toBeInTheDocument();
    expect(
      within(mado).getByText('2 ventes à régler · échéance la plus ancienne : 1 juin 2026'),
    ).toBeInTheDocument();
    expect(
      within(mado).getByRole('link', { name: 'Appeler le +237 677 00 11 22' }),
    ).toHaveAttribute('href', 'tel:+237677001122');
    expect(
      within(mado).getByRole('link', { name: 'Encaisser auprès de Restaurant Chez Mado' }),
    ).toHaveAttribute('href', `/encaisser?client=${REMOTE}`);
    // Client absent de l'appareil : pas de fiche.
    expect(within(mado).queryByRole('link', { name: /^Fiche de/ })).toBeNull();

    const boutique = within(list()).getByRole('listitem', { name: 'Boutique Mvog-Mbi' });
    expect(
      within(boutique).getByRole('link', { name: 'Fiche de Boutique Mvog-Mbi' }),
    ).toHaveAttribute('href', `/clients/${IDS.customer}`);
    expect(
      within(boutique).getByRole('link', { name: 'Appeler le +237 699 11 22 33' }),
    ).toHaveAttribute('href', 'tel:+237699112233');
    expect(
      within(boutique).getByText(/^Échu 20\s000 F CFA · jusqu’à 40 jours de retard$/),
    ).toBeInTheDocument();
    const unknown = within(list()).getByRole('listitem', { name: 'client …08a3' });
    expect(
      within(unknown).getByText(/^Échu 1\s000 F CFA · jusqu’à 5 jours de retard$/),
    ).toBeInTheDocument();
    expect(
      within(unknown).getByText('1 vente à régler · échéance la plus ancienne : 5 octobre 2026'),
    ).toBeInTheDocument();
    // Client que la lecture complète des clients ne connaît pas (hors de votre portée) : ni appel ni
    // encaissement (la fiche répondrait « refusé »), mais ses créances restent visibles.
    expect(within(unknown).queryByRole('link', { name: /^Encaisser/ })).toBeNull();
    expect(within(unknown).queryByRole('link', { name: /^Appeler/ })).toBeNull();
    expect(readsOf(CUSTOMERS)).toBe(1);
    expect(readsOf(MERGED)).toBe(1);
    // Les titulaires ne sont lus que pour le regroupement par titulaire.
    expect(readsOf(USERS)).toBe(0);
    expect(
      screen.getByText(/^Les relances ne sont pas enregistrées dans l’application/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^Ventes à crédit d’un client identifié, dans votre périmètre/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Liste des clients partielle/)).toBeNull();
  });

  it('ventes d’un client : échéance la plus ancienne d’abord, retard ou à échoir, reste dû, encaisser le reste dû', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const boutique = await within(
      await screen.findByRole('region', { name: 'Liste des créances' }),
    ).findByRole('listitem', { name: 'Boutique Mvog-Mbi' });
    const toggle = within(boutique).getByRole('button', {
      name: 'Voir les ventes de Boutique Mvog-Mbi',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(boutique).queryByRole('listitem')).toBeNull();
    await user.click(toggle);
    expect(
      within(boutique).getByRole('button', { name: 'Masquer les ventes de Boutique Mvog-Mbi' }),
    ).toHaveAttribute('aria-expanded', 'true');
    const sales = within(boutique).getAllByRole('listitem');
    expect(sales.map((sale) => sale.getAttribute('aria-label'))).toEqual([
      'VTE-2026-000001',
      'VTE-2026-000002',
    ]);
    const [first, second] = sales as [HTMLElement, HTMLElement];
    expect(
      within(first).getByText('Vendue le 1 août 2026 · échéance le 31 août 2026'),
    ).toBeInTheDocument();
    expect(within(first).getByText('40 jours de retard')).toHaveClass('text-warn');
    expect(
      within(first).getByText(/^Reste dû 20\s000 F CFA sur 30\s000 F CFA \(payé 10\s000 F CFA\)$/),
    ).toBeInTheDocument();
    expect(
      within(first).getByRole('link', { name: 'Encaisser le reste dû de VTE-2026-000001' }),
    ).toHaveAttribute('href', `/encaisser?client=${IDS.customer}&vente=${S1}`);
    expect(
      within(second).getByText('Vendue le 21 septembre 2026 · échéance le 20 octobre 2026'),
    ).toBeInTheDocument();
    expect(within(second).getByText('À échoir')).toHaveClass('home-muted');
    // Par client, le nom du client n'est pas répété sur chaque vente.
    expect(within(first).getByText('VTE-2026-000001').parentElement?.textContent).toBe(
      'VTE-2026-000001',
    );

    // Vente d'un compte absorbé : le serveur refuse en ligne un encaissement sur le compte absorbé
    // (CUSTOMER_MERGED, BR-CRM-007) ; le lien vise le compte conservé, vente comprise.
    const mado = within(list()).getByRole('listitem', { name: 'Restaurant Chez Mado' });
    await user.click(
      within(mado).getByRole('button', { name: 'Voir les ventes de Restaurant Chez Mado' }),
    );
    expect(
      within(mado).getByRole('link', { name: 'Encaisser le reste dû de VTE-2026-000004' }),
    ).toHaveAttribute('href', `/encaisser?client=${REMOTE}&vente=${S4}`);
    expect(
      within(mado).getByRole('link', { name: 'Encaisser le reste dû de VTE-2026-000003' }),
    ).toHaveAttribute('href', `/encaisser?client=${REMOTE}&vente=${S3}`);
    await user.click(
      within(boutique).getByRole('button', { name: 'Masquer les ventes de Boutique Mvog-Mbi' }),
    );
    expect(within(boutique).queryByRole('listitem')).toBeNull();
    expect(within(mado).getAllByRole('listitem')).toHaveLength(2);
  });

  it('vues, site et regroupement par titulaire ; sélection résumée à la règle du serveur', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Restaurant Chez Mado' },
    );
    expect(screen.queryByText(/^Sélection :/)).toBeNull();
    const view = screen.getByLabelText('Afficher');
    await user.selectOptions(view, 'NOT_DUE');
    expect(groupNames()).toEqual(['Boutique Mvog-Mbi']);
    expect(within(list()).getByText('Rien d’échu')).toBeInTheDocument();
    expect(
      screen.getByText(/^Sélection : 5\s000 F CFA dû, dont 0 F CFA échu \(1 vente\)$/),
    ).toBeInTheDocument();
    // « 1 à 30 jours » : l'échu seul, pas la vente à échoir qui porte la même tranche.
    await user.selectOptions(view, '0-30');
    expect(groupNames()).toEqual(['Restaurant Chez Mado', 'client …08a3']);
    expect(
      screen.getByText(/^Sélection : 51\s000 F CFA dû, dont 51\s000 F CFA échu \(2 ventes\)$/),
    ).toBeInTheDocument();
    await user.selectOptions(view, '>90');
    expect(groupNames()).toEqual(['Restaurant Chez Mado']);
    await user.selectOptions(view, 'OVERDUE');
    expect(groupNames()).toEqual(['Restaurant Chez Mado', 'Boutique Mvog-Mbi', 'client …08a3']);
    await user.selectOptions(view, '61-90');
    expect(within(list()).getByText('Aucune créance pour ce choix.')).toBeInTheDocument();
    expect(screen.queryByText(/^Sélection :/)).toBeNull();

    // Site : celui de l'appareil nommé, l'autre abrégé.
    await user.selectOptions(view, 'ALL');
    const site = screen.getByLabelText('Site');
    expect(
      within(site)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Tous les sites', '…08d1', 'PDV Yaoundé']);
    await user.selectOptions(site, OTHER_SITE);
    expect(groupNames()).toEqual(['Restaurant Chez Mado']);
    expect(
      screen.getByText(/^Sélection : 50\s000 F CFA dû, dont 50\s000 F CFA échu \(1 vente\)$/),
    ).toBeInTheDocument();

    // Par titulaire : commercial attributaire, à défaut vendeur (le sien : « Mes créances ») ; noms lus en ligne.
    await user.selectOptions(site, '');
    await user.selectOptions(screen.getByLabelText('Regrouper par'), 'owner');
    const alice = await within(list()).findByRole('listitem', { name: 'Alice Mballa' });
    expect(groupNames()).toEqual(['Alice Mballa', 'Mes créances']);
    expect(within(alice).getByText(/^50\s000 F CFA$/)).toBeInTheDocument();
    expect(within(alice).queryByRole('link', { name: /^Encaisser auprès/ })).toBeNull();
    expect(within(alice).queryByRole('link', { name: /^Appeler/ })).toBeNull();
    const mine = within(list()).getByRole('listitem', { name: 'Mes créances' });
    expect(within(mine).getByText(/^34\s000 F CFA$/)).toBeInTheDocument();
    await user.click(within(mine).getByRole('button', { name: 'Voir mes ventes' }));
    expect(within(mine).getByRole('button', { name: 'Masquer mes ventes' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // Par titulaire, chaque vente nomme son client.
    expect(within(mine).getByText('VTE-2026-000004').parentElement?.textContent).toBe(
      'VTE-2026-000004 · Restaurant Chez Mado',
    );
    expect(within(mine).getByText('VTE-2026-000005').parentElement?.textContent).toBe(
      'VTE-2026-000005 · client …08a3',
    );
    expect(readsOf(USERS)).toBe(1);
    // Par titulaire, la vente d'un compte absorbé se règle aussi sur le compte conservé.
    expect(
      within(mine).getByRole('link', { name: 'Encaisser le reste dû de VTE-2026-000004' }),
    ).toHaveAttribute('href', `/encaisser?client=${REMOTE}&vente=${S4}`);
    // Retour par client : les groupes ouverts sont refermés.
    await user.selectOptions(screen.getByLabelText('Regrouper par'), 'customer');
    expect(
      within(list()).getByRole('button', { name: 'Voir les ventes de Boutique Mvog-Mbi' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('vues : toutes les options et leurs libellés, tranche « 31 à 60 jours » ; regroupement : groupe ouvert refermé au changement', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    const boutique = await within(
      await screen.findByRole('region', { name: 'Liste des créances' }),
    ).findByRole('listitem', { name: 'Boutique Mvog-Mbi' });
    const view = screen.getByLabelText('Afficher');
    expect(
      within(view)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Toutes les créances',
      'Échues',
      'À échoir',
      '1 à 30 jours de retard',
      '31 à 60 jours de retard',
      '61 à 90 jours de retard',
      'Plus de 90 jours de retard',
    ]);
    const grouping = screen.getByLabelText('Regrouper par');
    expect(
      within(grouping)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Client', 'Titulaire (commercial, à défaut vendeur)']);
    await user.selectOptions(view, '31-60');
    expect(groupNames()).toEqual(['Boutique Mvog-Mbi']);
    expect(
      screen.getByText(/^Sélection : 20\s000 F CFA dû, dont 20\s000 F CFA échu \(1 vente\)$/),
    ).toBeInTheDocument();
    await user.selectOptions(view, 'ALL');
    // Un groupe de CLIENT ouvert, puis changement de regroupement et retour : il est refermé.
    await user.click(
      within(boutique).getByRole('button', { name: 'Voir les ventes de Boutique Mvog-Mbi' }),
    );
    expect(within(boutique).getAllByRole('listitem').length).toBeGreaterThan(0);
    await user.selectOptions(grouping, 'owner');
    await user.selectOptions(grouping, 'customer');
    expect(
      within(list()).getByRole('button', { name: 'Voir les ventes de Boutique Mvog-Mbi' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('tri : un client sans retard passe après ceux qui ont de l’échu, même plus endetté', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: {
        ...response,
        receivables: [
          line({
            saleId: S1,
            docNumber: 'VTE-2026-000001',
            balanceDueXaf: 20_000,
            dueDate: '2026-08-31',
          }),
          line({
            saleId: S3,
            docNumber: 'VTE-2026-000003',
            customerId: REMOTE,
            dueDate: '2026-11-30',
            daysOverdue: 0,
            overdue: false,
            bucket: '0-30',
            netTotalXaf: 100_000,
            amountPaidXaf: 0,
            balanceDueXaf: 100_000,
          }),
        ],
      },
    });
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Restaurant Chez Mado' },
    );
    expect(groupNames()).toEqual(['Boutique Mvog-Mbi', 'Restaurant Chez Mado']);
  });

  it('deux clients de même nom : distingués par le téléphone, à défaut par l’identifiant', async () => {
    await rememberRoles(['FINANCE']);
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: {
        ...response,
        receivables: [
          line({ saleId: S3, docNumber: 'VTE-2026-000003', customerId: REMOTE }),
          line({ saleId: S5, docNumber: 'VTE-2026-000005', customerId: ANOTHER }),
        ],
      },
      [CUSTOMERS]: {
        customers: [
          remoteCustomer(REMOTE, 'Chez Mado', { phonePrimary: '+237 677 00 11 22' }),
          remoteCustomer(ANOTHER, 'Chez Mado', { phonePrimary: null }),
        ],
        next_cursor: null,
      },
      [MERGED]: { customers: [], next_cursor: null },
    });
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Chez Mado (+237 677 00 11 22)' },
    );
    expect(groupNames().sort()).toEqual(['Chez Mado (+237 677 00 11 22)', 'Chez Mado (…08a4)']);
    expect(
      within(list()).getByRole('button', { name: 'Voir les ventes de Chez Mado (…08a4)' }),
    ).toBeInTheDocument();
  });

  it('site choisi qui n’a plus de créance : le choix est oublié, les autres sites s’affichent', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Restaurant Chez Mado' },
    );
    await user.selectOptions(screen.getByLabelText('Site'), OTHER_SITE);
    expect(groupNames()).toEqual(['Restaurant Chez Mado']);
    // Le site choisi n'a plus de créance à la relecture : plus de choix de site, rien n'est filtré.
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: { ...response, receivables: lines.filter((item) => item.siteId === IDS.site) },
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => expect(screen.queryByLabelText('Site')).toBeNull());
    expect(groupNames()).toEqual(['Boutique Mvog-Mbi', 'Restaurant Chez Mado', 'client …08a3']);
    expect(screen.queryByText(/^Sélection :/)).toBeNull();
    // Le site revient avec une créance ultérieure : « tous les sites », pas l'ancien choix.
    serve(baseRoutes());
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByLabelText('Site')).toHaveValue('');
    expect(groupNames()).toEqual(['Restaurant Chez Mado', 'Boutique Mvog-Mbi', 'client …08a3']);
  });

  it('relecture en échec avec une lecture affichée : alerte et relance, la lecture reste, aucune actualisation annoncée', async () => {
    await rememberRoles(['FINANCE']);
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText('Situation au 10 octobre 2026');
    serve({ ...baseRoutes(), [RECEIVABLES]: BROKEN });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByText(/^Créances indisponibles/)).toBeInTheDocument();
    expect(screen.queryByText('Actualisation en cours…')).toBeNull();
    expect(screen.getByText('Situation au 10 octobre 2026')).toBeInTheDocument();
    expect(within(list()).getAllByRole('listitem').length).toBeGreaterThan(0);
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Relire les créances' }));
    await vi.waitFor(() => expect(screen.queryByText(/^Créances indisponibles/)).toBeNull());
  });

  it('un encaissement déjà dans l’outbox : une seule lecture au montage', async () => {
    await rememberRoles(['FINANCE']);
    await getDb().outbox.put({
      command_id: '01900000-0000-7000-8000-0000000009b1',
      device_seq: 1,
      author_user_id: IDS.user,
      command_type: 'sales.payment.record',
      command_version: 1,
      aggregate_type: 'CUSTOMER_PAYMENT',
      aggregate_id: '01900000-0000-7000-8000-0000000009b2',
      payload: { customerId: IDS.customer, methodCode: 'ESPECES', amountXaf: 2000 },
      occurred_at: '2026-10-10T08:00:00.000Z',
      client_created_at: '2026-10-10T08:00:00.000Z',
      captured_offline: false,
      depends_on: [],
      status: 'SYNCED',
      synced_at: '2026-10-10T08:00:05.000Z',
      attempts: 1,
    } as never);
    renderScreen();
    await screen.findByText('Situation au 10 octobre 2026');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readsOf(RECEIVABLES)).toBe(1);
  });

  it('noms des clients : relus seulement pour un client encore jamais demandé, pas quand la liste diminue', async () => {
    await rememberRoles(['FINANCE']);
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Restaurant Chez Mado' },
    );
    expect(readsOf(CUSTOMERS)).toBe(1);
    // Une créance soldée : moins de clients à nommer, pas de nouvelle lecture.
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: { ...response, receivables: lines.filter((item) => item.saleId !== S5) },
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() =>
      expect(groupNames()).toEqual(['Restaurant Chez Mado', 'Boutique Mvog-Mbi']),
    );
    expect(readsOf(CUSTOMERS)).toBe(1);
    // Un nouveau client inconnu : une seconde lecture des noms.
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: {
        ...response,
        receivables: [
          ...lines,
          line({ saleId: S2, docNumber: 'VTE-2026-000009', customerId: TWIN }),
        ],
      },
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => expect(readsOf(CUSTOMERS)).toBe(2));
  });

  it('clients de l’appareil, dont un compte absorbé connu de l’appareil : aucune lecture des noms', async () => {
    await rememberRoles(['FINANCE']);
    await getDb().projections.put({
      key: `customers:CUSTOMER:${ABSORBED}`,
      dataset: 'customers',
      entity_type: 'CUSTOMER',
      entity_id: ABSORBED,
      scope_type: 'USER',
      scope_id: IDS.user,
      data: {
        id: ABSORBED,
        stage: 'MERGED',
        display_name: 'Ancien compte',
        contact_name: null,
        category_id: null,
        phone_primary: null,
        zone_id: IDS.zone,
        owner_user_id: IDS.user,
        home_site_id: IDS.site,
        merged_into_id: IDS.customer,
        credit_allowed: true,
        credit_limit_xaf: 50000,
        payment_terms_days: 30,
        outstanding_xaf: 0,
        version: 1,
      },
      seq: 1,
      row_version: 1,
    });
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: {
        ...response,
        receivables: [
          line({ saleId: S1, docNumber: 'VTE-2026-000001' }),
          line({ saleId: S4, docNumber: 'VTE-2026-000004', customerId: ABSORBED }),
        ],
      },
    });
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Boutique Mvog-Mbi' },
    );
    expect(groupNames()).toEqual(['Boutique Mvog-Mbi']);
    expect(readsOf(CUSTOMERS)).toBe(0);
    expect(readsOf(MERGED)).toBe(0);
  });

  it('par titulaire : le titulaire connu (soi, ou un compte de l’appareil) n’est pas relu en ligne', async () => {
    await rememberRoles(['FINANCE']);
    await getDb().projections.put({
      key: `user:USER:${COMMERCIAL}`,
      dataset: 'user',
      entity_type: 'USER',
      entity_id: COMMERCIAL,
      scope_type: 'GLOBAL',
      scope_id: null,
      data: { id: COMMERCIAL, full_name: 'Alice (appareil)', status: 'ACTIVE' },
      seq: 1,
      row_version: 1,
    });
    const user = userEvent.setup();
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Restaurant Chez Mado' },
    );
    await user.selectOptions(screen.getByLabelText('Regrouper par'), 'owner');
    expect(
      await within(list()).findByRole('listitem', { name: 'Alice (appareil)' }),
    ).toBeInTheDocument();
    expect(readsOf(USERS)).toBe(0);
  });

  it('sans rôles mémorisés : la liste s’affiche et les liens sont proposés, le serveur reste juge', async () => {
    renderScreen();
    const boutique = await within(
      await screen.findByRole('region', { name: 'Liste des créances' }),
    ).findByRole('listitem', { name: 'Boutique Mvog-Mbi' });
    expect(
      within(boutique).getByRole('link', { name: 'Encaisser auprès de Boutique Mvog-Mbi' }),
    ).toHaveAttribute('href', `/encaisser?client=${IDS.customer}`);
    expect(
      within(boutique).getByRole('link', { name: 'Fiche de Boutique Mvog-Mbi' }),
    ).toBeInTheDocument();
  });

  it('Direction : aucune action d’encaissement ; un seul site, pas de choix de site', async () => {
    await rememberRoles(['DIRECTION']);
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: {
        ...response,
        receivables: lines.filter((item) => item.siteId === IDS.site),
      },
    });
    const user = userEvent.setup();
    renderScreen();
    const boutique = await within(
      await screen.findByRole('region', { name: 'Liste des créances' }),
    ).findByRole('listitem', { name: 'Boutique Mvog-Mbi' });
    await user.click(
      within(boutique).getByRole('button', { name: 'Voir les ventes de Boutique Mvog-Mbi' }),
    );
    expect(screen.queryByRole('link', { name: /^Encaisser/ })).toBeNull();
    expect(
      within(boutique).getByRole('link', { name: 'Fiche de Boutique Mvog-Mbi' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Site')).toBeNull();
  });

  it('noms indisponibles : identifiants abrégés, relance ; liste des clients partielle annoncée', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    serve({ ...baseRoutes(), [CUSTOMERS]: BROKEN });
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/^Noms des clients indisponibles/)).toBeInTheDocument();
    // Fusion inconnue tant que les noms ne sont pas lus : le compte absorbé reste à part.
    expect(groupNames()).toEqual([
      'client …08a1',
      'Boutique Mvog-Mbi',
      'client …08a2',
      'client …08a3',
    ]);
    // Responsable commercial : il encaisse.
    expect(
      within(list()).getByRole('link', { name: 'Encaisser auprès de client …08a1' }),
    ).toHaveAttribute('href', `/encaisser?client=${REMOTE}`);
    const pages: Routes = {};
    for (let page = 1; page <= 10; page += 1) {
      pages[page === 1 ? CUSTOMERS : `${CUSTOMERS}&cursor=p${String(page - 1)}`] = {
        customers:
          page === 1
            ? [remoteCustomer(REMOTE, 'Restaurant Chez Mado')]
            : [
                remoteCustomer(
                  `01900000-0000-7000-8000-0000000009${String(page).padStart(2, '0')}`,
                  `Client ${String(page)}`,
                ),
              ],
        next_cursor: `p${String(page)}`,
      };
    }
    serve({ ...baseRoutes(), ...pages });
    await user.click(screen.getByRole('button', { name: 'Relire les noms des clients' }));
    expect(
      await within(list()).findByRole('listitem', { name: 'Restaurant Chez Mado' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Liste des clients partielle : certains noms restent abrégés.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Noms des clients indisponibles/)).toBeNull();
    // Liste partielle : un client absent peut encore exister, son lien reste proposé.
    expect(
      within(list()).getByRole('link', { name: 'Encaisser auprès de client …08a3' }),
    ).toHaveAttribute('href', `/encaisser?client=${UNKNOWN}`);
    expect(readsOf(`${CUSTOMERS}&cursor=p10`)).toBe(0);

    // Liste complète des clients, tous nommés : aucune mention de liste partielle.
    cleanup();
    serve({
      ...baseRoutes(),
      ...pages,
      [RECEIVABLES]: {
        ...response,
        receivables: lines.filter((item) => item.customerId !== UNKNOWN),
      },
    });
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Restaurant Chez Mado' },
    );
    expect(screen.queryByText(/^Liste des clients partielle/)).toBeNull();
  });

  it('par titulaire : titulaires indisponibles relançables, noms de clients indisponibles annoncés aussi', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    serve({ ...baseRoutes(), [CUSTOMERS]: BROKEN, [USERS]: BROKEN });
    const user = userEvent.setup();
    renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Boutique Mvog-Mbi' },
    );
    await user.selectOptions(screen.getByLabelText('Regrouper par'), 'owner');
    expect(await screen.findByText(/^Noms des titulaires indisponibles/)).toBeInTheDocument();
    // Les ventes d'un titulaire nomment leurs clients : leur panne reste annoncée.
    expect(screen.getByText(/^Noms des clients indisponibles/)).toBeInTheDocument();
    expect(groupNames()).toEqual(['…08c1', 'Mes créances']);
    expect(screen.queryByText(/^Liste des clients partielle/)).toBeNull();
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Relire les noms des titulaires' }));
    expect(
      await within(list()).findByRole('listitem', { name: 'Alice Mballa' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Noms des clients indisponibles/)).toBeInTheDocument();
  });

  it('tous les clients sur l’appareil : aucune lecture des noms ; aucune créance : annoncé', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: {
        ...response,
        summary: { ...response.summary, totalXaf: 25_000, overdueXaf: 20_000, count: 2 },
        receivables: lines.filter((item) => item.customerId === IDS.customer),
      },
    });
    const { unmount } = renderScreen();
    await within(await screen.findByRole('region', { name: 'Liste des créances' })).findByRole(
      'listitem',
      { name: 'Boutique Mvog-Mbi' },
    );
    expect(readsOf(CUSTOMERS)).toBe(0);
    expect(readsOf(MERGED)).toBe(0);
    unmount();
    serve({
      ...baseRoutes(),
      [RECEIVABLES]: {
        as_of: '2026-10-10',
        summary: {
          totalXaf: 0,
          overdueXaf: 0,
          count: 0,
          buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 },
        },
        receivables: [],
      },
    });
    renderScreen();
    expect(await screen.findByText('Aucune créance ouverte.')).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Encours' });
    const overdue = tileOf(summary, 'Échu');
    expect(overdue).not.toHaveClass('tile-bad');
    expect(within(overdue).getByText(/^0 F CFA$/)).toBeInTheDocument();
    const total = tileOf(summary, 'Dû par les clients');
    expect(within(total).getByText(/^0 F CFA$/)).toBeInTheDocument();
    expect(within(total).getByText('0 vente')).toBeInTheDocument();
  });

  it('refus sans relance ; panne avec relance', async () => {
    await rememberRoles(['FINANCE']);
    serve({ ...baseRoutes(), [RECEIVABLES]: DENIED });
    const { unmount } = renderScreen();
    expect(await screen.findByText(/^Non accessible avec vos droits\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Relire les créances' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Liste des créances' })).toBeNull();
    unmount();
    serve({ ...baseRoutes(), [RECEIVABLES]: BROKEN });
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText(/^Créances indisponibles/)).toBeInTheDocument();
    serve(baseRoutes());
    await user.click(screen.getByRole('button', { name: 'Relire les créances' }));
    expect(await screen.findByText('Situation au 10 octobre 2026')).toBeInTheDocument();
    expect(screen.queryByText(/^Créances indisponibles/)).toBeNull();
  });

  it('retour sur l’écran et encaissement de l’utilisateur : relecture, la dernière lecture reste affichée', async () => {
    await rememberRoles(['FINANCE']);
    renderScreen();
    await screen.findByText('Situation au 10 octobre 2026');
    expect(readsOf(RECEIVABLES)).toBe(1);
    serve({ ...baseRoutes(), [RECEIVABLES]: NEVER });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByText('Actualisation en cours…')).toBeInTheDocument();
    expect(screen.getByText('Situation au 10 octobre 2026')).toBeInTheDocument();
    expect(readsOf(RECEIVABLES)).toBe(2);
    serve(baseRoutes());
    await act(async () => {
      await getDb().outbox.put({
        command_id: '01900000-0000-7000-8000-0000000009b1',
        device_seq: 1,
        author_user_id: IDS.user,
        command_type: 'sales.payment.record',
        command_version: 1,
        aggregate_type: 'CUSTOMER_PAYMENT',
        aggregate_id: '01900000-0000-7000-8000-0000000009b2',
        payload: { customerId: IDS.customer, methodCode: 'ESPECES', amountXaf: 2000 },
        occurred_at: '2026-10-10T08:00:00.000Z',
        client_created_at: '2026-10-10T08:00:00.000Z',
        captured_offline: false,
        depends_on: [],
        status: 'SYNCED',
        synced_at: '2026-10-10T08:00:05.000Z',
        attempts: 1,
      } as never);
    });
    await vi.waitFor(() => expect(readsOf(RECEIVABLES)).toBe(3));
    expect(await screen.findByText('Situation au 10 octobre 2026')).toBeInTheDocument();
    expect(screen.queryByText('Actualisation en cours…')).toBeNull();
  });

  it('hors ligne : la dernière lecture reste, sans actualisation ; sans lecture, en ligne seulement', async () => {
    await rememberRoles(['FINANCE']);
    const { unmount } = renderScreen();
    await screen.findByText('Situation au 10 octobre 2026');
    act(() => reportSyncOutcome('OFFLINE'));
    expect(
      await screen.findByText('Hors ligne : les créances affichées peuvent être périmées.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Situation au 10 octobre 2026')).toBeInTheDocument();
    expect(screen.queryByText('Actualisation en cours…')).toBeNull();
    unmount();
    renderScreen();
    expect(
      await screen.findByText(
        'Lecture en ligne seulement : reconnectez-vous pour afficher les créances.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Liste des créances' })).toBeNull();
  });
});

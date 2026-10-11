import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { NewSaleScreen } from '../sales/NewSaleScreen.js';
import { CustomerScreen } from './CustomerScreen.js';
import { PortfolioScreen } from './PortfolioScreen.js';
import { portfolioRows } from './portfolio.js';
import type { CustomerData, InteractionData, VisitData } from '../sales/types.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
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
    deviceId: '01900000-0000-7000-8000-0000000000ff',
  }),
}));

const PROSPECT = '01900000-0000-7000-8000-0000000000e1';
const VISIT = '01900000-0000-7000-8000-0000000000e2';
const CALL = '01900000-0000-7000-8000-0000000000e3';

function customer(overrides: Partial<CustomerData>): CustomerData {
  return {
    id: PROSPECT,
    stage: 'PROSPECT',
    display_name: 'Alimentation Essos',
    contact_name: null,
    category_id: null,
    phone_primary: '+237 677 00 00 01',
    zone_id: IDS.zone,
    owner_user_id: IDS.user,
    home_site_id: IDS.site,
    merged_into_id: null,
    credit_allowed: false,
    credit_limit_xaf: null,
    payment_terms_days: 0,
    outstanding_xaf: 0,
    version: 1,
    ...overrides,
  } as CustomerData;
}

function visit(overrides: Partial<VisitData> = {}): VisitData {
  return {
    id: VISIT,
    customer_id: IDS.customer,
    user_id: IDS.user,
    outcome_reason_code_id: null,
    notes: 'Stock d’œufs bas',
    next_action_at: '2026-10-12',
    next_action_note: 'Livrer 10 plateaux',
    flags: [],
    status: 'RECORDED',
    occurred_at: '2026-10-08T10:00:00.000Z',
    ...overrides,
  };
}

function call(overrides: Partial<InteractionData> = {}): InteractionData {
  return {
    id: CALL,
    customer_id: IDS.customer,
    user_id: IDS.user,
    channel: 'APPEL',
    direction: 'SORTANT',
    summary: 'Confirme la visite',
    next_action_at: null,
    next_action_note: null,
    status: 'RECORDED',
    occurred_at: '2026-10-09T15:00:00.000Z',
    ...overrides,
  };
}

/** Vente à crédit saisie sur l'appareil, pas encore envoyée : elle augmente l'encours affiché. */
function pendingCreditSale(): OutboxCommand {
  return {
    command_id: '01900000-0000-7000-8000-0000000000d1',
    device_seq: 1,
    command_type: 'sales.sale.record',
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'SALE',
    aggregate_id: '01900000-0000-7000-8000-0000000000c1',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:58:00.000Z',
    client_created_at: '2026-10-10T08:58:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {
      fromLocationId: IDS.pos,
      customerId: IDS.customer,
      lines: [
        {
          productId: IDS.eggs,
          quantity: 1,
          unitCode: 'PLATEAU',
          quantityBase: 30,
          unitPriceXaf: 100,
        },
      ],
      payments: [],
    },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
  };
}

const asData = (value: object): Record<string, unknown> => ({ ...value });

async function seedActivity(): Promise<void> {
  const db = getDb();
  await db.projections.bulkPut(
    [
      { type: 'VISIT', data: visit() },
      { type: 'INTERACTION', data: call() },
      // Annulée : ne compte pas.
      {
        type: 'INTERACTION',
        data: call({
          id: '01900000-0000-7000-8000-0000000000e4',
          status: 'CANCELLED',
          summary: 'Erreur de saisie',
        }),
      },
    ].map(({ type, data }) => ({
      key: `crm_activity:${type}:${data.id}`,
      dataset: 'crm_activity',
      entity_type: type,
      entity_id: data.id,
      scope_type: 'USER',
      scope_id: IDS.user,
      row_version: 1,
      seq: 1,
      data: asData(data),
    })),
  );
  await db.projections.put({
    key: `customers:CUSTOMER:${PROSPECT}`,
    dataset: 'customers',
    entity_type: 'CUSTOMER',
    entity_id: PROSPECT,
    scope_type: 'USER',
    scope_id: IDS.user,
    row_version: 1,
    seq: 1,
    data: asData(customer({})),
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/clients" element={<PortfolioScreen />} />
        <Route path="/clients/:customerId" element={<CustomerScreen />} />
        <Route path="/ventes/nouvelle" element={<NewSaleScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Portefeuille (ECR-CRM-01, logique)', () => {
  const refs = {
    customers: [
      customer({ id: 'a', display_name: 'Zeta', stage: 'CUSTOMER' }),
      customer({ id: 'b', display_name: 'Alpha', stage: 'PROSPECT', phone_primary: null }),
      customer({ id: 'c', display_name: 'Beta', stage: 'CUSTOMER' }),
      customer({ id: 'd', display_name: 'Fusionné', stage: 'MERGED' }),
    ],
    visits: [
      visit({
        id: 'v1',
        customer_id: 'a',
        next_action_at: '2026-10-15',
        next_action_note: 'Relancer',
      }),
      // La plus récente sans prochaine action ne masque pas une action prévue plus ancienne.
      visit({
        id: 'v2',
        customer_id: 'c',
        next_action_at: '2026-10-11',
        occurred_at: '2026-10-01T08:00:00.000Z',
      }),
    ],
    interactions: [call({ id: 'i1', customer_id: 'c', occurred_at: '2026-10-09T08:00:00.000Z' })],
    outbox: [],
    customersPulledAt: undefined,
    customerAlias: new Map<string, string>(),
  };

  it('écarte les comptes fusionnés, met en tête la prochaine action la plus proche, puis trie par nom', () => {
    const rows = portfolioRows(refs, { stage: 'ALL', query: '' });
    expect(rows.map((row) => row.customer.display_name)).toEqual(['Beta', 'Zeta', 'Alpha']);
    expect(rows[0]).toMatchObject({
      nextActionAt: '2026-10-11',
      lastActivityAt: '2026-10-09T08:00:00.000Z',
    });
  });

  it('filtre par stade, par nom et par chiffres du téléphone', () => {
    expect(
      portfolioRows(refs, { stage: 'PROSPECT', query: '' }).map((row) => row.customer.id),
    ).toEqual(['b']);
    expect(
      portfolioRows(refs, { stage: 'ALL', query: 'bet' }).map((row) => row.customer.id),
    ).toEqual(['c']);
    expect(
      portfolioRows(refs, { stage: 'ALL', query: '677 00' }).map((row) => row.customer.id),
    ).toEqual(['c', 'a']);
    // Moins de trois chiffres : pas de recherche par téléphone.
    expect(portfolioRows(refs, { stage: 'ALL', query: '67' })).toEqual([]);
  });
});

describe('Portefeuille et fiche compte (ECR-CRM-01, ECR-CRM-03)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
    await seedActivity();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
  });

  it('portefeuille hors ligne : prochaine action en tête, fiche avec encours corrigé et activité', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await getDb().outbox.add(pendingCreditSale());
    const user = userEvent.setup();
    renderAt('/clients');

    const first = await screen.findByRole('link', { name: /Boutique Mvog-Mbi/ });
    // Le nom accessible porte la prochaine action et l'encours corrigé (12 000 + 3 000 en attente).
    expect(first).toHaveAccessibleName(/À faire le lundi 12 octobre Livrer 10 plateaux/);
    expect(first).toHaveAccessibleName(/Encours 15\s000\sF\sCFA/);
    const rows = () => within(screen.getByRole('list')).getAllByRole('link');
    expect(rows()).toHaveLength(2);

    await user.selectOptions(screen.getByLabelText('Stade'), 'PROSPECT');
    expect(rows()).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText('Stade'), 'ALL');

    await user.click(screen.getByRole('link', { name: /Boutique Mvog-Mbi/ }));
    expect(await screen.findByRole('heading', { name: 'Boutique Mvog-Mbi' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+237 699 11 22 33' })).toHaveAttribute(
      'href',
      'tel:+237699112233',
    );
    // 12 000 projetés + 3 000 (30 œufs à 100) de la vente à crédit en attente d'envoi.
    expect(screen.getByText('Encours').nextElementSibling).toHaveTextContent(/15\s000\sF\sCFA/);
    expect(screen.getByText(/Plafond 50\s000\sF\sCFA/)).toBeInTheDocument();
    expect(screen.getByText('Confirme la visite')).toBeInTheDocument();
    expect(screen.getByText('Stock d’œufs bas')).toBeInTheDocument();
    expect(screen.queryByText('Erreur de saisie')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Encaisser' })).toHaveAttribute(
      'href',
      `/encaisser?client=${IDS.customer}`,
    );

    // « + Vente » ouvre la vente, client déjà choisi.
    await user.click(screen.getByRole('link', { name: '+ Vente' }));
    expect(await screen.findByText('Boutique Mvog-Mbi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Changer' })).toBeInTheDocument();
  });

  it('compte conservé après fusion : activité et opérations de l’absorbé rattachées ; vente refusée sans « reste »', async () => {
    const ABSORBED = '01900000-0000-7000-8000-0000000000e9';
    const db = getDb();
    await db.projections.bulkPut([
      {
        key: `customers:CUSTOMER:${ABSORBED}`,
        dataset: 'customers',
        entity_type: 'CUSTOMER',
        entity_id: ABSORBED,
        scope_type: 'USER',
        scope_id: IDS.user,
        row_version: 1,
        seq: 1,
        data: asData(
          customer({
            id: ABSORBED,
            stage: 'MERGED',
            display_name: 'Boutique Mvog-Mbi (doublon)',
            merged_into_id: IDS.customer,
          }),
        ),
      },
      {
        key: 'crm_activity:VISIT:v-absorbe',
        dataset: 'crm_activity',
        entity_type: 'VISIT',
        entity_id: 'v-absorbe',
        scope_type: 'USER',
        scope_id: IDS.user,
        row_version: 1,
        seq: 1,
        data: asData(
          visit({ id: 'v-absorbe', customer_id: ABSORBED, notes: 'Visite sur le doublon' }),
        ),
      },
    ]);
    const onAbsorbed = pendingCreditSale();
    await db.outbox.bulkPut([
      { ...onAbsorbed, payload: { ...(onAbsorbed.payload as object), customerId: ABSORBED } },
      {
        ...pendingCreditSale(),
        command_id: '01900000-0000-7000-8000-0000000000d7',
        device_seq: 2,
        aggregate_id: '01900000-0000-7000-8000-0000000000c7',
        status: 'REJECTED',
        last_error: { code: 'CREDIT_LIMIT', message_fr: 'Plafond dépassé.' },
      },
    ]);
    renderAt(`/clients/${IDS.customer}`);
    expect(await screen.findByText('Visite sur le doublon')).toBeInTheDocument();
    // 12 000 servis + 3 000 de la vente à crédit en attente sur le compte absorbé.
    expect(screen.getByText('Encours').nextElementSibling).toHaveTextContent(/15\s000\sF\sCFA/);
    const sales = within(screen.getByRole('region', { name: 'Ventes des 7 derniers jours' }));
    expect(sales.getByText('Refusée')).toBeInTheDocument();
    expect(sales.getAllByText(/Reste/)).toHaveLength(1);
  });

  it('les raccourcis suivent les rôles mémorisés : pas de commande pour le vendeur de PDV', async () => {
    await getDb().navigation.put({
      user_id: IDS.user,
      roles: ['VENDEUR_PDV'],
      sections: [],
      saved_at: '2026-10-10T08:00:00.000Z',
    });
    renderAt(`/clients/${IDS.customer}`);
    expect(await screen.findByRole('link', { name: '+ Vente' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ Commande' })).not.toBeInTheDocument();
  });

  it('compte hors du téléphone : message explicite et retour au portefeuille', async () => {
    renderAt('/clients/01900000-0000-7000-8000-0000000000ee');
    expect(await screen.findByText(/n’est pas sur ce téléphone/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Mon portefeuille' })).toHaveAttribute(
      'href',
      '/clients',
    );
  });
});

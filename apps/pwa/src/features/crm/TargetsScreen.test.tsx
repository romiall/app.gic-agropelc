import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { TargetsScreen } from './TargetsScreen.js';
import { checkTarget, currentMonth, targetPayload, type TargetView } from './targets.js';

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

const SITE_TARGET: TargetView = {
  id: 't-site',
  targetType: 'SITE',
  userId: null,
  teamId: null,
  siteId: IDS.site,
  metric: 'CA',
  productId: null,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  targetValue: 5_000_000,
  status: 'ACTIVE',
};

const TEAM = '01900000-0000-7000-8000-0000000009a1';
const MEMBER = '01900000-0000-7000-8000-0000000009a2';

async function rememberRoles(roles: readonly string[]) {
  await getDb().navigation.put({
    user_id: IDS.user,
    roles: [...roles],
    sections: [],
    saved_at: '2026-10-10T08:00:00.000Z',
  });
}

function projection(dataset: string, type: string, id: string, data: object) {
  return {
    key: `${dataset}:${type}:${id}`,
    dataset,
    entity_type: type,
    entity_id: id,
    scope_type: 'GLOBAL',
    scope_id: null,
    row_version: 1,
    seq: 1,
    data: { id, ...data } as Record<string, unknown>,
  };
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <TargetsScreen />
    </MemoryRouter>,
  );
}

describe('Gestion des objectifs (ECR-CRM-07)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
    await seedSalesFixtures(db);
    vi.mocked(authorizedRequest).mockResolvedValue({
      ok: true,
      data: { targets: [SITE_TARGET] },
    } as never);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    await getDb().projections.clear();
    await getDb().outbox.clear();
    await getDb().navigation.clear();
  });

  it('objectif de site : chevauchement refusé, quantité d’un produit définie, objectif annulé', async () => {
    await rememberRoles(['DIRECTION']);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', {
      name: /PDV Yaoundé · Chiffre d’affaires · du 1 octobre 2026 au 31 octobre 2026/,
    });
    expect(card).toHaveTextContent(/5\s000\s000\sF\sCFA/);
    expect(screen.getByText(/seuls les objectifs par site se définissent ici/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nouvel objectif' }));
    await user.selectOptions(screen.getByLabelText('Site'), IDS.site);
    await user.type(screen.getByLabelText('Chiffre d’affaires visé (F)'), '6000000');
    const overlap = screen.getByText(/couvre déjà cette période/);
    expect(screen.getByLabelText('Du')).toHaveAttribute('aria-describedby', overlap.id);
    expect(screen.getByRole('button', { name: 'Définir l’objectif' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Mesure'), 'QTE_PRODUIT');
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    // La quantité visée se saisit dans l'unité de base du produit (celle du réalisé).
    await user.type(
      screen.getByLabelText('Quantité visée (en U, unité de base du produit)'),
      '12000',
    );
    await user.click(screen.getByRole('button', { name: 'Définir l’objectif' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(1));
    const [created] = await getDb().outbox.toArray();
    await getDb().outbox.update(created?.command_id as string, {
      status: 'SYNCED',
      synced_at: '2026-10-10T09:00:05.000Z',
    });

    const fresh = await screen.findByRole('listitem', { name: /PDV Yaoundé · Chiffre d’affaires/ });
    const cancel = within(fresh).getByRole('button', { name: 'Annuler l’objectif' });
    await waitFor(() => expect(cancel).toBeEnabled());
    await user.click(cancel);
    await user.type(within(fresh).getByLabelText('Commentaire (facultatif)'), 'Objectif revu');
    await user.click(within(fresh).getByRole('button', { name: 'Confirmer l’annulation' }));
    await waitFor(async () => expect(await getDb().outbox.count()).toBe(2));

    const [set, cancelled] = await getDb().outbox.orderBy('device_seq').toArray();
    expect(set).toMatchObject({
      command_type: 'crm.target.set',
      aggregate_type: 'SALES_TARGET',
      payload: {
        targetType: 'SITE',
        siteId: IDS.site,
        metric: 'QTE_PRODUIT',
        productId: IDS.eggs,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        targetValue: 12000,
      },
    });
    expect(cancelled).toMatchObject({
      command_type: 'crm.target.cancel',
      aggregate_id: 't-site',
      payload: { comment: 'Objectif revu' },
    });
  });

  it('responsable commercial : pas d’objectif par site ; équipes dirigées et leurs membres seulement', async () => {
    await rememberRoles(['RESP_COMMERCIAL']);
    renderScreen();
    // Commerciaux et équipes pas encore publiés (S-28) : rien à définir, et pas de faux « par site ».
    expect(await screen.findByText(/aucun objectif ne peut être défini ici/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nouvel objectif' })).not.toBeInTheDocument();
    cleanup();

    // Une équipe dirigée et un membre en cours : cibles équipe et commercial, jamais le site.
    await getDb().projections.bulkPut([
      projection('team', 'TEAM', TEAM, {
        code: 'EQ-YDE',
        name: 'Équipe Yaoundé',
        manager_user_id: IDS.user,
        is_active: true,
      }),
      projection('user', 'USER', MEMBER, { full_name: 'Awa Commerciale', status: 'ACTIVE' }),
      projection('team_membership', 'TEAM_MEMBERSHIP', 'm1', {
        team_id: TEAM,
        user_id: MEMBER,
        valid_from: '2026-01-01',
        valid_to: null,
      }),
    ]);
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Nouvel objectif' }));
    const kinds = within(screen.getByLabelText('Objectif de'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(kinds).toEqual(['Un commercial', 'Une équipe']);
    // Les objectifs de l'équipe et de son membre sont relus un à un.
    await waitFor(() =>
      expect(authorizedRequest).toHaveBeenCalledWith(
        expect.anything(),
        `/api/v1/targets?user_id=${MEMBER}`,
        { method: 'GET' },
      ),
    );
    expect(authorizedRequest).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/targets?team_id=${TEAM}`,
      { method: 'GET' },
    );
  });

  it('lecture en échec : annoncée et relue par « Réessayer »', async () => {
    await rememberRoles(['DIRECTION']);
    vi.mocked(authorizedRequest).mockResolvedValueOnce({
      ok: false,
      reason: 'HTTP_ERROR',
      status: 503,
      body: null,
    } as never);
    renderScreen();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Réessayer' }));
    expect(
      await screen.findByRole('listitem', { name: /PDV Yaoundé · Chiffre d’affaires/ }),
    ).toBeInTheDocument();
  });

  it('hors ligne : écran en ligne seulement, aucune lecture', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent(/en ligne seulement/);
    expect(authorizedRequest).not.toHaveBeenCalled();
  });
});

describe('Objectifs : règles', () => {
  it('mois en cours ; valeur entière sauf quantité ; une seule cible dans la charge utile', () => {
    expect(currentMonth('2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    const form = {
      targetType: 'USER' as const,
      targetId: 'u1',
      metric: 'VISITES' as const,
      productId: '',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      valueText: '12,5',
    };
    expect(checkTarget(form, [])).toEqual(['VALUE_INVALID']);
    expect(checkTarget({ ...form, metric: 'QTE_PRODUIT', productId: 'p' }, [])).toEqual([]);
    expect(targetPayload({ ...form, valueText: '40' })).toEqual({
      targetType: 'USER',
      userId: 'u1',
      metric: 'VISITES',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetValue: 40,
    });
  });
});

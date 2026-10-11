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
  });

  it('objectif de site : chevauchement refusé, quantité d’un produit définie, objectif annulé', async () => {
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('listitem', { name: /PDV Yaoundé · Chiffre d’affaires/ });
    expect(card).toHaveTextContent(/5\s000\s000\sF\sCFA/);
    expect(screen.getByText(/seuls les objectifs par site se définissent ici/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nouvel objectif' }));
    await user.selectOptions(screen.getByLabelText('Site'), IDS.site);
    await user.type(screen.getByLabelText('Chiffre d’affaires visé (F)'), '6000000');
    expect(screen.getByText(/couvre déjà cette période/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Définir l’objectif' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Mesure'), 'QTE_PRODUIT');
    await user.selectOptions(screen.getByLabelText('Produit'), IDS.eggs);
    await user.type(screen.getByLabelText('Quantité visée'), '12000');
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
